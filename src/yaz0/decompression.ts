import {Transform, TransformCallback} from 'stream'
import {
  CHUNKS_PER_GROUP,
  CHUNK_DISTANCE_OFFSET,
  GROUP_HEADER_LENGTH,
  HEADER_LENGTH,
  LONG_CHUNK_LENGTH_OFFSET,
  MAGIC_STRING,
  MAX_CHUNK_LENGTH,
  MAX_DISTANCE,
  MIN_BACKREF_CHUNK_LENGTH,
  SHORT_CHUNK_LENGTH_OFFSET,
} from './constants'

/**
 * Decompresses a stream that has been compressed via the Yaz0 algorithm.
 *
 * @returns A Transform stream that can be accepts compressed data and outputs
 * decompressed data.
 * @example
 * ```
 * createReadStream('ActorInfo.product.sbyml')
 *   .pipe(decompress())
 *   .pipe(createWriteStream('ActorInfo.product.byml'))
 * ```
 */
export function decompress(): Transform {
  let buffer = Buffer.alloc(0)
  let pos = 0
  let isHeaderRead = false
  let outputLength = 0
  let decompressedLength: number
  let output = Buffer.alloc(0)

  function readHeader() {
    // Ensure the header begins with the ASCII string `Yaz0`. Otherwise, the
    // input is invalid.
    if (
      buffer.slice(0, MAGIC_STRING.length).toString('ascii') !== MAGIC_STRING
    ) {
      throw getInvalidInputError()
    }

    // The next four bytes represent the length of the data after is has been
    // decompressed.
    decompressedLength = buffer.readUInt32BE(MAGIC_STRING.length)

    // The next eight bytes are reserved and can be ignored for now. We don't
    // need any more information from the header, so we truncate the buffer.
    pos = HEADER_LENGTH
    buffer = Buffer.from(buffer.slice(pos))
    pos = 0
    isHeaderRead = true
  }

  function readGroup(): Buffer | null {
    // If we've reached the end of the buffer, return null to signal that there
    // are no more groups to read.
    if (pos === buffer.byteLength) {
      return null
    }

    let groupHeader = buffer[pos++]
    let remainingChunks = CHUNKS_PER_GROUP
    let result = Buffer.alloc(0)

    // Chunk groups are read until the end of input, and the final chunk group
    // can end early.
    while (remainingChunks > 0 && pos < buffer.byteLength) {
      // Each bit of the group header represents the type of its corresponding
      // chunk. We shift the group header to the left after each chunk so we
      // only need to check the MSB each time.
      if (groupHeader & 0x80) {
        // A set bit means the next chunk is a single byte that is not
        // compressed and can be returned as-is.
        const byteBuffer = Buffer.from([buffer[pos++]])
        result = Buffer.concat([result, byteBuffer])
        output = Buffer.concat([output, byteBuffer])
      } else {
        // A clear bit means the next chunk is a reference to a previous
        // sequence of data in the decompressed output. If we have not received
        // enough data to read the next chunk, the input is invalid.
        if (buffer.byteLength - pos < MIN_BACKREF_CHUNK_LENGTH) {
          throw getInvalidInputError()
        }

        // The chunk is either long or short. If the chunk is long and we have
        // not received enough data to read the chunk, the input is invalid.
        const chunk = buffer.readUInt16BE(pos)
        pos += MIN_BACKREF_CHUNK_LENGTH
        const isLongChunk = (chunk & 0xf000) === 0
        if (
          isLongChunk &&
          buffer.byteLength - pos < MAX_CHUNK_LENGTH - MIN_BACKREF_CHUNK_LENGTH
        ) {
          throw getInvalidInputError()
        }

        // Each chunk represents a backreference to a sequnce of data in the
        // output we have decompressed so far. The distance from the end of the
        // output and length determines the backreferenced data.
        const distance = (chunk & 0x0fff) + CHUNK_DISTANCE_OFFSET
        const length = isLongChunk
          ? buffer[pos++] + LONG_CHUNK_LENGTH_OFFSET
          : (chunk >> 12) + SHORT_CHUNK_LENGTH_OFFSET

        // If the distance is too far from the end of the output, the input is
        // invalid.
        const start = output.byteLength - distance
        const end = start + length
        if (start < 0) {
          throw getInvalidInputError()
        }

        // Since a backreference can reference itself in whole or part, we need
        // to read each byte from the output individually.
        for (let i = start; i < end; i++) {
          const byteBuffer = Buffer.from([output[i]])
          result = Buffer.concat([result, byteBuffer])
          output = Buffer.concat([output, byteBuffer])
        }
      }

      groupHeader <<= 1
      remainingChunks--
    }

    outputLength += result.byteLength
    return result
  }

  // function readChunks(): Buffer {
  //   let remainingChunks = 0
  //   let groupHeader = 0
  //   let result = Buffer.alloc(0)

  //   // Chunk groups are read until the end of input and the final chunk group
  //   // can end early.
  //   while (pos < buffer.byteLength) {
  //     // If we have not received enough data to read the next group header and
  //     // chunk, the input is invalid.
  //     if (buffer.byteLength - pos < GROUP_HEADER_LENGTH + MIN_CHUNK_LENGTH) {
  //       throw getInvalidInputError()
  //     }

  //     if (remainingChunks === 0) {
  //       groupHeader = buffer[pos++]
  //       remainingChunks = CHUNKS_PER_GROUP
  //     }

  //     // Each bit of the group header represents the type of its corresponding
  //     // chunk. We shift the group header to the left after each chunk so we
  //     // only need to check the MSB each time.
  //     if (groupHeader & 0x80) {
  //       // A set bit means the next chunk is a single byte that is not
  //       // compressed and can be returned as-is.
  //       const byteBuffer = Buffer.from([buffer[pos++]])
  //       result = Buffer.concat([result, byteBuffer])
  //       output = Buffer.concat([output, byteBuffer])
  //     } else {
  //       // A clear bit means the next chunk is a reference to a previous
  //       // sequence of data in the decompressed output. If we have not received
  //       // enough data to read the next chunk, the input is invalid.
  //       if (buffer.byteLength - pos < MIN_BACKREF_CHUNK_LENGTH) {
  //         throw getInvalidInputError()
  //       }

  //       // The chunk is either long or short. If the chunk is long and we have
  //       // not received enough data to read the chunk, the input is invalid.
  //       const chunk = buffer.readUInt16BE(pos)
  //       pos += MIN_BACKREF_CHUNK_LENGTH
  //       const isLongChunk = (chunk & 0xf000) === 0
  //       if (
  //         isLongChunk &&
  //         buffer.byteLength - pos < MAX_CHUNK_LENGTH - MIN_BACKREF_CHUNK_LENGTH
  //       ) {
  //         throw getInvalidInputError()
  //       }

  //       // Each chunk represents a backreference to a sequnce of data in the
  //       // output we have decompressed so far. The distance from the end of the
  //       // output and length determines the backreferenced data.
  //       const distance = (chunk & 0x0fff) + CHUNK_DISTANCE_OFFSET
  //       const length = isLongChunk
  //         ? buffer[pos++] + LONG_CHUNK_LENGTH_OFFSET
  //         : (chunk >> 12) + SHORT_CHUNK_LENGTH_OFFSET

  //       // If the distance is too far from the end of the output, the input is
  //       // invalid.
  //       const start = output.byteLength - distance
  //       const end = start + length
  //       if (start < 0) {
  //         throw getInvalidInputError()
  //       }

  //       // Since a backreference can reference itself in whole or part, we need
  //       // to read each byte from the output individually.
  //       for (let i = 0; i < end; i++) {
  //         const byteBuffer = Buffer.from([output[i]])
  //         result = Buffer.concat([result, byteBuffer])
  //         output = Buffer.concat([output, byteBuffer])
  //       }
  //     }

  //     groupHeader <<= 1
  //     remainingChunks--
  //   }

  //   // Backreferences can only reach so far, so we truncate the output.
  //   if (output.byteLength > MAX_DISTANCE) {
  //     output = Buffer.from(output.slice(output.byteLength - MAX_DISTANCE))
  //   }

  //   outputLength += result.byteLength
  //   return result
  // }

  function getInvalidInputError(): Error {
    return new Error('Invalid input encountered while decompressing.')
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
        if (pos < buffer.byteLength) {
          buffer = Buffer.concat([buffer, chunk])
        } else {
          buffer = chunk
          pos = 0
        }

        if (!isHeaderRead) {
          // If we have not received enough data to read the entire header,
          // defer reading the header.
          if (buffer.byteLength - pos < HEADER_LENGTH) {
            callback()
            return
          }

          readHeader()
        }

        const groups = []

        // Read groups while we have enough data to read a group at its max
        // potential length. This check is performed in `transform` but not in
        // `flush`.
        while (
          buffer.byteLength - pos >=
          GROUP_HEADER_LENGTH + MAX_CHUNK_LENGTH * CHUNKS_PER_GROUP
        ) {
          const group = readGroup()

          // A null return value indicates that we have reached the end of the
          // buffer.
          if (group == null) {
            break
          }

          groups.push(group)
        }

        // Backreferences can only reach so far, so we truncate the output.
        if (output.byteLength > MAX_DISTANCE) {
          output = Buffer.from(output.slice(output.byteLength - MAX_DISTANCE))
        }

        const result = groups.length > 0 ? Buffer.concat(groups) : undefined
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
          if (buffer.byteLength - pos < HEADER_LENGTH) {
            throw getInvalidInputError()
          }

          readHeader()
        }

        // Read groups until null is returned.
        const groups = []
        for (let group = readGroup(); group != null; group = readGroup()) {
          groups.push(group)
        }

        const result = groups.length > 0 ? Buffer.concat(groups) : undefined

        // Ensure that the length of decompressed data matches the value in the
        // header. Otherwise, the input is invalid.
        if (outputLength !== decompressedLength) {
          throw getInvalidInputError()
        }

        callback(null, result)
      } catch (err) {
        callback(err)
      }
    },
  })
}
