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
  HEADER_LENGTH,
  LONG_CHUNK_LENGTH_OFFSET,
  MAGIC_STRING,
  MAX_COMPRESSED_CHUNK_LENGTH,
  MAX_COMPRESSED_GROUP_LENGTH,
  MAX_CHUNK_DISTANCE,
  MAX_DECOMPRESSED_GROUP_LENGTH,
  MIN_COMPRESSED_CHUNK_LENGTH,
  SHORT_CHUNK_LENGTH_OFFSET,
} from './constants'

const {copyFile, mkdtemp, realpath, rename, rmdir, unlink} = fsPromises

/** The maximum length of the output buffer in bytes */
const MAX_OUTPUT_BUFFER_LENGTH = 65536

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
export function decompress(): Transform {
  let input: Buffer
  let inputPos = 0
  let isHeaderRead = false
  let decompressedRemaining: number
  let output: Buffer
  let outputPos = 0
  let pendingOutputPos = 0

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
    inputPos = HEADER_LENGTH

    // Allocate enough memory required to store the rest of the decompressed
    // data from the current input buffer at its max potential length.
    output = Buffer.alloc(
      Math.min(MAX_OUTPUT_BUFFER_LENGTH, decompressedRemaining),
    )

    isHeaderRead = true
  }

  /** Reads a single group from the input buffer, decompresses it, and writes
   * the decompressed data. */
  function decompressGroup() {
    // If we've reached the end of the input buffer, return early.
    if (inputPos === input.byteLength) {
      return
    }

    // If there is not enough room in the output buffer to store either a
    // decompressed group at its max potential length or the remainder of the
    // decompressed data, flush the output buffer to ensure there is enough
    // room.
    if (
      output.byteLength - outputPos <
      Math.min(MAX_DECOMPRESSED_GROUP_LENGTH, decompressedRemaining)
    ) {
      flushOutputBuffer()
    }

    // Each group starts with a header and number of compressed chunks.
    let groupHeader = input[inputPos++]
    let remainingChunks = CHUNKS_PER_GROUP

    // Chunk groups are read until the end of input, and the final chunk group
    // can end early.
    while (remainingChunks > 0 && inputPos < input.byteLength) {
      // Each bit of the group header represents the type of its corresponding
      // chunk. We shift the group header to the left after each chunk so we
      // only need to check the MSB each time.
      if (groupHeader & 0x80) {
        // A set bit means the next chunk is a single byte that is not
        // compressed and can be returned as-is.
        output[outputPos++] = input[inputPos++]
        decompressedRemaining--
      } else {
        // A clear bit means the next chunk is a reference to a previous
        // sequence of data in the decompressed output. If we have not received
        // enough data to read the next chunk, the input is invalid.
        if (input.byteLength - inputPos < MIN_COMPRESSED_CHUNK_LENGTH) {
          throw getInvalidInputError('The input ended prematurely.')
        }

        // The chunk is either long or short. If the chunk is long and we have
        // not received enough data to read the chunk, the input is invalid.
        const chunk = input.readUInt16BE(inputPos)
        inputPos += MIN_COMPRESSED_CHUNK_LENGTH
        const isLongChunk = (chunk & 0xf000) === 0
        if (
          isLongChunk &&
          input.byteLength - inputPos <
            MAX_COMPRESSED_CHUNK_LENGTH - MIN_COMPRESSED_CHUNK_LENGTH
        ) {
          throw getInvalidInputError('The input ended prematurely.')
        }

        // Each chunk represents a backreference to a sequnce of data in the
        // output we have decompressed so far. The distance from the end of the
        // output and length determines the backreferenced data.
        const distance = (chunk & 0x0fff) + CHUNK_DISTANCE_OFFSET
        const length = isLongChunk
          ? input[inputPos++] + LONG_CHUNK_LENGTH_OFFSET
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

      // We shift the group header so that we only need to check the first bit
      // position.
      groupHeader <<= 1
      remainingChunks--
    }
  }

  /**
   * Flushes all pending data in the output buffer, then moves the backreference
   * window and remaining data in the output buffer to the beginning of the
   * output buffer to ensure there is enough room to store decompressed data.
   */
  function flushOutputBuffer() {
    // If the output position has not moved, then there is no need to move the
    // data.
    if (pendingOutputPos === outputPos) {
      return
    }

    // Write all pending data from the output buffer.
    transform.push(Buffer.from(output.slice(pendingOutputPos, outputPos)))

    // If we've decompressed all remaining data, then we only need to write the
    // pending data.
    if (decompressedRemaining === 0) {
      pendingOutputPos = outputPos
      return
    }

    // Get the position of the start of the backreference window, which may be
    // the start of the output buffer if not enough data has been read.
    const outputStart = Math.max(outputPos - MAX_CHUNK_DISTANCE, 0)

    // Get the new output position to be set once the data has been moved. If
    // the output position has not changed, then there is no need to move the
    // data.
    const newOutputPos = outputPos - outputStart
    if (newOutputPos === outputPos) {
      return
    }

    // Move the data and set the new output position.
    output.copyWithin(0, outputStart, outputPos)
    outputPos = newOutputPos
    pendingOutputPos = outputPos
  }

  /** Returns an error indicating that the input is invalid. */
  function getInvalidInputError(message?: string): Error {
    return new Error(
      'Invalid input was encountered while decompressing.' +
        (message == null ? '' : ' ' + message),
    )
  }

  const transform = new Transform({
    transform(
      chunk: Buffer,
      encoding: BufferEncoding,
      callback: TransformCallback,
    ) {
      try {
        // If we're in the middle of reading the buffer, append the chunk to the
        // buffer. Otherwise, the chunk is our new buffer.
        if (input != null && inputPos < input.byteLength) {
          const newInput = Buffer.alloc(
            input.byteLength - inputPos + chunk.byteLength,
          )
          input.copy(newInput, 0, inputPos)
          chunk.copy(newInput, input.byteLength - inputPos)
          input = newInput
          inputPos = 0
        } else {
          input = chunk
          inputPos = 0
        }

        if (!isHeaderRead) {
          // If we have not received enough data to read the entire header,
          // defer reading the header.
          if (input.byteLength - inputPos < HEADER_LENGTH) {
            callback()
            return
          }

          readHeader()
        }

        // While we received enough data to read a compressed group at its
        // maximum potential length, decompress groups until there are no more
        // groups that can be decompressed.
        let prevDecompressedRemaining = 0
        while (
          prevDecompressedRemaining !== decompressedRemaining &&
          input.byteLength - inputPos >= MAX_COMPRESSED_GROUP_LENGTH
        ) {
          prevDecompressedRemaining = decompressedRemaining
          decompressGroup()
        }

        callback()
      } catch (err) {
        callback(err)
      }
    },

    flush(callback: TransformCallback) {
      try {
        if (!isHeaderRead) {
          // If we have not received enough data to read the entire header, the
          // input is invalid.
          if (input.byteLength - inputPos < HEADER_LENGTH) {
            throw getInvalidInputError('The input ended prematurely.')
          }

          readHeader()
        }

        // Read groups until the end of the stream.
        while (decompressedRemaining > 0) {
          decompressGroup()
        }

        // Ensure that the length of decompressed data matches the value in the
        // header. Otherwise, the input is invalid.
        if (decompressedRemaining !== 0) {
          throw getInvalidInputError('The input ended prematurely.')
        }

        // Flush any pending data from the output buffer.
        flushOutputBuffer()

        callback()
      } catch (err) {
        callback(err)
      }
    },
  })

  return transform
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
