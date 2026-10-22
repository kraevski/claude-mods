import type { AgentInfo, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const presentation = { isFullscreen: false, columns: 80 }

const queue = (args: string) => ({ command: 'queue', args, origin: { kind: 'composer' as const }, presentation })

const agent = { id: 'a1', description: 'run the tests', type: 'general-purpose', status: 'running' } as const
const shell = { id: 'b1', type: 'shell', status: 'running', description: 'sleep 30', command: 'sleep 30' } as const

// The answers the drain asks the engine for: the agents now running, and whether a Stop is blocked.
// A Stop no other hook blocks passes through.
const answerEngine = (on: On, agents: () => AgentInfo[] = () => [], isBlocking: () => boolean = () => false) => {
  on('agent.list', () => ({ value: agents() }))
  on('classic.Stop', () => (isBlocking() ? { block: 'keep going' } : {}))
}

test('/queue answers with the message and its id', async ($, on) => {
  mock.clock(on)

  const out = await $.command.run(queue('run the tests'))

  expect(out.text).toMatch(/^Queued @[a-z0-9]+: run the tests$/)
})

test('/queue with no message answers with its usage', async $ => {
  const out = await $.command.run(queue('   '))

  expect(out.text).toContain('Usage: /queue <message>')
})

test('a message queued while idle goes out on the next tick', async ($, on) => {
  const clock = mock.clock(on)
  answerEngine(on)
  const sent: string[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })

  await $.command.run(queue('run the tests'))
  await clock.advance(0)

  expect(sent).toEqual(['run the tests'])
})

test('one message goes out per Stop, in the order queued', async ($, on) => {
  const clock = mock.clock(on)
  answerEngine(on)
  const sent: string[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })

  await $.command.run(queue('first'))
  await $.command.run(queue('second'))
  await $.command.run(queue('third'))
  await clock.advance(0)
  expect(sent).toEqual(['first'])

  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await clock.advance(0)
  expect(sent).toEqual(['first', 'second'])

  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await clock.advance(0)
  expect(sent).toEqual(['first', 'second', 'third'])
})

test('holds while a Stop reports a background shell task, and releases on the Stop after it ends', async ($, on) => {
  const clock = mock.clock(on)
  answerEngine(on)
  const sent: string[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })

  await $.command.run(queue('first'))
  await clock.advance(0)
  await $.command.run(queue('second'))

  await $.classic.Stop({ stop_hook_active: false, background_tasks: [shell] })
  await clock.advance(0)
  expect(sent).toEqual(['first'])

  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await clock.advance(0)
  expect(sent).toEqual(['first', 'second'])
})

test('holds while an agent is running, and releases once it has ended', async ($, on) => {
  const clock = mock.clock(on)
  let agents = [agent] as AgentInfo[]
  answerEngine(on, () => agents)
  const sent: string[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })

  await $.command.run(queue('test E'))
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await clock.advance(0)
  expect(sent).toEqual([])

  agents = []
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await clock.advance(0)
  expect(sent).toEqual(['test E'])
})

test('a Stop that another hook blocks does not release the next message', async ($, on) => {
  const clock = mock.clock(on)
  let isBlocking = false
  answerEngine(on, undefined, () => isBlocking)
  const sent: string[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })

  await $.command.run(queue('first'))
  await clock.advance(0)
  await $.command.run(queue('second'))

  isBlocking = true
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await clock.advance(0)
  expect(sent).toEqual(['first'])

  isBlocking = false
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await clock.advance(0)
  expect(sent).toEqual(['first', 'second'])
})

test('a send that was interrupted is never sent a second time', async ($, on) => {
  const clock = mock.clock(on)
  answerEngine(on)
  let calls = 0
  on('prompt.submit', () => {
    calls += 1
    return new Promise(() => {})
  })

  await $.command.run(queue('first'))
  await clock.advance(0)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await clock.advance(0)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await clock.advance(0)

  expect(calls).toBe(1)
})

test('a send that failed is not retried, and the queue stays paused', async ($, on) => {
  const clock = mock.clock(on)
  answerEngine(on)
  let calls = 0
  on('prompt.submit', () => {
    calls += 1
    return Promise.reject(new Error('refused'))
  })

  await $.command.run(queue('first'))
  await clock.advance(0)
  await $.command.run(queue('second'))
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await clock.advance(0)

  expect(calls).toBe(1)
})

