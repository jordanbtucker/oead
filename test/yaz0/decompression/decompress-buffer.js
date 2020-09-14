const {deepStrictEqual} = require('assert')
const {readdir, readFile} = require('fs').promises
const {join} = require('path')
const t = require('tap')

const {decompressBuffer} = require('../../../lib').yaz0

t.test('decompressBuffer', async t => {
  await t.test('no options', async t => {
    const fixtureNames = await readdir('test/yaz0/fixtures/compressed')
    for (const fixtureName of fixtureNames) {
      await t.test(fixtureName, async () => {
        const [actual, expected] = await Promise.all([
          readFile(
            join('test/yaz0/fixtures/compressed', fixtureName),
          ).then(buffer => decompressBuffer(buffer)),
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
          readFile(
            join('test/yaz0/fixtures/compressed', fixtureName),
          ).then(buffer => decompressBuffer(buffer, 'utf8')),
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
