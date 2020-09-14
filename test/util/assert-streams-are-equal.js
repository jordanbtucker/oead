const {deepStrictEqual, strictEqual} = require('assert')

/**
 * Returns a Promise that asserts that the contents and lengths of two streams
 * are equal.
 *
 * @param {import('stream').Readable} actual
 * @param {import('stream').Readable} expected
 *
 * @returns {Promise<void>}
 */
async function assertStreamsAreEqual(actual, expected) {
  return new Promise((resolve, reject) => {
    let actBuffers = []
    let expBuffers = []
    let isActEnded = false
    let isExpEnded = false

    actual
      .on('data', data => {
        actBuffers.push(data)
      })
      .on('end', () => {
        isActEnded = true
        assertStreamsAreEqual()
      })
      .on('error', reject)

    expected
      .on('data', data => {
        expBuffers.push(data)
      })
      .on('end', () => {
        isExpEnded = true
        assertStreamsAreEqual()
      })
      .on('error', reject)

    function assertStreamsAreEqual() {
      if (isActEnded && isExpEnded) {
        const actBuffer = Buffer.concat(actBuffers)
        const expBuffer = Buffer.concat(expBuffers)

        try {
          strictEqual(
            actBuffer.byteLength,
            expBuffer.byteLength,
            'Stream lengths do not match',
          )

          // Assert that the two buffers are equal, and if they are not, iterate
          // through the buffers to find and report the position of the first
          // discrepancy. This speeds up the test on success and slows it down
          // on failure.
          try {
            deepStrictEqual(actBuffer, expBuffer)
          } catch {
            for (let i = 0; i < actBuffer.byteLength; i += 32) {
              const actSlice = actBuffer.slice(i, i + 32)
              const expSlice = expBuffer.slice(i, i + 32)
              deepStrictEqual(
                actSlice,
                expSlice,
                `Buffers are not equal at ${i}.\n Actual:   ${JSON.stringify(
                  actSlice.toJSON(),
                )}\nExpected: ${JSON.stringify(expSlice.toJSON())}`,
              )
            }
          }

          resolve()
        } catch (err) {
          reject(err)
          actual.destroy(err)
          expected.destroy(err)
        }
      }
    }
  })
}

module.exports = assertStreamsAreEqual
