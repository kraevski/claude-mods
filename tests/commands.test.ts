import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import type { QueueItem } from '../types'
import {
  add,
  claim,
  clearQueued,
  initialState,
  markCommandDone,
  markCommandFailed,
  markCommandTurn,
  onStop,
  onTurnComplete,
  onTurnStart,
  resume,
} from '../hooks/queue'

const presentation = { isFullscreen: false, columns: 80 }

const queue = (args: string) => ({ command: 'queue', args, origin: { kind: 'composer' as const }, presentation })

const item = (id: string, kind: QueueItem['kind'] = 'prompt'): QueueItem => ({
  id,
  text: id,
  kind,
  status: 'waiting',
  createdAt: 0,
})

const commandItem = (id: string, text: string): QueueItem => ({ ...item(id, 'command'), text })

// Only `compact` and `model` exist in this session, so `/nope-xyz` is unknown.
const answerCommands = (on: On) => {
  on('command.list', () => ({
    value: [
      { name: 'compact', description: 'Compact the conversation', source: 'builtin' },
      { name: 'model', description: 'Change the model', source: 'builtin' },
    ],
  }))
}

// The drain's Stop check: no agents, and no Stop blocked.
const answerEngine = (on: On) => {
  on('agent.list', () => ({ value: [] }))
  on('classic.Stop', () => ({}))
}

// Records the prompts that reach the model. A submission that runs a command is not a prompt, so it is not recorded.
const answerPrompts = (on: On, sent: string[]) => {
  on('prompt.submit', (_, e) => {
    if (e.command === undefined) sent.push(e.text)
    return { text: e.text }
  })
}

// Two ticks: a release runs on a timer, and the drain it schedules after a command runs on another.
const settle = async (clock: { advance: (ms: number) => Promise<void> }) => {
  await clock.advance(0)
  await clock.advance(0)
}

test('a command with no turn started is marked sent when it resolves, and the drain goes on', async ($, on) => {
  const clock = mock.clock(on)
  answerEngine(on)
  answerCommands(on)
  const sent: string[] = []
  const ran: string[] = []
  answerPrompts(on, sent)
  on('command.run', { command: 'compact' }, () => {
    ran.push('compact')
    return {}
  })

  await $.command.run(queue('/compact'))
  await $.command.run(queue('say hi'))
  await settle(clock)

  expect(ran).toEqual(['compact'])
  expect(sent).toEqual(['say hi'])
})

test('a command that starts a turn holds the queue until that turn ends with a Stop', async ($, on) => {
  const clock = mock.clock(on)
  answerEngine(on)
  answerCommands(on)
  const sent: string[] = []
  answerPrompts(on, sent)
  let finish = () => {}
  on('command.run', { command: 'compact' }, () => new Promise(resolve => (finish = () => resolve({}))))

  await $.command.run(queue('/compact'))
  await $.command.run(queue('say hi'))
  await settle(clock)
  // The command's turn raises prompt.submit while the command is still running.
  await $.prompt.submit({ text: '/compact', wait: false, origin: { kind: 'plugin', name: 'test' }, command: { name: 'compact', args: '' } })
  finish()
  await settle(clock)
  expect(sent).toEqual([])

  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await settle(clock)
  expect(sent).toEqual(['say hi'])
})

test('a prompt.submit for another command does not hold the queue after a command that started no turn', async ($, on) => {
  const clock = mock.clock(on)
  answerEngine(on)
  answerCommands(on)
  const sent: string[] = []
  answerPrompts(on, sent)
  let finish = () => {}
  on('command.run', { command: 'compact' }, () => new Promise(resolve => (finish = () => resolve({}))))

  await $.command.run(queue('/compact'))
  await $.command.run(queue('say hi'))
  await settle(clock)
  await $.prompt.submit({ text: '/model', wait: false, origin: { kind: 'plugin', name: 'test' }, command: { name: 'model', args: '' } })
  finish()
  await settle(clock)

  expect(sent).toEqual(['say hi'])
})

test('a text starting with a slash is queued as a command, and other text as a prompt', async ($, on) => {
  const clock = mock.clock(on)
  answerEngine(on)
  answerCommands(on)
  const sent: string[] = []
  const ran: string[] = []
  answerPrompts(on, sent)
  on('command.run', { command: 'model' }, (_, e) => {
    ran.push(e.args ?? '')
    return {}
  })

  await $.command.run(queue('/model sonnet'))
  await settle(clock)

  expect(ran).toEqual(['sonnet'])
  expect(sent).toEqual([])
})

test('a command this session does not have is refused at queue time, and nothing is queued', async ($, on) => {
  mock.clock(on)
  answerCommands(on)

  const out = await $.command.run(queue('/nope-xyz'))

  expect(out.text).toBe('No command /nope-xyz. The message was not queued.')
  expect((await $.command.run(queue('list'))).text).toBe('The queue is empty.')
})