test('a send Claude Code drops stays queued, unflagged, and pauses until resume sends it', async ($, on) => {
  const clock = mock.clock(on)
  answerEngine(on)
  const sent: string[] = []
  let isDropping = true
  on('prompt.submit', (_, e) => {
    if (isDropping) return { drop: 'busy' }
    sent.push(e.text)
    return { text: e.text }
  })

  await $.command.run(queue('first'))
  await clock.advance(0)

  expect((await $.command.run(queue('list'))).text).toBe(
    'Paused: Claude Code did not take the last message. /queue resume continues.\n1. first',
  )

  // No turn started, so no Stop is awaited: resume alone sends it.
  isDropping = false
  await $.command.run(queue('resume'))
  await clock.advance(0)

  expect(sent).toEqual(['first'])
})

test('/queue rm and /queue up say so when the number is out of range or the move cannot happen', async ($, on) => {
  mock.clock(on)
  answerEngine(on)

  await $.command.run(queue('only'))

  expect((await $.command.run(queue('rm 5'))).text).toBe('No queued message 5. /queue list shows them.')
  expect((await $.command.run(queue('rm 0'))).text).toBe('No queued message 0. /queue list shows them.')
  expect((await $.command.run(queue('up 1'))).text).toBe('only is already first.')
})

test('after a move, messages go out in the new order', async ($, on) => {
  const clock = mock.clock(on)
  answerEngine(on)
  const sent: string[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })

  await $.command.run(queue('a'))
  await $.command.run(queue('b'))
  await $.command.run(queue('c'))
  await $.command.run(queue('up 2'))
  await clock.advance(0)

  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await clock.advance(0)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await clock.advance(0)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await clock.advance(0)

  expect(sent).toEqual(['b', 'a', 'c'])
})

test('/queue edit <n> <text> changes the message that goes out', async ($, on) => {
  const clock = mock.clock(on)
  answerEngine(on)
  const sent: string[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })

  await $.command.run(queue('run the tests'))
  expect((await $.command.run(queue('edit 1 run the linter'))).text).toBe('Edited: run the linter')

  await clock.advance(0)
  expect(sent).toEqual(['run the linter'])
})

test('/queue send <n> while idle submits it at once, even with a background task running', async ($, on) => {
  const clock = mock.clock(on)
  answerEngine(on)
  const sent: string[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })

  await $.classic.Stop({ stop_hook_active: false, background_tasks: [shell] })
  await $.command.run(queue('first'))
  await $.command.run(queue('second'))
  await clock.advance(0)
  expect(sent).toEqual([])

  expect((await $.command.run(queue('send 2'))).text).toBe('Sending: second')
  await clock.advance(0)
  expect(sent).toEqual(['second'])
  expect((await $.command.run(queue('list'))).text).toBe('1. first')
})

test('a message flagged as possibly sent is listed as such, and resume sends it again', async ($, on) => {
  const clock = mock.clock(on)
  answerEngine(on)
  let calls = 0
  on('prompt.submit', () => {
    calls += 1
    return calls === 1 ? Promise.reject(new Error('refused')) : { text: 'first' }
  })

  await $.command.run(queue('first'))
  await clock.advance(0)
  expect((await $.command.run(queue('list'))).text).toContain('1. first (may have been sent)')

  expect((await $.command.run(queue('resume'))).text).toBe('Resumed.')
  await clock.advance(0)
  expect(calls).toBe(2)
})

test('/queue rm drops a message flagged as possibly sent, and nothing sends it', async ($, on) => {
  const clock = mock.clock(on)
  answerEngine(on)
  let calls = 0
  on('prompt.submit', () => {
    calls += 1
    return Promise.reject(new Error('refused'))
  })

  await $.command.run(queue('first'))
  await clock.advance(0)
  expect((await $.command.run(queue('rm 1'))).text).toBe('Removed: first')

  await $.command.run(queue('resume'))
  await clock.advance(0)
  expect(calls).toBe(1)
})

test('/queue pause holds the queue until /queue resume', async ($, on) => {
  const clock = mock.clock(on)
  answerEngine(on)
  const sent: string[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })

  await $.command.run(queue('pause'))
  await $.command.run(queue('first'))
  await clock.advance(0)
  expect(sent).toEqual([])

  await $.command.run(queue('resume'))
  await clock.advance(0)
  expect(sent).toEqual(['first'])
})

