const t = require('tap')
const {deepStrictEqual, strictEqual} = require('assert')
const {createReadStream} = require('fs')

const {decompress} = require('../../').yaz0

t.test('decompress', async t => {
  t.setTimeout(0)
  await assertStreamsAreEqual(
    createReadStream('test/yaz0/fixtures/compressed/0-0.shknm2').pipe(
      decompress(),
    ),
    createReadStream('test/yaz0/fixtures/decompressed/0-0.shknm2'),
  )
  await assertStreamsAreEqual(
    createReadStream(
      'test/yaz0/fixtures/compressed/ActorInfo.product.sbyml',
    ).pipe(decompress()),
    createReadStream('test/yaz0/fixtures/decompressed/ActorInfo.product.sbyml'),
  )
})

/**
 * Returns a Promise that asserts that the contents and lengths of two streams
 * are equal.
 *
 * @param {import('stream').Readable} actual
 * @param {import('stream').Readable} expected
 * @returns {Promise<void>}
 */
async function assertStreamsAreEqual(actual, expected) {
  return new Promise((resolve, reject) => {
    let bufAct = Buffer.alloc(0)
    let bufExp = Buffer.alloc(0)
    let pos = 0
    let isActEnded = false
    let isExpEnded = false

    actual
      .on('data', data => {
        bufAct = Buffer.concat([bufAct, data])
        assertBuffersAreEqual()
      })
      .on('end', () => {
        isActEnded = true
        assertStreamLengthsAreEqual()
      })
      .on('error', reject)

    expected
      .on('data', data => {
        bufExp = Buffer.concat([bufExp, data])
        assertBuffersAreEqual()
      })
      .on('end', () => {
        isExpEnded = true
        assertStreamLengthsAreEqual()
      })
      .on('error', reject)

    function assertBuffersAreEqual() {
      if (pos < bufAct.byteLength && pos < bufExp.byteLength) {
        const end = Math.min(bufAct.byteLength, bufExp.byteLength)

        for (let i = pos; i < end; i += 32) {
          const sliceAct = bufAct.slice(i, Math.min(i + 32, end))
          const sliceExp = bufExp.slice(i, Math.min(i + 32, end))
          try {
            deepStrictEqual(
              sliceAct.toJSON(),
              sliceExp.toJSON(),
              `Buffers are not equal at ${i}.\n Actual:   ${JSON.stringify(
                sliceAct.toJSON(),
              )}\nExpected: ${JSON.stringify(sliceExp.toJSON())}`,
            )
          } catch (err) {
            reject(err)
            destroyStreams(err)
          }
        }
        pos = end
      }
    }

    function assertStreamLengthsAreEqual() {
      if (isActEnded && isExpEnded) {
        try {
          strictEqual(
            bufAct.byteLength,
            bufExp.byteLength,
            'Stream lengths are not equal',
          )
          resolve()
        } catch (err) {
          reject(err)
        }
      }
    }

    function destroyStreams(err) {
      actual.destroy(err)
      expected.destroy(err)
    }
  })
}
