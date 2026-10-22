import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import type { QueueItem, QueueState } from '../types'
import { isStale, restoredState, toSaved } from '../hooks/queue'

const DAY = 24 * 60 * 60 * 1000

const presentation = { isFullscreen: false, columns: 80 }

const queue = (args: string) => ({ command: 'queue', args, origin: { kind: 'composer' as const }, presentation })

const shell = { id: 'b1', type: 'shell', status: 'running', description: 'sleep 30', command: 'sleep 30' } as const

const item = (id: string, status: QueueItem['status'] = 'waiting'): QueueItem => ({
  id,
  text: id,
  kind: 'prompt',
  status,
  createdAt: 0,
})

const idle = { mainTurn: 'idle' as const, backgroundTasks: [], awaitingStop: false }

// The queue's $.state, in memory, stubbed as band.test.ts does. `read` and `put` stand in for the value, so the
// compiler does not narrow it after an assignment in the test.
const memoryState = (on: On) => {
  const held: { value: QueueState | undefined; version: number } = { value: undefined, version: 1 }
  on('state.get', () => ({ value: { value: held.value, version: held.version } }))
  on('state.set', (_, e) => {
    if (e.ifVersion !== undefined && e.ifVersion !== held.version) {
      return { value: { isSet: false as const, version: held.version } }
    }
    held.value = e.value as QueueState
    held.version += 1
    return { value: { isSet: true as const, version: held.version } }
  })
  return {
    read: (): QueueState | undefined => held.value,
    put: (value: QueueState | undefined): void => {
      held.value = value
    },
  }
}

