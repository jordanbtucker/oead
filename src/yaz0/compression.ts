import {Transform, TransformCallback} from 'stream'
import {
  CHUNKS_PER_GROUP,
  GROUP_HEADER_LENGTH,
  HEADER_LENGTH,
  MAGIC_STRING,
} from './constants'

/**
 * Compresses a stream via the Yaz0 algorithm.
 *
 * **Warning:** This implementation currently performs no real compression, and
 * in fact results in larger files, but it does produce valid Yaz0 files.
 *
 * @returns A Transform stream that accepts data and outputs compressed data.
 *
 * @example
 * ```js
 * createReadStream('ActorInfo.product.byml')
 *   .pipe(compress())
 *   .pipe(createWriteStream('ActorInfo.product.sbyml'))
 * ```
 */
export function compress(): Transform {
  const inputs: Buffer[] = []

  return new Transform({
    transform(
      chunk: Buffer,
      enocding: BufferEncoding,
      callback: TransformCallback,
    ) {
      try {
        inputs.push(chunk)
        callback()
      } catch (err) {
        callback(err)
      }
    },
    flush(callback: TransformCallback) {
      try {
        const input = Buffer.concat(inputs)
        const output = Buffer.alloc(
          HEADER_LENGTH +
            Math.floor(input.byteLength / CHUNKS_PER_GROUP) *
              (CHUNKS_PER_GROUP + GROUP_HEADER_LENGTH) +
            (input.byteLength % CHUNKS_PER_GROUP) +
            GROUP_HEADER_LENGTH,
        )

        output.write(MAGIC_STRING, 'ascii')
        output.writeInt32BE(input.byteLength, MAGIC_STRING.length)
        let outputPos = HEADER_LENGTH

        for (let i = 0; i < input.byteLength; i += CHUNKS_PER_GROUP) {
          const inputSlice = input.slice(i, i + CHUNKS_PER_GROUP)
          output[outputPos++] = 0xff
          for (let j = 0; j < inputSlice.byteLength; j++) {
            output[outputPos++] = inputSlice[j]
          }
        }

        callback(null, output)
      } catch (err) {
        callback(err)
      }
    },
  })
}
