const t = require('tap')
const {deepStrictEqual, strictEqual} = require('assert')
const {createReadStream} = require('fs')
const {join} = require('path')
const {readdir} = require('fs').promises

const {decompress} = require('../../../').yaz0

t.test('decompress', async t => {
  const fixtureNames = await readdir('test/yaz0/fixtures/compressed')
  for (const fixtureName of fixtureNames) {
    await t.test(fixtureName, async () => {
      await assertStreamsAreEqual(
        createReadStream(
          join('test/yaz0/fixtures/compressed/', fixtureName),
        ).pipe(decompress()),
        createReadStream(join('test/yaz0/fixtures/decompressed/', fixtureName)),
      )
    })
  }
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