// The plugin's $.store, in memory. `failures.sets` makes every write fail, as a full or broken store would, and
// `slowness.ticks` makes each write wait that many turns of the event loop, as a busy disk would.
const memoryStore = (on: On, entries: Record<string, unknown> = {}) => {
  const data = new Map<string, unknown>(Object.entries(entries))
  const failures = { sets: false }
  const slowness = { ticks: 0 }
  on('store.get', (_, e) => ({ value: data.get(e.key) }))
  on('store.set', async (_, e) => {
    if (failures.sets) throw new Error('store is full')
    for (let i = 0; i < slowness.ticks; i++) await Promise.resolve()
    data.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    data.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', () => ({ value: [...data.keys()] }))
  return { data, failures, slowness }
}

// The session id the process reports. A /clear or a /resume moves it to a new one.
const sessionId = (on: On) => {
  const current = { id: 'old' }
  on('session.id', () => ({ value: current.id }))
  return current
}

// The answers beneath the plugin: no agents, no Stop blocked, and the session's own register, start and end.
const answerEngine = (on: On) => {
  on('agent.list', () => ({ value: [] }))
  on('classic.Stop', () => ({}))
  on('command.register', () => ({ value: { command: 'queue' } }))
  on('session.start', () => ({ cwd: '/tmp' }))
  on('session.end', () => ({ sessionId: 'old' }))
}

// Records the prompts that reach the model.
const answerPrompts = (on: On, sent: string[]) => {
  on('prompt.submit', (_, e) => {
    if (e.command === undefined) sent.push(e.text)
    return { text: e.text }
  })
}

// The session's start, with the input fields the queue does not read.
const start = { cwd: '/tmp', surface: null, isInteractive: false } as never

// The session ends with a /clear or a /resume. The event comes under the old id, before the switch.
const clearedOld = { reason: 'clear' as const, sessionId: 'old', resume: { id: 'old' } }
const resumedOld = { reason: 'resume' as const, sessionId: 'old', resume: { id: 'old' } }

// Lets the saves that hooks started finish. A save runs on the store after the write that made it, so the test
// advances the clock a few times; the plugin's own save chain is not reachable from here.
const settle = async (clock: { advance: (ms: number) => Promise<void> }) => {
  for (let i = 0; i < 5; i++) await clock.advance(0)
}

test('toSaved keeps nothing when nothing is queued and no pause is set, and keeps a pause the person chose', () => {
  expect(toSaved({ items: [item('a', 'sent')], gate: idle, removedIds: [] }, 1)).toBeUndefined()

  const paused = { items: [], gate: { ...idle, paused: 'user' as const }, removedIds: ['x'] }
  expect(toSaved(paused, 1)).toMatchObject({ savedAt: 1, paused: 'user', removedIds: ['x'] })
})

test('toSaved keeps the messages still to go and drops the sent ones', () => {
  const saved = toSaved({ items: [item('a', 'sent'), item('b'), item('c', 'sending')], gate: idle }, 1)
  expect(saved?.items.map(x => x.id)).toEqual(['b', 'c'])
})

test('restoredState flags a message mid-send, resets the gate and pauses as restored', () => {
  const restored = restoredState({
    savedAt: 1,
    items: [item('a', 'sending'), item('b')],
    removedIds: [],
    paused: undefined,
  })

  expect(restored?.items).toEqual([{ ...item('a', 'sending'), maybeSent: true }, item('b')])
  expect(restored?.gate).toEqual({ mainTurn: 'idle', backgroundTasks: [], awaitingStop: false, paused: 'restored' })
})

test('restoredState keeps a pause the person chose, and restores nothing when nothing is queued', () => {
  expect(restoredState({ savedAt: 1, items: [item('a')], paused: 'user' })?.gate.paused).toBe('user')
  expect(restoredState({ savedAt: 1, items: [item('a', 'sent')] })).toBeUndefined()
  expect(restoredState({ savedAt: 1, items: [] })).toBeUndefined()
})

test('a saved queue is stale only after 7 days', () => {
  expect(isStale({ savedAt: 0, items: [] }, 7 * DAY)).toBe(false)
  expect(isStale({ savedAt: 0, items: [] }, 7 * DAY + 1)).toBe(true)
})

test('a fresh start restores the saved queue paused, flags a message mid-send, and drops the background wait', async ($, on) => {
  const clock = mock.clock(on)
  const state = memoryState(on)
  const store = memoryStore(on, {
    'session:old': { savedAt: Date.now(), items: [item('a', 'sending'), item('b')], removedIds: ['z'] },
  })
  sessionId(on)
  answerEngine(on)
  await $.session.start(start)
  await clock.advance(0)
  await settle(clock)

  expect(state.read()?.gate).toEqual({ mainTurn: 'idle', backgroundTasks: [], awaitingStop: false, paused: 'restored' })
  expect(state.read()?.items).toEqual([{ ...item('a', 'sending'), maybeSent: true }, item('b')])
  expect(store.data.get('session:old')).toMatchObject({ items: [{ id: 'a' }, { id: 'b' }] })
})

test('a start with an empty store, or an entry with nothing queued, restores nothing', async ($, on) => {
  const clock = mock.clock(on)
  const state = memoryState(on)
  memoryStore(on, { 'session:old': { savedAt: Date.now(), items: [item('a', 'sent')] } })
  sessionId(on)
  answerEngine(on)
  await $.session.start(start)
  await clock.advance(0)

  expect(state.read()).toBeUndefined()
})

test('a start with the queue already in state does not restore over it', async ($, on) => {
  const clock = mock.clock(on)
  const state = memoryState(on)
  state.put({ items: [item('live')], gate: idle })
  memoryStore(on, { 'session:old': { savedAt: Date.now(), items: [item('stale')] } })
  sessionId(on)
  answerEngine(on)
  await $.session.start(start)
  await clock.advance(0)

  expect(state.read()?.items.map(x => x.id)).toEqual(['live'])
})

test('a start with $.state present but empty does not restore a saved copy over it', async ($, on) => {
  const clock = mock.clock(on)
  const state = memoryState(on)
  // A reload between a write and its save: the state has no items, and the saved copy still holds them.
  state.put({ items: [], gate: idle })
  memoryStore(on, { 'session:old': { savedAt: Date.now(), items: [item('sent-now')] } })
  sessionId(on)
  answerEngine(on)
  await $.session.start(start)
  await clock.advance(0)

  expect(state.read()?.items).toEqual([])
  expect(state.read()?.gate.paused).toBe(undefined)
})

test('a saved queue older than 7 days is dropped at start and not restored', async ($, on) => {
  const clock = mock.clock(on)
  const state = memoryState(on)
  const store = memoryStore(on, { 'session:old': { savedAt: Date.now() - 8 * DAY, items: [item('a')] } })
  sessionId(on)
  answerEngine(on)
  await $.session.start(start)
  await clock.advance(0)

  expect(state.read()).toBeUndefined()
  expect(store.data.has('session:old')).toBe(false)
})

test('a saved user pause stays user after a restart', async ($, on) => {
  const clock = mock.clock(on)
  const state = memoryState(on)
  memoryStore(on, { 'session:old': { savedAt: Date.now(), items: [item('a')], paused: 'user' } })
  sessionId(on)
  answerEngine(on)
  await $.session.start(start)
  await clock.advance(0)

  expect(state.read()?.gate.paused).toBe('user')
})

test('a write saves the queue under the session, and removing the last message deletes the key', async ($, on) => {
  const clock = mock.clock(on)
  memoryState(on)
  const store = memoryStore(on)
  sessionId(on)
  answerEngine(on)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [shell] })
  await $.command.run(queue('kept'))
  await clock.advance(0)
  await settle(clock)
  expect(store.data.get('session:old')).toMatchObject({ items: [{ text: 'kept' }] })

  await $.command.run(queue('rm 1'))
  await settle(clock)
  expect(store.data.has('session:old')).toBe(false)
})

