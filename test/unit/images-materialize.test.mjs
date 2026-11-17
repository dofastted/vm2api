import test from 'node:test'
import assert from 'node:assert/strict'
import { materializeRemoteImageSources } from '../../src/lib/protocol/images.mjs'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test('materializeRemoteImageSources fetches url images to base64', async () => {
  const fetchImpl = async (url) => {
    assert.match(url, /^https:\/\/example.com\/a.png$/)
    return {
      ok: true,
      headers: { get: (k) => (k === 'content-type' ? 'image/png' : null) },
      arrayBuffer: async () => PNG,
    }
  }
  const out = await materializeRemoteImageSources(
    {
      model: 'claude-opus-4-6',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '这是什么?' },
            { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
          ],
        },
      ],
    },
    { fetchImpl },
  )
  assert.equal(out.messages[0].content[1].source.type, 'base64')
  assert.equal(out.messages[0].content[1].source.media_type, 'image/png')
  assert.equal(out.messages[0].content[1].source.data, PNG.toString('base64'))
})

test('materializeRemoteImageSources keeps url when fetch fails', async () => {
  const out = await materializeRemoteImageSources(
    {
      messages: [
        {
          role: 'user',
          content: [{ type: 'image', source: { type: 'url', url: 'https://example.com/missing.png' } }],
        },
      ],
    },
    {
      fetchImpl: async () => ({ ok: false, headers: { get: () => null }, arrayBuffer: async () => new ArrayBuffer(0) }),
    },
  )
  assert.equal(out.messages[0].content[0].source.type, 'url')
})

test('materializeRemoteImageSources reuses local tool history and still finds nested remote images', async () => {
  const local = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG.toString('base64') } }
  const remote = { type: 'image_url', image_url: 'https://example.com/nested.png' }
  const tool = { type: 'tool_result', tool_use_id: 'toolu_example', content: [local] }
  const body = { messages: [{ role: 'user', content: [tool] }] }
  let calls = 0
  const fetchImpl = async (url) => {
    assert.equal(url, remote.image_url)
    calls++
    return { ok: true, headers: { get: () => 'image/png' }, arrayBuffer: async () => PNG }
  }
  assert.equal(await materializeRemoteImageSources(body, { fetchImpl }), body)
  assert.equal(calls, 0)
  const mixed = { messages: [{ role: 'user', content: [{ ...tool, content: [local, remote] }] }] }
  const output = await materializeRemoteImageSources(mixed, { fetchImpl })
  assert.equal(calls, 1)
  assert.deepEqual(output.messages[0].content[0].content, [local, local])
  assert.equal(mixed.messages[0].content[0].content[1], remote)
})
