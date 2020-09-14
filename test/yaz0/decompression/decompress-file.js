const {deepStrictEqual} = require('assert')
const {readdir, readFile} = require('fs').promises
const {join} = require('path')
const t = require('tap')

const {decompressFile} = require('../../../lib').yaz0

t.test('decompressFile', async t => {
  await t.test('no options', async t => {
    const fixtureNames = await readdir('test/yaz0/fixtures/compressed')
    for (const fixtureName of fixtureNames) {
      await t.test(fixtureName, async () => {
        const [actual, expected] = await Promise.all([
          decompressFile(join('test/yaz0/fixtures/compressed', fixtureName)),
          readFile(join('test/yaz0/fixtures/decompressed', fixtureName)),
        ])
        deepStrictEqual(actual, expected)
      })
    }
  })
  await t.test('encoding', async t => {
    const fixtureNames = (
      await readdir('test/yaz0/fixtures/compressed')
    ).filter(name => name === 'lorem.stxt')
    for (const fixtureName of fixtureNames) {
      await t.test(fixtureName, async () => {
        const [actual, expected] = await Promise.all([
          decompressFile(
            join('test/yaz0/fixtures/compressed', fixtureName),
            'utf8',
          ),
          readFile(
            join('test/yaz0/fixtures/decompressed', fixtureName),
            'utf8',
          ),
        ])
        deepStrictEqual(actual, expected)
      })
    }
  })
})