test('emptying a restored queue ends its pause, and resume sends the first message on the next idle drain', async ($, on) => {
  const clock = mock.clock(on)
  const state = memoryState(on)
  memoryStore(on, { 'session:old': { savedAt: Date.now(), items: [item('a'), item('b')] } })
  sessionId(on)
  const sent: string[] = []
  answerPrompts(on, sent)
  answerEngine(on)
  await $.session.start(start)
  await clock.advance(0)
  expect(state.read()?.gate.paused).toBe('restored')

  await $.command.run(queue('clear'))
  expect(state.read()?.gate.paused).toBe(undefined)

  await $.command.run(queue('a'))
  await $.command.run(queue('resume'))
  await clock.advance(0)
  expect(sent).toEqual(['a'])
})

test('a failing store write does not break /queue', async ($, on) => {
  const clock = mock.clock(on)
  const state = memoryState(on)
  const store = memoryStore(on)
  store.failures.sets = true
  sessionId(on)
  answerEngine(on)
  await clock.advance(0)

  const reply = await $.command.run(queue('still works'))
  await settle(clock)
  expect(reply.text).toMatch(/^Queued @[a-z0-9]{4}: still works$/)
  expect(state.read()?.items.map(x => x.text)).toEqual(['still works'])
})

test('a /clear restores the queue under the new session id, paused, and deletes the old key', async ($, on) => {
  const clock = mock.clock(on)
  const state = memoryState(on)
  const store = memoryStore(on)
  const session = sessionId(on)
  answerEngine(on)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [shell] })
  await $.command.run(queue('kept'))
  await clock.advance(0)

  await $.session.end(clearedOld) // the event comes under the old id
  state.put(undefined) // $.state is empty once the id has switched
  await clock.advance(1000) // still the old id: the timer waits again, and restores nothing
  expect(state.read()).toBeUndefined()

  session.id = 'new'
  await clock.advance(1000)
  await settle(clock)

  expect(state.read()?.items.map(x => x.text)).toEqual(['kept'])
  expect(state.read()?.gate.paused).toBe('restored')
  expect(state.read()?.gate.backgroundTasks).toEqual([])
  expect(store.data.has('session:old')).toBe(false)
  expect(store.data.get('session:new')).toMatchObject({ items: [{ text: 'kept' }] })
})

