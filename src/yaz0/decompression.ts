import {
  createReadStream,
  createWriteStream,
  existsSync,
  PathLike,
  promises as fsPromises,
  ReadStream,
  WriteStream,
} from 'fs'
import {tmpdir} from 'os'
import {dirname, join, sep} from 'path'
import {Transform, TransformCallback} from 'stream'
import {URL} from 'url'
import {
  CHUNKS_PER_GROUP,
  CHUNK_DISTANCE_OFFSET,
  CHUNK_DISTANCE_WIDTH,
  DEFAULT_DECOMPRESSED_BUFFER_LIMIT,
  GROUP_HEADER_LENGTH,
  HEADER_LENGTH,
  LONG_CHUNK_LENGTH_OFFSET,
  MAGIC_STRING,
  MAX_CHUNK_INPUT_LENGTH,
  MAX_CHUNK_DISTANCE,
  MAX_GROUP_OUTPUT_LENGTH,
  MIN_GROUP_INPUT_LENGTH,
  MIN_BACKREF_CHUNK_INPUT_LENGTH,
  SHORT_CHUNK_LENGTH_OFFSET,
} from './constants'

const {copyFile, mkdtemp, realpath, rename, rmdir, unlink} = fsPromises

interface FileSystemError extends Error {
  code: string
  syscall: string
}

/**
 * Decompresses a stream that has been compressed via the Yaz0 algorithm.
 *
 * @returns A Transform stream that accepts compressed data and outputs
 * decompressed data.
 *
 * @example
 * ```js
 * createReadStream('ActorInfo.product.sbyml')
 *   .pipe(decompress())
 *   .pipe(createWriteStream('ActorInfo.product.byml'))
 * ```
 */
export function decompress(): Transform

/**
 * Decompresses a stream that has been compressed via the Yaz0 algorithm.
 *
 * @param options Options for configuring the decompression.
 * @param options.decompressedBufferLimit The target length of the buffer used
 * for decompressed data.
 *
 * @returns A Transform stream that accepts compressed data and outputs
 * decompressed data.
 *
 * @example
 * ```js
 * createReadStream('ActorInfo.product.sbyml')
 *   .pipe(decompress({decompressedBufferLimit: 50 * 1024 * 1024}))
 *   .pipe(createWriteStream('ActorInfo.product.byml'))
 * ```
 */
export function decompress(options: {
  decompressedBufferLimit?: number
}): Transform