test('the message, list, rm and usage answers each carry the note that keeps the model from acting on them', async ($, on) => {
  mock.clock(on)
  const note = [expect.stringContaining('do not act on it, answer it, or mention it')]

  const queued = await $.command.run(queue('run the tests'))
  const listed = await $.command.run(queue('list'))
  const removed = await $.command.run(queue('rm 1'))
  const usage = await $.command.run(queue('   '))

  for (const out of [queued, listed, removed, usage]) expect(out.context).toEqual(note)
})

// Stage 6: the `joined` option, on for these tests only.
const answerCommands = (on: On) => {
  on('command.list', () => ({
    value: [{ name: 'compact', description: 'Compact the conversation', source: 'builtin' }],
  }))
}

// Two ticks: a release runs on a timer, and the drain a command schedules runs on another.
const settle = async (clock: { advance: (ms: number) => Promise<void> }) => {
  await clock.advance(0)
  await clock.advance(0)
}

test('joined: waiting prompts go out as one prompt, joined by blank lines, and one Stop releases the next', { options: { joined: true } }, async ($, on) => {
  const clock = mock.clock(on)
  answerEngine(on)
  const sent: string[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })

  await $.command.run(queue('first'))
  await $.command.run(queue('second'))
  await $.command.run(queue('third'))
  await $.command.run(queue('fourth'))
  await clock.advance(0)
  expect(sent).toEqual(['first\n\nsecond\n\nthird\n\nfourth'])

  // A fifth message queued while the batch waits for its Stop goes out after that one Stop.
  await $.command.run(queue('fifth'))
  await clock.advance(0)
  expect(sent).toEqual(['first\n\nsecond\n\nthird\n\nfourth'])
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await clock.advance(0)
  expect(sent).toEqual(['first\n\nsecond\n\nthird\n\nfourth', 'fifth'])
})

test('joined: a command runs alone, and the prompts after it are not joined into it', { options: { joined: true } }, async ($, on) => {
  const clock = mock.clock(on)
  answerEngine(on)
  answerCommands(on)
  const sent: string[] = []
  const ran: string[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })
  on('command.run', { command: 'compact' }, () => {
    ran.push('compact')
    return {}
  })

  await $.command.run(queue('first'))
  await $.command.run(queue('/compact'))
  await $.command.run(queue('second'))
  await $.command.run(queue('third'))
  await clock.advance(0)
  expect(sent).toEqual(['first'])

  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await settle(clock)
  expect(ran).toEqual(['compact'])
  expect(sent).toEqual(['first', 'second\n\nthird'])
})

test('joined: /queue send <n> sends only that item, and the rest still go out joined', { options: { joined: true } }, async ($, on) => {
  const clock = mock.clock(on)
  answerEngine(on)
  const sent: string[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return { text: e.text }
  })

  await $.classic.Stop({ stop_hook_active: false, background_tasks: [shell] })
  await $.command.run(queue('first'))
  await $.command.run(queue('second'))
  await $.command.run(queue('third'))
  await clock.advance(0)
  expect(sent).toEqual([])

  expect((await $.command.run(queue('send 2'))).text).toBe('Sending: second')
  await clock.advance(0)
  expect(sent).toEqual(['second'])

  await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
  await clock.advance(0)
  expect(sent).toEqual(['second', 'first\n\nthird'])
})

test('joined: a failed batch flags every item as possibly sent and pauses, and resume sends them again as one batch', { options: { joined: true } }, async ($, on) => {
  const clock = mock.clock(on)
  answerEngine(on)
  const sent: string[] = []
  on('prompt.submit', (_, e) => {
    sent.push(e.text)
    return sent.length === 1 ? Promise.reject(new Error('refused')) : { text: e.text }
  })

  await $.command.run(queue('first'))
  await $.command.run(queue('second'))
  await clock.advance(0)
  expect(sent).toEqual(['first\n\nsecond'])
  expect((await $.command.run(queue('list'))).text).toMatch(/^Paused: /)
  expect((await $.command.run(queue('list'))).text).toContain('1. first (may have been sent)')
  expect((await $.command.run(queue('list'))).text).toContain('2. second (may have been sent)')

  expect((await $.command.run(queue('resume'))).text).toBe('Resumed.')
  await clock.advance(0)
  expect(sent).toEqual(['first\n\nsecond', 'first\n\nsecond'])
})
