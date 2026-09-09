import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FRAME, encodeFrame, decodeFrame, chunkBody, MAX_CHUNK } from './tunnel-protocol.js'

test('REQ_HEAD round-trips JSON payload with id', () => {
  const payload = { method: 'GET', path: '/foo?x=1', headers: { accept: 'text/html' } }
  const frame = encodeFrame(FRAME.REQ_HEAD, 42, payload)
  const decoded = decodeFrame(frame)
  assert.equal(decoded.type, FRAME.REQ_HEAD)
  assert.equal(decoded.id, 42)
  assert.deepEqual(decoded.payload, payload)
})

test('RES_BODY round-trips raw bytes, zero-length allowed', () => {
  const bytes = new Uint8Array([1, 2, 3, 255])
  const frame = encodeFrame(FRAME.RES_BODY, 7, bytes)
  const decoded = decodeFrame(frame)
  assert.equal(decoded.type, FRAME.RES_BODY)
  assert.equal(decoded.id, 7)
  assert.deepEqual(Array.from(decoded.payload), [1, 2, 3, 255])

  const end = decodeFrame(encodeFrame(FRAME.RES_BODY, 7, new Uint8Array(0)))
  assert.equal(end.payload.length, 0)
})

test('WS_MSG round-trips binary flag + payload', () => {
  const bytes = new Uint8Array([9, 8, 7])
  const bin = decodeFrame(encodeFrame(FRAME.WS_MSG, 3, { binary: true, data: bytes }))
  assert.equal(bin.payload.binary, true)
  assert.deepEqual(Array.from(bin.payload.data), [9, 8, 7])

  const txt = decodeFrame(encodeFrame(FRAME.WS_MSG, 3, { binary: false, data: bytes }))
  assert.equal(txt.payload.binary, false)
})

test('ids survive the full u32 range', () => {
  const decoded = decodeFrame(encodeFrame(FRAME.RES_ERROR, 0xffffffff, { message: 'boom' }))
  assert.equal(decoded.id, 0xffffffff)
})

test('decodeFrame rejects truncated frames', () => {
  assert.equal(decodeFrame(new Uint8Array([1, 2, 3])), null)
  assert.equal(decodeFrame(new Uint8Array(0)), null)
})

test('chunkBody splits large bodies at MAX_CHUNK and always ends with an empty chunk', () => {
  const bytes = new Uint8Array(MAX_CHUNK * 2 + 10)
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 256
  const chunks = Array.from(chunkBody(bytes))
  assert.equal(chunks.length, 4) // 16K, 16K, 10, empty
  assert.equal(chunks[0].length, MAX_CHUNK)
  assert.equal(chunks[1].length, MAX_CHUNK)
  assert.equal(chunks[2].length, 10)
  assert.equal(chunks[3].length, 0)
  const reassembled = Buffer.concat(chunks.slice(0, 3).map((c) => Buffer.from(c)))
  assert.deepEqual(new Uint8Array(reassembled), bytes)
})

test('chunkBody on an empty body yields exactly one empty chunk', () => {
  const chunks = Array.from(chunkBody(new Uint8Array(0)))
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].length, 0)
})
