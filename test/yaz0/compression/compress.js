const t = require('tap')
const {createReadStream} = require('fs')
const {join} = require('path')
const {readdir} = require('fs').promises
const assertStreamsAreEqual = require('../../util/assert-streams-are-equal')

const {compress, decompress} = require('../../../').yaz0

t.test('compress', async t => {
  const fixtureNames = await readdir('test/yaz0/fixtures/compressed')
  for (const fixtureName of fixtureNames) {
    await t.test(fixtureName, async () => {
      await assertStreamsAreEqual(
        createReadStream(join('test/yaz0/fixtures/decompressed/', fixtureName))
          .pipe(compress())
          .pipe(decompress()),
        createReadStream(join('test/yaz0/fixtures/decompressed/', fixtureName)),
      )
    })
  }
})
