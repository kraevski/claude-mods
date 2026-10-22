import { expect, test } from 'claude-code/testing'

import { parse, refText } from '../hooks/command'

test('parse reads the control words only when their arguments fit', () => {
  const table: [string, unknown][] = [
    ['list', { kind: 'list' }],
    ['clear', { kind: 'clear' }],
    ['pause', { kind: 'pause' }],
    ['resume', { kind: 'resume' }],
    ['rm 2', { kind: 'rm', ref: { n: 2 } }],
    ['send 1', { kind: 'send', ref: { n: 1 } }],
    ['up 3', { kind: 'up', ref: { n: 3 } }],
    ['down 2', { kind: 'down', ref: { n: 2 } }],
    ['rm 0', { kind: 'rm', ref: { n: 0 } }],
    ['edit 2', { kind: 'edit', ref: { n: 2 }, text: undefined }],
    ['edit 2 new text', { kind: 'edit', ref: { n: 2 }, text: 'new text' }],
    ['  rm   2  ', { kind: 'rm', ref: { n: 2 } }],
    ['rm', { kind: 'message', text: 'rm' }],
    ['rm two', { kind: 'message', text: 'rm two' }],
    ['rm 2 3', { kind: 'message', text: 'rm 2 3' }],
    ['list now', { kind: 'message', text: 'list now' }],
    ['edit x hi', { kind: 'message', text: 'edit x hi' }],
    ['run the tests', { kind: 'message', text: 'run the tests' }],
    ['-- list', { kind: 'message', text: 'list' }],
    ['-- rm 2', { kind: 'message', text: 'rm 2' }],
    ['--', { kind: 'message', text: '' }],
    ['', { kind: 'message', text: '' }],
  ]

  for (const [args, expected] of table) expect(parse(args)).toEqual(expected)
})

test('parse accepts an @<id> wherever it accepts a position', () => {
  const table: [string, unknown][] = [
    ['rm @k3j2h1', { kind: 'rm', ref: { id: 'k3j2h1' } }],
    ['send @k3j2h1', { kind: 'send', ref: { id: 'k3j2h1' } }],
    ['up @k3j2h1', { kind: 'up', ref: { id: 'k3j2h1' } }],
    ['down @k3j2h1', { kind: 'down', ref: { id: 'k3j2h1' } }],
    ['edit @k3j2h1', { kind: 'edit', ref: { id: 'k3j2h1' }, text: undefined }],
    ['edit @k3j2h1 run the linter', { kind: 'edit', ref: { id: 'k3j2h1' }, text: 'run the linter' }],
    ['rm @', { kind: 'message', text: 'rm @' }],
    ['rm @ABC', { kind: 'message', text: 'rm @ABC' }],
    ['rm @a b', { kind: 'message', text: 'rm @a b' }],
    ['edit @k3j2h1', { kind: 'edit', ref: { id: 'k3j2h1' }, text: undefined }],
  ]

  for (const [args, expected] of table) expect(parse(args)).toEqual(expected)
})

test('refText writes a position as a number and an id with @', () => {
  expect(refText({ n: 2 })).toBe('2')
  expect(refText({ id: 'k3j2h1' })).toBe('@k3j2h1')
})