export function decompress(options?: {
  decompressedBufferLimit?: number
}): Transform {
  const decompressedBufferLimit =
    options == null || options.decompressedBufferLimit == null
      ? DEFAULT_DECOMPRESSED_BUFFER_LIMIT
      : options.decompressedBufferLimit

  let input = Buffer.alloc(0)
  let pos = 0
  let isHeaderRead = false
  let decompressedRemaining: number
  let output: Buffer
  let outputPos = 0

  /** Reads the header from the input buffer. */
  function readHeader() {
    // Ensure the header begins with the ASCII string `Yaz0`. Otherwise, the
    // input is invalid.
    if (
      input.slice(0, MAGIC_STRING.length).toString('ascii') !== MAGIC_STRING
    ) {
      throw getInvalidInputError(
        `The magic string ${MAGIC_STRING} was not found.`,
      )
    }

    // The next four bytes represent the length of the data after is has been
    // decompressed.
    decompressedRemaining = input.readUInt32BE(MAGIC_STRING.length)

    // The next eight bytes are reserved and can be ignored for now.
    pos = HEADER_LENGTH

    // Allocate enough memory required to store the rest of the decompressed
    // data from the current input buffer at its max potential length.
    output = Buffer.alloc(getMaxDecompressedRemaining())

    isHeaderRead = true
  }

  /** Reads a single group from the input buffer. */
  function readGroup() {
    // If we've reached the end of the input buffer, return early.
    if (pos === input.byteLength) {
      return
    }

    let groupHeader = input[pos++]
    let remainingChunks = CHUNKS_PER_GROUP

    // Chunk groups are read until the end of input, and the final chunk group
    // can end early.
    while (remainingChunks > 0 && pos < input.byteLength) {
      // Each bit of the group header represents the type of its corresponding
      // chunk. We shift the group header to the left after each chunk so we
      // only need to check the MSB each time.
      if (groupHeader & 0x80) {
        // A set bit means the next chunk is a single byte that is not
        // compressed and can be returned as-is.
        output[outputPos++] = input[pos++]
        decompressedRemaining--
      } else {
        // A clear bit means the next chunk is a reference to a previous
        // sequence of data in the decompressed output. If we have not received
        // enough data to read the next chunk, the input is invalid.
        if (input.byteLength - pos < MIN_BACKREF_CHUNK_INPUT_LENGTH) {
          throw getInvalidInputError('The input ended prematurely.')
        }

        // The chunk is either long or short. If the chunk is long and we have
        // not received enough data to read the chunk, the input is invalid.
        const chunk = input.readUInt16BE(pos)
        pos += MIN_BACKREF_CHUNK_INPUT_LENGTH
        const isLongChunk = (chunk & 0xf000) === 0
        if (
          isLongChunk &&
          input.byteLength - pos <
            MAX_CHUNK_INPUT_LENGTH - MIN_BACKREF_CHUNK_INPUT_LENGTH
        ) {
          throw getInvalidInputError('The input ended prematurely.')
        }

        // Each chunk represents a backreference to a sequnce of data in the
        // output we have decompressed so far. The distance from the end of the
        // output and length determines the backreferenced data.
        const distance = (chunk & 0x0fff) + CHUNK_DISTANCE_OFFSET
        const length = isLongChunk
          ? input[pos++] + LONG_CHUNK_LENGTH_OFFSET
          : (chunk >> CHUNK_DISTANCE_WIDTH) + SHORT_CHUNK_LENGTH_OFFSET

        // If the distance is too far from the end of the output, the input is
        // invalid.
        const start = outputPos - distance
        const end = start + length
        if (start < 0) {
          throw getInvalidInputError(
            'Tried to reference data further back than the maximum distance.',
          )
        }

        // Since a backreference can reference itself in whole or part, we need
        // to read each byte from the output individually.
        for (let i = start; i < end; i++) {
          output[outputPos++] = output[i]
          decompressedRemaining--
        }
      }

      groupHeader <<= 1
      remainingChunks--
    }
  }

  /**
   * Calculates the amount of memory required to store the rest of the
   * decompressed data from the current input buffer at its max potential
   * length.
   */
  function getMaxDecompressedRemaining(): number {
    return Math.min(
      decompressedRemaining,
      Math.max(
        decompressedBufferLimit,
        Math.ceil((input.byteLength - pos) / MIN_GROUP_INPUT_LENGTH) *
          MAX_GROUP_OUTPUT_LENGTH,
      ),
    )
  }

  /**
   * Expands the output buffer to store enough memory to decompress the
   * remainder of the input buffer or the entire stream, whichever is smaller.
   */
  function expandOutputBuffer() {
    const outputAvailable = output.byteLength - outputPos

    // If we have enough room to store the rest of the decompressed data, there
    // is no need to expand the output buffer.
    if (outputAvailable >= decompressedRemaining) {
      return
    }

    // Calculate the amount of memory required to store the rest of the
    // decompressed data from the current input buffer at its max potential
    // length.
    const maxDecompressedRemaining = getMaxDecompressedRemaining()

    // If we have enough room to store the rest of the decompressed data, there
    // is no need to expand the output buffer.
    if (outputAvailable >= maxDecompressedRemaining) {
      return
    }

    // The new output position must accomdate for the max chunk distance for
    // backreferences.
    const newOutputPos = Math.min(outputPos, MAX_CHUNK_DISTANCE)

    const newOutput = Buffer.alloc(newOutputPos + maxDecompressedRemaining)

    output.copy(newOutput, 0, outputPos - newOutputPos, outputPos)
    output = newOutput
    outputPos = newOutputPos
  }

  /** Returns an error indicating that the input is invalid. */
  function getInvalidInputError(message?: string): Error {
    return new Error(
      'Invalid input was encountered while decompressing.' +
        (message == null ? '' : ' ' + message),
    )
  }

  return new Transform({
    transform(
      chunk: Buffer,
      encoding: BufferEncoding,
      callback: TransformCallback,
    ) {
      try {
        // If we're in the middle of reading the buffer, append the chunk to the
        // buffer. Otherwise, the chunk is our new buffer.
        if (pos < input.byteLength) {
          const newInput = Buffer.alloc(
            input.byteLength - pos + chunk.byteLength,
          )
          input.copy(newInput, 0, pos)
          chunk.copy(newInput, input.byteLength - pos)
          input = newInput
          pos = 0
        } else {
          input = chunk
          pos = 0
        }

        if (!isHeaderRead) {
          // If we have not received enough data to read the entire header,
          // defer reading the header.
          if (input.byteLength - pos < HEADER_LENGTH) {
            callback()
            return
          }

          readHeader()
        }

        expandOutputBuffer()
        const prevOutputPos = outputPos

        // Read groups while we have enough data to read a group at its max
        // potential length. This check is performed in `transform` but not in
        // `flush`.
        while (
          input.byteLength - pos >=
          GROUP_HEADER_LENGTH + MAX_CHUNK_INPUT_LENGTH * CHUNKS_PER_GROUP
        ) {
          const prevDecompressedRemaining = decompressedRemaining
          readGroup()
          if (decompressedRemaining === prevDecompressedRemaining) {
            break
          }
        }

        const result =
          outputPos > prevOutputPos
            ? output.slice(prevOutputPos, outputPos)
            : undefined

        callback(null, result)
      } catch (err) {
        callback(err)
      }
    },
    flush(callback: TransformCallback) {
      try {
        if (!isHeaderRead) {
          // If we have not received enough data to read the entire header, the
          // input is invalid.
          if (input.byteLength - pos < HEADER_LENGTH) {
            throw getInvalidInputError()
          }

          readHeader()
        }

        expandOutputBuffer()
        const prevOutputPos = outputPos

        // Read groups until the end of the stream.
        while (decompressedRemaining > 0) {
          readGroup()
        }

        // Ensure that the length of decompressed data matches the value in the
        // header. Otherwise, the input is invalid.
        if (decompressedRemaining !== 0) {
          throw getInvalidInputError()
        }

        const result =
          outputPos > prevOutputPos
            ? output.slice(prevOutputPos, outputPos)
            : undefined

        callback(null, result)
      } catch (err) {
        callback(err)
      }
    },
  })
}