test('a /clear restores once: the timer and a fallback both run, and only the first one restores', async ($, on) => {
  const clock = mock.clock(on)
  const state = memoryState(on)
  const store = memoryStore(on)
  const session = sessionId(on)
  answerEngine(on)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [shell] })
  await $.command.run(queue('kept'))
  await clock.advance(0)

  await $.session.end(clearedOld)
  state.put(undefined)
  session.id = 'new'
  await $.command.run(queue('next')) // the fallback restores `kept`, then queues `next`
  expect(state.read()?.items.map(x => x.text)).toEqual(['kept', 'next'])

  // An old entry put back under the old key, then the queue emptied: the timer must not bring it back.
  store.data.set('session:old', { savedAt: Date.now(), items: [item('stale')] })
  await $.command.run(queue('clear'))
  await clock.advance(1000)

  expect(state.read()?.items).toEqual([])
})

test('a /clear leaves the saved copy alone when the queue already holds messages', async ($, on) => {
  const clock = mock.clock(on)
  const state = memoryState(on)
  const store = memoryStore(on)
  const session = sessionId(on)
  answerEngine(on)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [shell] })
  await $.command.run(queue('kept'))
  await clock.advance(0)

  await $.session.end(clearedOld)
  state.put({ items: [item('typed')], gate: idle })
  session.id = 'new'
  await clock.advance(1000)
  await settle(clock)

  expect(state.read()?.items.map(x => x.text)).toEqual(['typed'])
  expect(store.data.get('session:old')).toMatchObject({ items: [{ text: 'kept' }] })
})

test('a /resume restores from the new id’s own key, paused, and deletes nothing', async ($, on) => {
  const clock = mock.clock(on)
  const state = memoryState(on)
  const store = memoryStore(on, {
    'session:old': { savedAt: Date.now(), items: [item('left-behind')] },
    'session:new': { savedAt: Date.now(), items: [item('theirs')] },
  })
  const session = sessionId(on)
  answerEngine(on)

  await $.session.end(resumedOld)
  state.put(undefined)
  await clock.advance(1000) // still the old id
  expect(state.read()).toBeUndefined()

  session.id = 'new'
  await clock.advance(1000)
  await settle(clock)

  expect(state.read()?.items.map(x => x.text)).toEqual(['theirs'])
  expect(state.read()?.gate.paused).toBe('restored')
  expect(store.data.has('session:old')).toBe(true)
})

test('a session end waits for the last save, so a message queued just before /exit is kept', async ($, on) => {
  const clock = mock.clock(on)
  memoryState(on)
  const store = memoryStore(on)
  store.slowness.ticks = 100
  sessionId(on)
  answerEngine(on)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [shell] })
  await $.command.run(queue('last'))
  await $.session.end({ reason: 'prompt_input_exit', sessionId: 'old', resume: { id: 'old' } })

  expect(store.data.get('session:old')).toMatchObject({ items: [{ text: 'last' }] })
})

test('a switch whose id never changes gives up after 5 tries, and a later fallback restores nothing', async ($, on) => {
  const clock = mock.clock(on)
  const state = memoryState(on)
  memoryStore(on, { 'session:new': { savedAt: Date.now(), items: [item('theirs')] } })
  const session = sessionId(on)
  answerEngine(on)

  await $.session.end(resumedOld)
  for (let i = 0; i < 5; i++) await clock.advance(1000)

  // Had the switch still been pending, this /queue would bring `theirs` in first.
  session.id = 'new'
  state.put(undefined)
  await $.command.run(queue('list'))
  await clock.advance(1000)
  expect(state.read()).toBeUndefined()
})
