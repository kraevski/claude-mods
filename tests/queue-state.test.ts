import { expect, test } from 'claude-code/testing'

import type { QueueItem, QueueState } from '../types'
import {
  add,
  claim,
  claimNow,
  clearQueued,
  dropItem,
  droppedIds,
  initialState,
  removeItem,
  isOpen,
  markSent,
  moveItem,
  moveToBox,
  newId,
  nextItem,
  onPersonSubmit,
  onStop,
  onTurnComplete,
  onTurnStart,
  editItem,
  findQueued,
  queuedAt,
  queuedItems,
  resume,
} from '../hooks/queue'

const item = (id: string, status: QueueItem['status'] = 'waiting'): QueueItem => ({
  id,
  text: id,
  kind: 'prompt',
  status,
  createdAt: 0,
})

const withItems = (items: QueueItem[]): QueueState => ({ ...initialState, items })

test('a turn that ends with an interrupt pauses the queue and drops the wait for a Stop', () => {
  const sending = claim(withItems([item('a'), item('b')]), 'a', false)!
  const aborted = onTurnComplete(sending, { isAborted: true, reason: 'aborted' })

  expect(aborted.gate.paused).toBe('aborted')
  expect(aborted.gate.awaitingStop).toBe(false)
})

test('a turn that ends with an API error pauses the queue', () => {
  const errored = onTurnComplete(withItems([item('b')]), { isAborted: false, reason: 'error' })

  expect(errored.gate.paused).toBe('error')
})

test('an interrupt with nothing queued does not pause, so the next message is not started paused', () => {
  const aborted = onTurnComplete(initialState, { isAborted: true, reason: 'aborted' })
  expect(aborted.gate.paused).toBe(undefined)

  const errored = onTurnComplete(initialState, { isAborted: false, reason: 'error' })
  expect(errored.gate.paused).toBe(undefined)
  expect(claim(add(errored, item('next')), 'next', false)).not.toBe(undefined)
})

test('an interrupt with nothing queued still drops the wait for a Stop, so the next send is not blocked', () => {
  // The interrupted message was sent (its submit resolved) and its turn is the one that was cut short: no Stop will come.
  const inFlight = { ...withItems([item('sent-one', 'sent')]), gate: { ...initialState.gate, awaitingStop: true } }
  const aborted = onTurnComplete(inFlight, { isAborted: true, reason: 'aborted' })

  expect(aborted.gate.awaitingStop).toBe(false)
  expect(aborted.gate.paused).toBe(undefined)
  expect(claim(add(aborted, item('next')), 'next', false)).not.toBe(undefined)
})

test('emptying the queue ends an interrupt or error pause, by clear or by removing the last message', () => {
  const aborted = { ...withItems([item('a')]), gate: { ...initialState.gate, paused: 'aborted' as const } }
  expect(clearQueued(aborted).gate.paused).toBe(undefined)
  expect(removeItem(aborted, 'a').gate.paused).toBe(undefined)

  const errored = { ...withItems([item('a')]), gate: { ...initialState.gate, paused: 'error' as const } }
  expect(clearQueued(errored).gate.paused).toBe(undefined)
  expect(removeItem(errored, 'a').gate.paused).toBe(undefined)
})

test('emptying the queue keeps a pause the person chose, and a queue with messages left keeps its pause', () => {
  const chosen = { ...withItems([item('a')]), gate: { ...initialState.gate, paused: 'user' as const } }
  expect(clearQueued(chosen).gate.paused).toBe('user')
  expect(removeItem(chosen, 'a').gate.paused).toBe('user')

  const twoLeft = { ...withItems([item('a'), item('b')]), gate: { ...initialState.gate, paused: 'error' as const } }
  expect(removeItem(twoLeft, 'a').gate.paused).toBe('error')
})

test('newId is four base36 characters, and skips an id already in the queue', () => {
  const state = withItems([item('0000')])
  const draws = [0, 5 / 36 ** 4, 7 / 36 ** 4]
  let i = 0
  const random = () => draws[i++] ?? 0

  expect(newId(initialState, () => 0.5)).toMatch(/^[0-9a-z]{4}$/)
  expect(newId(state, random)).toBe('0005')
})

test('a dropped message is recorded, a message taken to the prompt box is not, and newId skips dropped ids', () => {
  const state = withItems([item('a'), item('b')])

  expect(removeItem(state, 'a').removedIds).toEqual([])
  expect(dropItem(state, 'a').removedIds).toEqual(['a'])
  expect(clearQueued(state).removedIds).toEqual(['a', 'b'])

  const draws = [0, 5 / 36 ** 4]
  let i = 0
  expect(newId({ ...initialState, removedIds: ['0000'] }, () => draws[i++] ?? 0)).toBe('0005')
})

test('a message moved to the prompt box is marked until the person submits, and a second move drops the first', () => {
  const state = withItems([item('a'), item('b')])

  const boxed = moveToBox(state, 'a')
  expect(boxed.boxedId).toBe('a')
  expect(queuedItems(boxed).map(x => x.id)).toEqual(['b'])
  expect(droppedIds(boxed)).toEqual([])
  expect(onPersonSubmit(boxed)?.boxedId).toBeUndefined()
  expect(onPersonSubmit(state)).toBeUndefined()

  const replaced = moveToBox(boxed, 'b')
  expect(replaced.boxedId).toBe('b')
  expect(droppedIds(replaced)).toEqual(['a'])
})