/**
 * Asynchronously decompresses the contents of a Buffer.
 *
 * @param buffer The buffer to decompress.
 *
 * @returns A Promise that resolves with a Buffer containing the decompressed
 * data.
 *
 * @example
 * ```js
 * const compressedBuffer = await readFile('ActorInfo.product.sbyml')
 * const decompressedBuffer = await decompressBuffer(compressedBuffer)
 * await writeFile('ActorInfo.product.byml', decompressedBuffer)
 * ```
 */
export async function decompressBuffer(buffer: Buffer): Promise<Buffer>

/**
 * Asynchronously decompresses the contents of a Buffer.
 *
 * @param buffer The buffer to decompress.
 * @param encoding The encoding of the data.
 *
 * @returns A Promise that resolves with a string containing the decompressed
 * data.
 *
 * @example
 * ```js
 * const compressedBuffer = await readFile('ActorInfo.product.sbyml')
 * const decompressedText = await decompressBuffer(compressedBuffer, 'utf8')
 * await writeFile('ActorInfo.product.byml', decompressedText)
 * ```
 */
export async function decompressBuffer(
  buffer: Buffer,
  encoding: BufferEncoding,
): Promise<string>

export async function decompressBuffer(
  buffer: Buffer,
  encoding?: BufferEncoding,
): Promise<Buffer | string> {
  return new Promise((resolve, reject) => {
    try {
      const buffers: Buffer[] = []
      decompress()
        .on('data', (data: Buffer) => {
          buffers.push(data)
        })
        .on('end', () => {
          const buffer = Buffer.concat(buffers)
          resolve(encoding == null ? buffer : buffer.toString(encoding))
        })
        .on('error', reject)
        .end(buffer)
    } catch (err) {
      reject(err)
    }
  })
}

/**
 * Asynchronously decompresses the entire contents of a file.
 *
 * @param path The path to the compressed file.
 *
 * @returns A Promise that resolves with a Buffer containing the decompressed
 * contents of the file.
 *
 * @example
 * ```js
 * const buffer = await decompressFile('ActorInfo.product.sbyml')
 * await writeFile('ActorInfo.product.byml', buffer)
 * ```
 */
export async function decompressFile(path: PathLike): Promise<Buffer>

/**
 * Asynchronously decompresses the entire contents of a file.
 *
 * @param path The path to the compressed file.
 * @param options An object specifying the encoding.
 * @param options.encoding The encoding of the file.
 *
 * @returns A Promise that resolves with a Buffer containing the decompressed
 * contents of the file.
 *
 * @example
 * ```js
 * const buffer = await decompressFile('ActorInfo.product.sbyml', {encoding: null})
 * await writeFile('ActorInfo.product.byml', buffer)
 * ```
 *
 * @ignore This tag prevents this overload from being rendered in the
 * documentation.
 */
