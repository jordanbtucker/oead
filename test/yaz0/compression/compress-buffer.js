const {deepStrictEqual} = require('assert')
const {readdir, readFile} = require('fs').promises
const {join} = require('path')
const t = require('tap')

const {compressBuffer, decompressBuffer} = require('../../..').yaz0

t.test('compressBuffer', async t => {
  const fixtureNames = await readdir('test/yaz0/fixtures/decompressed')
  for (const fixtureName of fixtureNames) {
    await t.test(fixtureName, async () => {
      const expected = await readFile(
        join('test/yaz0/fixtures/decompressed', fixtureName),
      )
      const actual = await decompressBuffer(await compressBuffer(expected))
      deepStrictEqual(actual, expected)
    })
  }
})