test('the dropped ids are kept to the latest 200', () => {
  const dropped = Array.from({ length: 205 }, (_, n) => item(`x${n}`))
  let state = withItems(dropped)
  for (const x of dropped) state = dropItem(state, x.id)

  expect(droppedIds(state)).toHaveLength(200)
  expect(droppedIds(state)[0]).toBe('x5')
})

test('state written before removedIds existed: add, rm and clear all work', () => {
  const legacy: QueueState = { items: [], gate: initialState.gate }
  const added = add(legacy, item('a'))
  expect(dropItem(added, 'a').removedIds).toEqual(['a'])
  expect(clearQueued(add(legacy, item('b'))).removedIds).toEqual(['b'])
  expect(newId(legacy, () => 0)).toBe('0000')
})

test('a turn that answers leaves the queue open until the Stop', () => {
  const answered = onTurnComplete(onTurnStart(initialState), { isAborted: false, reason: 'answer' })

  expect(answered.gate.paused).toBe(undefined)
  expect(answered.gate.mainTurn).toBe('idle')
})

test('a Stop with background tasks keeps the gate closed', () => {
  const shell = { type: 'shell', description: 'sleep 30' }
  const withShell = onStop(initialState, [shell])

  expect(isOpen(withShell)).toBe(false)
  expect(isOpen(onStop(withShell, []))).toBe(true)
})

test('claim refuses an item that is not first, so the order holds', () => {
  const state = withItems([item('a'), item('b')])

  expect(claim(state, 'b', false)).toBe(undefined)
  expect(claim(state, 'a', false)).not.toBe(undefined)
})

test('claim refuses while an agent is busy', () => {
  expect(claim(withItems([item('a')]), 'a', true)).toBe(undefined)
})

test('a claimed item waits for its Stop before the next one can be claimed', () => {
  const claimed = claim(withItems([item('a'), item('b')]), 'a', false)!

  expect(claim(claimed, 'b', false)).toBe(undefined)
  expect(nextItem(markSent(claimed, 'a'))?.id).toBe('b')
})

test('sent items are trimmed to the last five', () => {
  let state = initialState
  for (let i = 0; i < 8; i++) state = add(state, item(`m${i}`))
  for (let i = 0; i < 8; i++) state = markSent(state, `m${i}`)

  expect(state.items.map(x => x.id)).toEqual(['m3', 'm4', 'm5', 'm6', 'm7'])
})

test('claimNow refuses while the main turn runs, so send <n> cannot submit into a running turn', () => {
  const running = onTurnStart(withItems([item('a')]))

  expect(claimNow(running, 'a')).toBe(undefined)
  expect(claimNow(withItems([item('a')]), 'a')).not.toBe(undefined)
})

test('claimNow ignores background tasks and the pause, since the person asked for the send', () => {
  const shell = { type: 'shell', description: 'sleep 30' }
  const state = { ...withItems([item('a')]), gate: { ...initialState.gate, backgroundTasks: [shell], paused: 'user' as const } }

  expect(claimNow(state, 'a')).not.toBe(undefined)
})

test('numbers count only queued items: waiting ones and ones flagged as possibly sent', () => {
  const flagged: QueueItem = { ...item('b', 'sending'), maybeSent: true }
  const state = withItems([item('a'), item('x', 'sending'), flagged, item('c')])

  expect(queuedAt(state, 2)?.id).toBe('b')
  expect(queuedAt(state, 3)?.id).toBe('c')
})

test('a move swaps with the neighbour among queued items, and refuses at the edge', () => {
  const state = withItems([item('a'), item('b'), item('c')])

  expect(moveItem(state, 'c', -1)?.items.map(x => x.id)).toEqual(['a', 'c', 'b'])
  expect(moveItem(state, 'a', -1)).toBe(undefined)
})

test('resume clears the pause and returns possibly-sent messages to waiting', () => {
  const flagged: QueueItem = { ...item('a', 'sending'), maybeSent: true }
  const paused = { ...withItems([flagged]), gate: { ...initialState.gate, paused: 'error' as const } }
  const resumed = resume(paused)

  expect(resumed.gate.paused).toBe(undefined)
  expect(resumed.items[0]?.status).toBe('waiting')
  expect(resumed.items[0]?.maybeSent).toBe(undefined)
})

test('an id finds its message, and a position finds the message at that place', () => {
  const state = withItems([item('a'), item('b')])

  expect(findQueued(state, { id: 'b' })?.text).toBe('b')
  expect(findQueued(state, { n: 2 })?.id).toBe('b')
  expect(findQueued(state, { id: 'gone' })).toBe(undefined)
})

test('an edit by id still reaches its message after the message before it is sent mid-edit', () => {
  // The person pre-fills `/queue edit @b <text>`, then message 1 is sent before they press Enter.
  const before = withItems([item('a'), item('b')])
  const afterSend = markSent(claim(before, 'a', false)!, 'a')

  // By id: the edit lands on b, the message it named.
  const byId = findQueued(afterSend, { id: 'b' })
  expect(byId?.id).toBe('b')
  expect(editItem(afterSend, 'b', 'b, edited').items.find(x => x.id === 'b')?.text).toBe('b, edited')

  // By position (the old pre-fill): position 1 is now b, so the edit would land on the wrong text.
  expect(findQueued(afterSend, { n: 1 })?.id).toBe('b')
  expect(findQueued(afterSend, { n: 2 })).toBe(undefined)
})
