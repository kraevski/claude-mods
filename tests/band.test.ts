import type { AgentInfo, On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import type { QueueState } from '../types'

const presentation = { isFullscreen: false, columns: 80 }

const queue = (args: string) => ({ command: 'queue', args, origin: { kind: 'composer' as const }, presentation })

const shell = { id: 'b1', type: 'shell', status: 'running', description: 'sleep 30', command: 'sleep 30' } as const

// The answers the drain asks the engine for. Counts the calls, so a test can check a redraw made none.
const answerEngine = (on: On, agents: () => AgentInfo[] = () => []) => {
  const calls = { agentList: 0 }
  on('agent.list', () => {
    calls.agentList += 1
    return { value: agents() }
  })
  on('classic.Stop', () => ({}))
  return calls
}

// The props the band is drawn with: a quiet, one-screen band.
const bandProps = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 12 },
  view: {},
} as never

// Finds the key of the first Button with this label.
const buttonKey = async (ui: { findAll: (q: { type: string }) => Promise<{ key?: string; props: Record<string, unknown> }[]> }, label: string) => {
  const found = (await ui.findAll({ type: 'Button' })).find(x => x.props.label === label)
  if (found?.key === undefined) throw new Error(`no ${label} button`)
  return found.key
}

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the band lists the queue and Remove drops a message by key on ${surface}`, async ($, on) => {
    const clock = mock.clock(on)
    answerEngine(on)
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [shell] })
    await $.command.run(queue('first'))
    await $.command.run(queue('second'))
    await clock.advance(0)

    const ui = await $.ui.mount({ plugin: 'queue', surface, component: 'AbovePrompt', props: bandProps })
    expect(await ui.find({ type: 'Text', text: /^2 waiting · waiting for 1 background task$/ })).toBeDefined()
    expect((await ui.find({ type: 'Text', text: 'first' }))?.props.wrap).toBe('truncate-end')

    await ui.press({ key: await buttonKey(ui, 'Remove') })
    expect(await ui.find({ type: 'Text', text: /^1 waiting · waiting for 1 background task$/ })).toBeDefined()
    await ui.unmount()
  })

  test(`Send submits the message at once while idle, even with a background task, on ${surface}`, async ($, on) => {
    const clock = mock.clock(on)
    answerEngine(on)
    const sent: string[] = []
    on('prompt.submit', (_, e) => {
      sent.push(e.text)
      return { text: e.text }
    })
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [shell] })
    await $.command.run(queue('send me'))
    await clock.advance(0)
    expect(sent).toEqual([])

    const ui = await $.ui.mount({ plugin: 'queue', surface, component: 'AbovePrompt', props: bandProps })
    await ui.press({ key: await buttonKey(ui, 'Send now') })
    await clock.advance(0)

    expect(sent).toEqual(['send me'])
    await ui.unmount()
  })

  test(`Resume is offered while paused, and sends the held message on ${surface}`, async ($, on) => {
    const clock = mock.clock(on)
    answerEngine(on)
    const sent: string[] = []
    on('prompt.submit', (_, e) => {
      sent.push(e.text)
      return { text: e.text }
    })
    await $.command.run(queue('pause'))
    await $.command.run(queue('held'))
    await clock.advance(0)
    expect(sent).toEqual([])

    const ui = await $.ui.mount({ plugin: 'queue', surface, component: 'AbovePrompt', props: bandProps })
    await ui.press({ key: await buttonKey(ui, 'Resume') })
    await clock.advance(0)

    expect(sent).toEqual(['held'])
    await ui.unmount()
  })

  test(`drawing the band calls no engine answers on ${surface}`, async ($, on) => {
    const clock = mock.clock(on)
    const calls = answerEngine(on)
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [shell] })
    await $.command.run(queue('first'))
    await clock.advance(0)
    const before = calls.agentList

    const ui = await $.ui.mount({ plugin: 'queue', surface, component: 'AbovePrompt', props: bandProps })
    expect(calls.agentList).toBe(before)
    await ui.unmount()
  })
}

test('two messages with the same text draw their own reply rows, each with its own state', async ($, on) => {
  const clock = mock.clock(on)
  answerEngine(on)
  on('prompt.submit', (_, e) => ({ text: e.text }))

  // The first same-text message goes out on the idle tick; the second waits behind a background task.
  const first = await $.command.run(queue('same'))
  await clock.advance(0)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [shell] })
  const second = await $.command.run(queue('same'))
  await clock.advance(0)

  const sentRow = await $.ui.mount({
    plugin: 'queue',
    surface: 'terminal',
    component: 'CommandOutput',
    props: { command: 'queue', args: 'same', text: first.text, isError: false },
  } as never)
  const waitingRow = await $.ui.mount({
    plugin: 'queue',
    surface: 'terminal',
    component: 'CommandOutput',
    props: { command: 'queue', args: 'same', text: second.text, isError: false },
  } as never)

  expect((await sentRow.find({ type: 'Text', text: ' ✓ Sent ' }))?.props.backgroundColor).toBe('success')
  expect((await waitingRow.find({ type: 'Text', text: ' Queued #1 ' }))?.props.backgroundColor).toBe('suggestion')
  await sentRow.unmount()
  await waitingRow.unmount()
})

test('the reply row follows its message: its number moves up, then it reads Removed', async ($, on) => {
  const clock = mock.clock(on)
  answerEngine(on)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [shell] })
  await $.command.run(queue('first'))
  const second = await $.command.run(queue('second'))
  await clock.advance(0)

  // The engine may prefix the reply's text with the command's name.
  const row = (text: string | undefined) =>
    $.ui.mount({
      plugin: 'queue',
      surface: 'terminal',
      component: 'CommandOutput',
      props: { command: 'queue', args: 'second', text: `queue: ${text}`, isError: false },
    } as never)

  const waiting = await row(second.text)
  expect(await waiting.find({ type: 'Text', text: ' Queued #2 ' })).toBeDefined()

  await $.command.run(queue('rm 1'))
  const moved = await row(second.text)
  expect(await moved.find({ type: 'Text', text: ' Queued #1 ' })).toBeDefined()

  await $.command.run(queue('rm 1'))
  const gone = await row(second.text)
  const removed = await gone.find({ type: 'Text', text: 'Removed from the queue' })
  expect(removed?.props.dimColor).toBe(true)

  await waiting.unmount()
  await moved.unmount()
  await gone.unmount()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the band stays hidden with nothing queued, and shows while paused by the person on ${surface}`, async ($, on) => {
    mock.clock(on)
    answerEngine(on)

    // Hidden, the hook passes the draw on, and nothing beneath it draws the band: the mount has no drawing.
    const hidden = await $.ui.mount({ plugin: 'queue', surface, component: 'AbovePrompt', props: bandProps }).then(
      () => 'drawn',
      err => String(err),
    )
    expect(hidden).toContain('no implementation for ui.render')

    await $.command.run(queue('pause'))
    const paused = await $.ui.mount({ plugin: 'queue', surface, component: 'AbovePrompt', props: bandProps })
    expect(await paused.find({ type: 'Text', text: /^0 waiting · paused: you paused it/ })).toBeDefined()
    await paused.unmount()
  })
}