export async function decompressFile(
  path: PathLike,
  options: {encoding?: null},
): Promise<Buffer>

/**
 * Asynchronously decompresses the entire contents of a file.
 *
 * @param path The path to the compressed file.
 * @param options An object specifying the encoding.
 * @param options.encoding The encoding of the file.
 *
 * @returns A Promise that resolves with a string containing the decompressed
 * contents of the file.
 *
 * @example
 * ```js
 * const text = await decompressFile('ActorInfo.product.sbyml', {encoding: 'utf8'})
 * await writeFile('ActorInfo.product.byml', text)
 * ```
 */
export async function decompressFile(
  path: PathLike,
  options: {encoding: BufferEncoding},
): Promise<string>

/**
 * Asynchronously decompresses the entire contents of a file.
 *
 * @param source The path to the compressed file.
 * @param destination The path to write the decompressed data to. If the file
 * exists, it will be overwritten. If it is the same path as `source`, then it
 * will overwrite the file at `source`.
 *
 * @returns A Promise that resolves when the compressed file has been
 * decompressed and written.
 *
 * @example
 * ```js
 * await decompressFile('ActorInfo.product.sbyml', 'ActorInfo.product.byml')
 * ```
 */
export async function decompressFile(
  source: PathLike,
  destination: PathLike,
): Promise<void>

export async function decompressFile(
  source: PathLike,
  destinationOrOptions?: {encoding?: BufferEncoding | null} | PathLike,
): Promise<Buffer | string | void> {
  // Check if destinationOrOptions is a path. If so, decompress the file and
  // then write it to destinationOrOptions.
  if (
    typeof destinationOrOptions === 'string' ||
    Buffer.isBuffer(destinationOrOptions) ||
    destinationOrOptions instanceof URL
  ) {
    const destination = destinationOrOptions

    // If source and destination point to the same file, create a temporary path
    // to store the decompressed data.
    const isSamePath =
      existsSync(destination) &&
      (await realpath(source)) === (await realpath(destination))
    const tempPath = isSamePath
      ? join(await mkdtemp(tmpdir() + sep), 'tmp')
      : undefined
    const outputPath = tempPath || destination

    try {
      await new Promise((resolve, reject) => {
        // Create a read and write stream and pipe them with a decompression
        // stream in between.
        let writeStream: WriteStream | undefined
        let readStream: ReadStream | undefined
        try {
          writeStream = createWriteStream(outputPath)
          readStream = createReadStream(source)
          readStream
            .pipe(decompress())
            .pipe(writeStream)
            .on('finish', resolve)
            .on('error', reject)
        } catch (err) {
          // Clean up both streams if an error occurs in either.
          writeStream?.destroy()
          readStream?.destroy()
          reject(err)
        }
      })

      // If source and destination point to the same file, overwrite the
      // compressed file with the decompressed file.
      if (tempPath != null) {
        await rename(tempPath, source)
      }
    } catch (err) {
      // If the temp file exists on a separate disk than the the compressed
      // file, then calling rename will throw an EXDEV error. In this case, copy
      // the file instead. The temp file will be removed in the finally clause.
      if (
        err instanceof Error &&
        tempPath != null &&
        (err as FileSystemError).syscall === 'rename' &&
        (err as FileSystemError).code === 'EXDEV'
      ) {
        await copyFile(tempPath, source)
      }
    } finally {
      // Clean up any temporary paths.
      if (tempPath != null && existsSync(tempPath)) {
        const parentPath = dirname(tempPath)
        await unlink(tempPath)
        await rmdir(parentPath)
      }
    }
  } else {
    // If destinationOrOptions is null or undefined, return the decompressed
    // contents of the file. If the encoding option is a string return a decoded
    // string; otherwise, return a Buffer.
    const encoding = destinationOrOptions?.encoding

    return new Promise((resolve, reject) => {
      try {
        // Create a read stream and pipe it to a decompression stream. Store
        // each data chunk into an array and concatenate them at the end.
        const buffers: Buffer[] = []
        createReadStream(source)
          .pipe(decompress())
          .on('data', (data: Buffer) => {
            buffers.push(data)
          })
          .on('end', () => {
            const buffer = Buffer.concat(buffers)

            // If an encoding was provided, return a decoded string; otherwise,
            // return a Buffer.
            resolve(encoding == null ? buffer : buffer.toString(encoding))
          })
          .on('error', reject)
      } catch (err) {
        reject(err)
      }
    })
  }
}
