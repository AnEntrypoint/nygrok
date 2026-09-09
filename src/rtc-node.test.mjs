import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveRoomFromSeed } from './rtc-node.js'

test('deriveRoomFromSeed with no password matches the no-password-arg form (backward compatible)', () => {
  assert.equal(deriveRoomFromSeed('abc'), deriveRoomFromSeed('abc', ''))
})

test('deriveRoomFromSeed changes the room id when a password is set', () => {
  const withoutPw = deriveRoomFromSeed('abc')
  const withPw = deriveRoomFromSeed('abc', 'hunter2')
  assert.notEqual(withoutPw, withPw)
})

test('deriveRoomFromSeed requires the exact password to reproduce the room id', () => {
  const right = deriveRoomFromSeed('abc', 'hunter2')
  const wrong = deriveRoomFromSeed('abc', 'hunter3')
  assert.notEqual(right, wrong)
})

test('deriveRoomFromSeed is deterministic for the same seed+password', () => {
  assert.equal(deriveRoomFromSeed('abc', 'hunter2'), deriveRoomFromSeed('abc', 'hunter2'))
})