test('/queue refuses to queue a /queue command', async ($, on) => {
  mock.clock(on)
  answerCommands(on)

  const out = await $.command.run(queue('/queue /compact'))

  expect(out.text).toBe('The queue cannot hold a /queue command. The message was not queued.')
  expect((await $.command.run(queue('list'))).text).toBe('The queue is empty.')
})

test('a command that is refused when it runs pauses the queue, and the next message does not go out', async ($, on) => {
  const clock = mock.clock(on)
  answerEngine(on)
  answerCommands(on)
  const sent: string[] = []
  answerPrompts(on, sent)
  on('command.run', { command: 'compact' }, () => Promise.reject(new Error('refused')))

  await $.command.run(queue('/compact'))
  await $.command.run(queue('say hi'))
  await settle(clock)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await settle(clock)

  expect(sent).toEqual([])
  expect((await $.command.run(queue('list'))).text).toMatch(/^Paused: /)
})

test('a command started with an empty queue, then a message queued after it, sends once the command ends', async ($, on) => {
  const clock = mock.clock(on)
  answerEngine(on)
  answerCommands(on)
  const sent: string[] = []
  answerPrompts(on, sent)
  on('command.run', { command: 'model' }, () => ({}))

  await $.command.run(queue('/model opus'))
  await settle(clock)
  await $.command.run(queue('say hi'))
  await settle(clock)

  expect(sent).toEqual(['say hi'])
})

test('a turn that the model refused pauses the queue when something is waiting', () => {
  const waiting = add(initialState, item('a'))
  const refused = onTurnComplete(waiting, { isAborted: false, reason: 'refusal' })

  expect(refused.gate.paused).toBe('refusal')
  expect(refused.gate.awaitingStop).toBe(false)
})

test('a refused turn with nothing queued does not pause, so the next message is not started paused', () => {
  const refused = onTurnComplete(initialState, { isAborted: false, reason: 'refusal' })

  expect(refused.gate.paused).toBe(undefined)
})

test('emptying the queue releases a refusal pause', () => {
  const refused = onTurnComplete(add(initialState, item('a')), { isAborted: false, reason: 'refusal' })
  const cleared = clearQueued(refused)

  expect(cleared.gate.paused).toBe(undefined)
  expect(claim(add(cleared, item('next')), 'next', false)).not.toBe(undefined)
})

test('a prompt.submit marks the command being sent when its name matches, and no other submission', () => {
  const sending = claim(add(initialState, commandItem('c', '/compact')), 'c', false)!

  expect(markCommandTurn(sending, 'compact')?.gate.commandTurn).toBe(true)
  expect(markCommandTurn(sending, 'model')).toBe(undefined)
  expect(markCommandTurn(sending, undefined)).toBe(undefined)
  expect(markCommandTurn(add(initialState, commandItem('c', '/compact')), 'compact')).toBe(undefined)
})

test('a command that failed to run goes back to waiting and pauses the queue for the command, not as an error', () => {
  const sending = claim(add(initialState, commandItem('c', '/compact')), 'c', false)!
  const failed = markCommandFailed(add(sending, item('n')), 'c')

  expect(failed.items[0]).toMatchObject({ id: 'c', status: 'waiting' })
  expect(failed.items[0]?.maybeSent).toBe(undefined)
  expect(failed.gate.paused).toBe('command')
  expect(failed.gate.awaitingStop).toBe(false)
})

test('resuming after a failed command retries it first, and removing it releases the pause', () => {
  const failed = markCommandFailed(claim(add(initialState, commandItem('c', '/compact')), 'c', false)!, 'c')

  const resumed = resume(failed)
  expect(claim(resumed, 'c', false)).not.toBe(undefined)

  const cleared = clearQueued(failed)
  expect(cleared.gate.paused).toBe(undefined)
})

test('a command that started a turn keeps the wait for its Stop, and one that started none ends its send at once', () => {
  const sending = claim(add(initialState, commandItem('c', '/compact')), 'c', false)!

  const noTurn = markCommandDone(sending, 'c')
  expect(noTurn.gate.awaitingStop).toBe(false)
  expect(noTurn.items[0]?.status).toBe('sent')

  const withTurn = markCommandDone(markCommandTurn(sending, 'compact')!, 'c')
  expect(withTurn.gate.awaitingStop).toBe(true)
  expect(withTurn.gate.commandTurn).toBe(undefined)
  expect(withTurn.items[0]?.status).toBe('sent')
})

test('a Stop ends the command turn mark, so the next command starts unmarked', () => {
  const sending = claim(add(initialState, commandItem('c', '/compact')), 'c', false)!
  const marked = markCommandTurn(sending, 'compact')!

  expect(onStop(marked, []).gate.commandTurn).toBe(undefined)
  expect(onStop(marked, []).gate.awaitingStop).toBe(false)
})

test('onTurnStart marks the main turn running', () => {
  expect(onTurnStart(initialState).gate.mainTurn).toBe('running')
})