test('a sent message reads Sent after it leaves the history, and a dropped one reads Removed', async ($, on) => {
  const clock = mock.clock(on)
  answerEngine(on)
  on('prompt.submit', (_, e) => ({ text: e.text }))

  // One message goes out per Stop; six of them push the first out of the sent history.
  const replies: string[] = []
  for (const text of ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']) {
    replies.push((await $.command.run(queue(text))).text ?? '')
    await clock.advance(0)
    await $.classic.Stop({ stop_hook_active: false, background_tasks: [] })
    await clock.advance(0)
  }

  const first = await $.ui.mount({
    plugin: 'queue',
    surface: 'terminal',
    component: 'CommandOutput',
    props: { command: 'queue', args: 'm1', text: replies[0], isError: false },
  } as never)
  expect(await first.find({ type: 'Text', text: ' ✓ Sent ' })).toBeDefined()
  await first.unmount()

  // Held behind a background task, so it is still waiting when rm drops it.
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [shell] })
  const gone = await $.command.run(queue('gone'))
  await $.command.run(queue('rm 1'))
  const dropped = await $.ui.mount({
    plugin: 'queue',
    surface: 'terminal',
    component: 'CommandOutput',
    props: { command: 'queue', args: 'gone', text: gone.text ?? '', isError: false },
  } as never)
  expect(await dropped.find({ type: 'Text', text: 'Removed from the queue' })).toBeDefined()
  await dropped.unmount()
})

test('a message sent to the prompt box mid-turn reads In the prompt box until the person sends it, then Sent', async ($, on) => {
  const clock = mock.clock(on)
  answerEngine(on)
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', () => ({ isFilled: true }))
  on('prompt.submit', (_, e) => ({ text: e.text }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))

  await $.turn.start({ text: '', turnId: 't1' })
  const queued = await $.command.run(queue('mid'))
  await clock.advance(0)
  await $.command.run(queue('send 1'))

  const row = () =>
    $.ui.mount({
      plugin: 'queue',
      surface: 'terminal',
      component: 'CommandOutput',
      props: { command: 'queue', args: 'mid', text: queued.text ?? '', isError: false },
    } as never)

  const boxed = await row()
  expect((await boxed.find({ type: 'Text', text: ' In the prompt box ' }))?.props.backgroundColor).toBe('warning')
  await boxed.unmount()

  // A prompt a plugin submits is not the person sending the box.
  await $.prompt.submit({ text: 'other', wait: false, origin: { kind: 'plugin', name: 'test' } })
  const still = await row()
  expect(await still.find({ type: 'Text', text: ' In the prompt box ' })).toBeDefined()
  await still.unmount()

  await $.prompt.submit({ text: 'mid', wait: false, origin: { kind: 'composer' }, turnId: 't1' })
  const sent = await row()
  expect(await sent.find({ type: 'Text', text: ' ✓ Sent ' })).toBeDefined()
  await sent.unmount()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`the band yields to a survey, and draws nothing under it on ${surface}`, async ($, on) => {
    mock.clock(on)
    answerEngine(on)
    await $.command.run(queue('pause'))

    // A survey holds the band, so the hook passes the draw on and nothing beneath it draws the band.
    const held = await $.ui.mount({
      plugin: 'queue',
      surface,
      component: 'AbovePrompt',
      props: { ...(bandProps as Record<string, unknown>), hasSurvey: true } as never,
    }).then(
      () => 'drawn',
      err => String(err),
    )
    expect(held).toContain('no implementation for ui.render')
  })
}

