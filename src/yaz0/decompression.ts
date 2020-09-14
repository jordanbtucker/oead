import {createReadStream, PathLike} from 'fs'
import {Transform, TransformCallback} from 'stream'
import {
  CHUNKS_PER_GROUP,
  CHUNK_DISTANCE_OFFSET,
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
          : (chunk >> 12) + SHORT_CHUNK_LENGTH_OFFSET

        // If the distance is too far from the end of the output, the input is
        // invalid.
        const start = outputPos - distance
        const end = start + length
        if (start < 0) {
          throw getInvalidInputError(
            'Tried to back reference data further back than the maximum distance.',
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
 * Asynchronously decompresses the entire contents of a file.
 *
 * @param path A path to a file.
 * @param encoding The encoding for the file.

 * @returns A Promise that resolves with a string containing the decompressed
 * contents of the file.
 *
 * @example Getting a buffer
 * ```js
 * const buffer = await decompressFile('ActorInfo.product.sbyml')
 * await writeFile('ActorInfo.product.byml', buffer)
 * ```
 *
 * @example Getting a string
 * ```js
 * const text = await decompressFile('ActorInfo.product.sbyml', 'utf8')
 * await writeFile('ActorInfo.product.byml', text)
 * ```
 */
export async function decompressFile(
  path: PathLike,
  encoding?: BufferEncoding,
): Promise<Buffer | string> {
  return new Promise((resolve, reject) => {
    try {
      const buffers: Buffer[] = []
      createReadStream(path)
        .pipe(decompress())
        .on('data', (data: Buffer) => {
          buffers.push(data)
        })
        .on('end', () => {
          const buffer = Buffer.concat(buffers)
          resolve(encoding == null ? buffer : buffer.toString(encoding))
        })
        .on('error', reject)
    } catch (err) {
      reject(err)
    }
  })
}
