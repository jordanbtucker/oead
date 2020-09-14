const {deepStrictEqual} = require('assert')
const {readdir, readFile} = require('fs').promises
const {join} = require('path')
const t = require('tap')

const {compressFile, decompressBuffer} = require('../../..').yaz0

t.test('compressFile', async t => {
  const fixtureNames = await readdir('test/yaz0/fixtures/decompressed')
  for (const fixtureName of fixtureNames) {
    await t.test(fixtureName, async () => {
      const [actual, expected] = await Promise.all([
        compressFile(join('test/yaz0/fixtures/decompressed', fixtureName)).then(
          decompressBuffer,
        ),
        readFile(join('test/yaz0/fixtures/decompressed', fixtureName)),
      ])
      deepStrictEqual(actual, expected)
    })
  }
})