test('state written before removedIds existed still takes add, rm and clear, and an unknown id reads Sent', async ($, on) => {
  const clock = mock.clock(on)
  answerEngine(on)
  // A store beneath the plugin, seeded with the state an earlier version left behind: no removedIds.
  let stored: QueueState = { items: [], gate: { mainTurn: 'idle', backgroundTasks: [shell], awaitingStop: false } }
  let version = 1
  on('state.get', () => ({ value: { value: stored, version } }))
  on('state.set', (_, e) => {
    if (e.ifVersion !== undefined && e.ifVersion !== version) return { value: { isSet: false as const, version } }
    stored = e.value as QueueState
    version += 1
    return { value: { isSet: true as const, version } }
  })
  await clock.advance(0)

  expect((await $.command.run(queue('a'))).text).toMatch(/^Queued @[a-z0-9]{4}: a$/)
  expect((await $.command.run(queue('rm 1'))).text).toBe('Removed: a')
  expect((await $.command.run(queue('b'))).text).toMatch(/^Queued @/)
  expect((await $.command.run(queue('clear'))).text).toBe('Cleared 1 queued message.')

  const row = await $.ui.mount({
    plugin: 'queue',
    surface: 'terminal',
    component: 'CommandOutput',
    props: { command: 'queue', args: 'x', text: 'queue: Queued @zzzz: x', isError: false },
  } as never)
  expect(await row.find({ type: 'Text', text: ' ✓ Sent ' })).toBeDefined()
  await row.unmount()
})

test('the band moves a message with Up and Down, offered only where it can move', async ($, on) => {
  const clock = mock.clock(on)
  answerEngine(on)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [shell] })
  await $.command.run(queue('first'))
  await $.command.run(queue('second'))
  await clock.advance(0)

  const ui = await $.ui.mount({ plugin: 'queue', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
  const labels = (await ui.findAll({ type: 'Button' })).map(x => x.props.label)
  expect(labels.filter(x => x === '↑').length).toBe(1)
  expect(labels.filter(x => x === '↓').length).toBe(1)

  await ui.press({ key: await buttonKey(ui, '↓') })
  expect((await $.command.run(queue('list'))).text).toBe('1. second\n2. first')
  await ui.unmount()
})

test('Edit puts the message in the prompt box as a /queue edit by id', async ($, on) => {
  const clock = mock.clock(on)
  answerEngine(on)
  const filled: string[] = []
  on('prompt.read', () => ({ value: { text: '', cursor: 0 } }))
  on('prompt.fill', (_, e) => {
    filled.push(e.text)
    return { isFilled: true }
  })
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [shell] })
  const reply = await $.command.run(queue('fix me'))
  await clock.advance(0)
  const id = /@([a-z0-9]{4})/.exec(reply.text ?? '')?.[1]

  const ui = await $.ui.mount({ plugin: 'queue', surface: 'desktop', component: 'AbovePrompt', props: bandProps })
  await ui.press({ key: await buttonKey(ui, 'Edit') })
  expect(filled).toEqual([`/queue edit @${id} fix me`])
  await ui.unmount()
})

test('the reply row offers Send now, Edit and Remove, and shows the text once edited', async ($, on) => {
  const clock = mock.clock(on)
  answerEngine(on)
  await $.classic.Stop({ stop_hook_active: false, background_tasks: [shell] })
  const reply = await $.command.run(queue('draft'))
  await clock.advance(0)
  const id = /@([a-z0-9]{4})/.exec(reply.text ?? '')?.[1]

  const mountRow = () =>
    $.ui.mount({
      plugin: 'queue',
      surface: 'desktop',
      component: 'CommandOutput',
      props: { command: 'queue', args: 'draft', text: reply.text ?? '', isError: false },
    } as never)

  const row = await mountRow()
  expect((await row.findAll({ type: 'Button' })).map(x => x.props.label)).toEqual(['Send now', 'Edit', 'Remove'])
  expect(await row.find({ type: 'Text', text: /^now: / })).toBeUndefined()
  await row.unmount()

  await $.command.run(queue(`edit @${id} final`))
  const edited = await mountRow()
  expect(await edited.find({ type: 'Text', text: 'now: final' })).toBeDefined()

  await edited.press({ key: await buttonKey(edited, 'Remove') })
  expect((await $.command.run(queue('list'))).text).toBe('The queue is empty.')
  await edited.unmount()
})
