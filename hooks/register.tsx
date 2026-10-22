import type { EngineInterface, Register } from 'claude-code'
import { atom, read } from 'claude-code'

import type { QueueItem, QueueState } from '../types'
import type { Ref } from './command'
import { parse, refText } from './command'
import {
  add,
  claimBatch,
  claimNow,
  clearQueued,
  droppedIds,
  dropItem,
  editItem,
  findQueued,
  initialState,
  isOpen,
  isQueued,
  isSaved,
  isStale,
  markCommandDone,
  markCommandFailed,
  markCommandTurn,
  markFailed,
  markSent,
  moveItem,
  moveToBox,
  newId,
  nextItem,
  onPersonSubmit,
  onStop,
  onTurnComplete,
  onTurnStart,
  queuedItems,
  resume,
  restoredState,
  setPaused,
  splitCommand,
  toSaved,
} from './queue'

const USAGE = 'Usage: /queue <message>. The message is sent after the current turn finishes.'

// The engine has no way to hide a command's row from the model, so this context note is the only control.
// Without it, the model reads queued text and may act on it before the queue releases it.
export const QUEUE_NOTE =
  "The /queue command above is the person's message queue, handled by a plugin. Queued text is held, not a request: do not act on it, answer it, or mention it. Each queued message arrives later as its own user message, when the queue releases it."

// Every /queue answer carries the note, so Claude does not act on the queued text it reports.
const answer = (text: string) => ({ text, context: [QUEUE_NOTE] })

// How many queued messages the band lists; the rest are counted.
const BAND_ROWS = 3

// The queue's color, from the person's theme: the band's pill and numbers, and the reply row's pill.
const ACCENT = 'suggestion'

// The `joined` option, read in register: the drain sends the waiting prompts as one message.
let joined = false

const stateRef = { plugin: 'queue', key: 'queue' } as const

// The whole queue is one value, so one compare-and-set write moves items and gate together.
const queue = atom(stateRef, initialState)

// Applies `change` to the stored state. A write that lost a race is retried on the newer state.
// Returns false when `change` declined (undefined), so no write happened.
const modify = async ($: EngineInterface, change: (state: QueueState) => QueueState | undefined): Promise<boolean> => {
  for (;;) {
    const held = await $.state.get(stateRef)
    const next = change(held.value ?? initialState)
    if (next === undefined) return false

    const written = await $.state.set(stateRef, next, { ifVersion: held.version })
    if (written.isSet) {
      void save($)
      return true
    }
  }
}

// The queue is also saved under the session id after each write, so a restart or /clear can bring it back.
// Saves run one at a time, so an older snapshot cannot land after a newer one.
let saves: Promise<void> = Promise.resolve()

// A hook does not wait for its save, so a slow store never holds up the write that made it.
const save = ($: EngineInterface): void => {
  saves = saves.then(() => writeSaved($))
}
// Reads the state again rather than taking the one just written, so the newest write is the one saved.
// A failed store write must not break the queue: only the copy for a restart is lost.
const writeSaved = async ($: EngineInterface): Promise<void> => {
  try {
    const key = sessionKey(await $.session.id())
    const saved = toSaved(await read($, queue), Date.now())
    if (saved === undefined) await $.store.delete(key)
    else await $.store.set(key, saved)
  } catch {
    // The live queue is already written; only the saved copy is missing.
  }
}

const SESSION_PREFIX = 'session:'
const sessionKey = (id: string): string => `${SESSION_PREFIX}${id}`

// A /clear or /resume ends the session, and the process switches to the new id after that. Probed: a timer this
// long after a /clear sees the new id; a shorter wait is untested. While the id is still the old one, it waits again.
const SWITCH_WAIT_MS = 1000

// How often the timer waits again before it gives up. An id that never changes (a /resume of the open conversation)
// means $.state already holds the right queue, so there is nothing to restore.
const SWITCH_TRIES = 5

// The session a /clear or /resume just ended, until its restore runs. The timer and the fallbacks (the first /queue,
// prompt.submit, turn.start, session.start) all read it, so the restore happens once. A worker respawn loses the
// timer and this value both; the saved copy then stays where it is. Accepted.
let pendingSwitch: { from: string; isClear: boolean; tries: number } | undefined

// Brings the queue saved under `key` into this session's queue, paused. Only an empty queue takes it, and a queue
// that already holds messages leaves the saved copy alone. Resolves whether it restored.
const restoreFrom = async ($: EngineInterface, key: string): Promise<boolean> => {
  if ((await read($, queue)).items.length > 0) return false

  try {
    const saved = await $.store.get(key)
    if (!isSaved(saved)) return false
    if (isStale(saved, Date.now())) {
      await $.store.delete(key)
      return false
    }

    const restored = restoredState(saved)
    if (restored === undefined) return false

    return await modify($, s => (s.items.length === 0 ? restored : undefined))
  } catch {
    return false
  }
}

// Restores the queue after a /clear or a /resume has switched the session, once: the first trigger that sees the
// switch takes `pendingSwitch`, so a later one finds nothing to do. While the id is still the old one, nothing is
// taken and the timer runs again, so the restore never runs against the old $.state. Only the timer waits again: a
// fallback that sees the old id just returns, so timers never pile up.
const restoreAfterSwitch = async ($: EngineInterface, isTimer = false): Promise<void> => {
  const pending = pendingSwitch
  if (pending === undefined) return

  const current = await $.session.id()
  if (current === pending.from) {
    if (!isTimer) return
    pending.tries += 1
    if (pending.tries >= SWITCH_TRIES) pendingSwitch = undefined
    else armSwitchTimer($)
    return
  }
  pendingSwitch = undefined

  // A /resume keeps the conversation's own key, under the id it now has, and nothing is deleted. A /clear's queue
  // was saved under the old id, and that key goes once its messages are in this session.
  if (!pending.isClear) {
    await restoreFrom($, sessionKey(current))
    return
  }
  const oldKey = sessionKey(pending.from)
  const isRestored = await restoreFrom($, oldKey)
  if (isRestored) await $.store.delete(oldKey).catch(() => undefined)
}

const armSwitchTimer = ($: EngineInterface): void => {
  void $.clock.after(SWITCH_WAIT_MS, () => void restoreAfterSwitch($, true))
}

// Drops saved queues not written for 7 days, so a session that ended long ago leaves nothing behind.
const pruneSaved = async ($: EngineInterface): Promise<void> => {
  try {
    for (const key of await $.store.keys()) {
      if (!key.startsWith(SESSION_PREFIX)) continue

      const saved = await $.store.get(key)
      if (!isSaved(saved) || isStale(saved, Date.now())) await $.store.delete(key)
    }
  } catch {
    // An entry left behind costs little; the next session start prunes again.
  }
}

const isAgentBusy = async ($: EngineInterface): Promise<boolean> =>
  (await $.agent.list()).some(a => a.status === 'running' || a.status === 'pending' || a.status === 'waiting')

// Runs the drain on a timer, never inline: a hook may not call prompt.submit.
const scheduleDrain = ($: EngineInterface): void => {
  void $.clock.after(0, () => void drain($))
}

// Sends a batch: one command alone, or one or more prompts as the person's own words.
const deliver = ($: EngineInterface, batch: QueueItem[]): Promise<void> => {
  const [first] = batch
  return first?.kind === 'command' ? runCommand($, first) : sendPrompt($, batch)
}

// A batch's prompts go out as one message, separated by blank lines. The batch's Stop releases the next one.
const sendPrompt = ($: EngineInterface, batch: QueueItem[]): Promise<void> =>
  $.prompt.submit({ text: batch.map(x => x.text).join('\n\n'), asUser: true }).then(
    () => modify($, s => batch.reduce((acc, x) => markSent(acc, x.id), s)).then(() => undefined),
    () => {
      void modify($, s => batch.reduce((acc, x) => markFailed(acc, x.id), s))
      void $.ui.toast('The queued message could not be sent. The queue is paused.')
    },
  )

// A command's turn, if it starts one, ends at a Stop as a prompt's does. A command that starts none has no Stop
// coming, so the drain goes on when it resolves; a refused command pauses the queue. The prompt.submit hook has
// already marked a command that started a turn, and it can run before this resolve, so the mark is read here.
const runCommand = async ($: EngineInterface, item: QueueItem): Promise<void> => {
  const { command, args } = splitCommand(item.text)
  try {
    await $.command.run({ command, args })
  } catch {
    void $.ui.toast('The queued command could not run. The queue is paused.')
    await modify($, s => markCommandFailed(s, item.id))
    return
  }

  await modify($, s => markCommandDone(s, item.id))
  // A drain while the send was still waiting found the gate closed, so it runs again now.
  scheduleDrain($)
}

// A command item must name a command this session has now, so a typo is refused at queue time, not at its turn.
const refuseCommand = async ($: EngineInterface, text: string): Promise<string | undefined> => {
  const { command } = splitCommand(text)
  if (command === 'queue') return 'The queue cannot hold a /queue command. The message was not queued.'

  const isKnown = (await $.command.list()).some(x => x.name === command)
  return isKnown ? undefined : `No command /${command}. The message was not queued.`
}

// Releases the next item if the gate is open. Called from events only, never from a poll.
const drain = async ($: EngineInterface): Promise<void> => {
  const state = await read($, queue)
  const item = nextItem(state)
  if (item === undefined || !isOpen(state)) return

  // The claim re-checks the gate, so a send happens at most once even if two drains race.
  const isBusy = await isAgentBusy($)
  // The batch is built from the state the claim wrote, so nothing can change between the claim and the send.
  let batch: QueueItem[] = []
  const isClaimed = await modify($, s => {
    const claimed = claimBatch(s, item.id, isBusy, joined)
    batch = claimed ? claimed.state.items.filter(x => claimed.ids.includes(x.id)) : []
    return claimed?.state
  })
  if (!isClaimed) return

  await deliver($, batch)
}

// Puts text in the prompt box. A draft already there is left alone, so the caller keeps the item queued.
const fillBox = async ($: EngineInterface, text: string): Promise<'filled' | 'draft' | 'no-box'> => {
  const box = await $.prompt.read()
  if (box.text !== '') return 'draft'

  const filled = await $.prompt.fill({ text, mode: 'replace' })
  return filled.isFilled ? 'filled' : 'no-box'
}

const refuseFill = ($: EngineInterface, outcome: 'draft' | 'no-box'): string => {
  if (outcome === 'draft') {
    void $.ui.toast('The prompt box has a draft. The message stays queued.')
    return 'The prompt box has a draft.'
  }
  void $.ui.toast('The prompt box is not available. The message stays queued.')
  return 'The prompt box is not available.'
}

// `send` by reference: while idle, submits now; while running, puts the text in the prompt box.
// Shared by `/queue send` and the band's Send button.
const sendQueued = async ($: EngineInterface, ref: Ref): Promise<string> => {
  const item = findQueued(await read($, queue), ref)
  if (item === undefined) return outOfRange(ref)
  if (item.status !== 'waiting') {
    return `Message ${refText(ref)} may already have been sent. /queue resume sends it again; /queue rm drops it.`
  }

  // Idle: submit now, from a timer (a hook may not call prompt.submit).
  if ((await read($, queue)).gate.mainTurn === 'idle') {
    const isClaimed = await modify($, s => claimNow(s, item.id))
    if (!isClaimed) return `Claude has not finished the last message yet. ${item.text} stays queued.`

    void $.clock.after(0, () => void deliver($, [item]))
    return `Sending: ${item.text}`
  }

  // Running: the text goes into the box, and the person's Enter feeds it into the running turn.
  const outcome = await fillBox($, item.text)
  if (outcome !== 'filled') return `${refuseFill($, outcome)} ${item.text} stays queued.`

  await modify($, s => moveToBox(s, item.id))
  return `In the prompt box, press Enter to send: ${item.text}`
}

const outOfRange = (ref: Ref): string => `No queued message ${refText(ref)}. /queue list shows them.`

const PAUSE_REASON = {
  aborted: 'you interrupted Claude',
  command: 'a queued command failed',
  error: 'an API error stopped the last turn',
  refusal: 'Claude refused the last message',
  restored: 'kept from before a restart or /clear',
  user: 'you paused it',
} as const

const listText = (state: QueueState): string => {
  const queued = queuedItems(state)
  const lines = queued.map((x, i) => `${i + 1}. ${x.text}${x.maybeSent ? ' (may have been sent)' : ''}`)
  if (state.gate.paused) lines.unshift(`Paused: ${PAUSE_REASON[state.gate.paused]}. /queue resume continues.`)
  if (queued.length === 0) lines.push('The queue is empty.')
  return lines.join('\n')
}

// What the band says the queue is waiting on. Reads only the state: no engine calls while drawing.
const waitingOn = (state: QueueState): string => {
  const { gate } = state
  if (gate.paused) return `paused: ${PAUSE_REASON[gate.paused]}`
  if (gate.mainTurn === 'running') return 'waiting for Claude'
  if (gate.awaitingStop) return 'sending'
  if (gate.backgroundTasks.length > 0) {
    const count = gate.backgroundTasks.length
    return `waiting for ${count} background ${count === 1 ? 'task' : 'tasks'}`
  }
  return 'next when Claude is done'
}

export const register: Register = (on, options) => {
  joined = options.joined === true

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'queue',
      description: 'Send a message to Claude after the current turn finishes',
      argumentHint: '<message>',
      immediate: true,
    })

    // A fresh process restores its own saved copy, but only into a $.state with no value at all. A hot reload holds
    // the live queue, and a reload between a write and its save would bring back an older copy, so it is left alone.
    await pruneSaved($)
    if (pendingSwitch !== undefined) await restoreAfterSwitch($)
    else if ((await $.state.get(stateRef)).value === undefined) await restoreFrom($, sessionKey(await $.session.id()))

    // Restarts the drain: timers do not survive a reload, so the queue would sit otherwise.
    scheduleDrain($)
    return next(e)
  })

  // A /clear ends the session and the process goes on under a new id, with $.state empty; the queue was saved under
  // the old id. A /resume in the same process switches to another conversation the same way, with no session.start.
  // Saves do not block their writes, so the last ones may still be running: they land first, under the old id, or
  // an exit would lose them and a /clear would save them under the new session. The engine bounds this wait.
  on('session.end', async ($, e, next) => {
    await saves
    if (e.reason === 'clear' || e.reason === 'resume') {
      pendingSwitch = { from: e.sessionId, isClear: e.reason === 'clear', tries: 0 }
      armSwitchTimer($)
    }
    return next(e)
  })

  // A command that raises a prompt.submit starts a turn, so its send waits for that turn's Stop. Raised before the
  // command resolves, so the mark is in place by then.
  // The person's own submission also sends a message a mid-turn Send put in the box. A /queue command is not one,
  // and nor is a prompt the queue, another plugin or a notification submitted.
  on('prompt.submit', async ($, e, next) => {
    await restoreAfterSwitch($)
    await modify($, s => markCommandTurn(s, e.command?.name))
    const isPerson = e.origin.kind === 'composer' || e.origin.kind === 'bridge'
    if (isPerson && e.command?.name !== 'queue') await modify($, s => onPersonSubmit(s))
    return next(e)
  })

  // Main loop only: a subagent's turns do not change the queue's gate.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      await restoreAfterSwitch($)
      await modify($, s => onTurnStart(s))
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await modify($, s => onTurnComplete(s, e))
    } else {
      // A subagent ended. A Stop that came while it was still listed was refused, so try again now.
      scheduleDrain($)
    }
    return next(e)
  })

  // A Stop another hook blocks is not the end of the turn, so the drain waits for the next Stop.
  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    if (result.block !== undefined || result.preventContinuation) return result

    await modify($, s => onStop(s, e.background_tasks ?? []))
    scheduleDrain($)
    return result
  })

  on('command.run', { command: 'queue' }, async ($, e) => {
    await restoreAfterSwitch($)
    const command = parse(e.args)

    switch (command.kind) {
      case 'message': {
        if (command.text === '') return answer(USAGE)

        // Text starting with `/` is a slash command, sent to the command rather than as the person's words.
        const kind = command.text.startsWith('/') ? 'command' : 'prompt'
        if (kind === 'command') {
          const refusal = await refuseCommand($, command.text)
          if (refusal !== undefined) return answer(refusal)
        }

        // The reply names the message by id, so the row can tell it apart from one with the same text.
        // Commands run one at a time, so no other message can take the id between this read and the write.
        const id = newId(await read($, queue))
        await modify($, s => add(s, { id, text: command.text, kind, status: 'waiting', createdAt: Date.now() }))
        scheduleDrain($)
        return answer(`Queued @${id}: ${command.text}`)
      }

      case 'list':
        return answer(listText(await read($, queue)))

      case 'clear': {
        const count = queuedItems(await read($, queue)).length
        await modify($, s => clearQueued(s))
        return answer(`Cleared ${count} queued ${count === 1 ? 'message' : 'messages'}.`)
      }

      case 'pause':
        await modify($, s => setPaused(s, 'user'))
        return answer('Paused. Queued messages wait until /queue resume.')

      case 'resume':
        await modify($, s => resume(s))
        scheduleDrain($)
        return answer('Resumed.')

      case 'rm': {
        const item = findQueued(await read($, queue), command.ref)
        if (item === undefined) return answer(outOfRange(command.ref))

        await modify($, s => dropItem(s, item.id))
        return answer(`Removed: ${item.text}`)
      }

      case 'up':
      case 'down': {
        const by = command.kind === 'up' ? -1 : 1
        const before = await read($, queue)
        const item = findQueued(before, command.ref)
        if (item === undefined) return answer(outOfRange(command.ref))

        const isMoved = await modify($, s => moveItem(s, item.id, by))
        if (!isMoved) return answer(`${item.text} is already ${by < 0 ? 'first' : 'last'}.`)

        const position = queuedItems(before).findIndex(x => x.id === item.id) + 1
        return answer(`Moved to ${position + by}: ${item.text}`)
      }

      case 'edit': {
        const item = findQueued(await read($, queue), command.ref)
        if (item === undefined) return answer(outOfRange(command.ref))

        // The pre-fill names the message by id, so an earlier message being sent meanwhile cannot shift it.
        if (command.text === undefined) {
          const outcome = await fillBox($, `/queue edit @${item.id} ${item.text}`)
          if (outcome === 'filled') return answer('Edit the message in the prompt box, then press Enter.')
          return answer(refuseFill($, outcome))
        }

        const text = command.text
        await modify($, s => editItem(s, item.id, text))
        return answer(`Edited: ${text}`)
      }

      case 'send':
        return answer(await sendQueued($, command.ref))
    }
  })

  // The band above the prompt: a summary, the first few messages, and Resume while paused. Each row keeps Send now
  // and Remove in view; the pointer on a row adds Up, Down and Edit. It reads the state only, so a redraw costs no
  // engine calls.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // A survey holds the band; the queue yields to it.
    if (e.props.hasSurvey) return next(e)

    const state = await read($, queue)
    const queued = queuedItems(state)
    // Empty, the band stays hidden unless the person paused on purpose.
    if (queued.length === 0 && state.gate.paused !== 'user') return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const shown = queued.slice(0, BAND_ROWS)

    // Each row: the number, the text cut at the edge, then the buttons, which keep their width. The text's Box
    // may shrink below its text's width, so a long message never pushes the buttons off the edge.
    return (
      <Box flexDirection="column">
        <Box gap={1}>
          <Box flexShrink={0}>
            <Text backgroundColor={ACCENT} color="inverseText" weight="semibold">
              {' Queue '}
            </Text>
          </Box>
          <Box flexGrow={1} flexShrink={1} minWidth={0}>
            <Text wrap="truncate-end" dimColor>
              {queued.length} waiting · {waitingOn(state)}
            </Text>
          </Box>
          {state.gate.paused !== undefined ? (
            <Button key="resume" label="Resume" variant="primary" onPress={() => void resumeFromBand($)} />
          ) : null}
        </Box>
        {shown.map((x, i) => (
          <Box key={x.id} gap={1}>
            <Box width={3} flexShrink={0}>
              <Text color={ACCENT} weight="semibold" tabular>
                {i + 1}
              </Text>
            </Box>
            <Box flexGrow={1} flexShrink={1} minWidth={0}>
              <Text wrap="truncate-end" dimColor={x.status !== 'waiting'}>
                {x.text}
              </Text>
            </Box>
            {x.maybeSent ? (
              <Box flexShrink={0}>
                <Text dimColor>(may have been sent)</Text>
              </Box>
            ) : null}
            <Box flexShrink={0} gap={1}>
              <Box display="none" hover={{ display: 'flex' }} gap={1}>
                {i > 0 ? (
                  <Button key={`up-${x.id}`} label="↑" dimColor onPress={() => void moveFromBand($, x.id, -1)} />
                ) : null}
                {i < queued.length - 1 ? (
                  <Button key={`down-${x.id}`} label="↓" dimColor onPress={() => void moveFromBand($, x.id, 1)} />
                ) : null}
                <Button key={`edit-${x.id}`} label="Edit" dimColor onPress={() => void editFromBand($, x.id)} />
              </Box>
              <Button
                key={`send-${x.id}`}
                label="Send now"
                variant={i === 0 ? 'primary' : undefined}
                onPress={() => void sendFromBand($, x.id)}
              />
              <Button key={`remove-${x.id}`} label="Remove" dimColor onPress={() => void removeFromBand($, x.id)} />
            </Box>
          </Box>
        ))}
        {queued.length > BAND_ROWS ? <Text dimColor>+{queued.length - BAND_ROWS} more</Text> : null}
      </Box>
    )
  })

  // The reply row under `/queue <text>`: a colored status pill that follows its message as the queue changes. Its
  // number moves up as earlier ones go; once the message is gone it reads Removed when the person dropped it, In the
  // prompt box after a mid-turn Send until the person sends it, and Sent otherwise. The echo above already shows the text, so the row repeats it only once the text was edited.
  // While queued, the pointer on the row adds Send now, Edit and Remove. The reply names the message by id, so this
  // finds the right one even when two share a text. The engine may prefix the text with the command's name; the
  // anchored match takes that prefix and no more.
  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    if (e.props.command !== 'queue') return next(e)

    const match = /^(?:queue: )?Queued @([a-z0-9]{4}): ([\s\S]*)$/.exec(e.props.text)
    if (match === null) return next(e)

    const id = match[1] ?? ''
    const queuedText = match[2] ?? ''
    const state = await read($, queue)
    const entry = state.items.find(x => x.id === id)
    const { Box, Button, Text } = $.ui.resolve(e)

    const pill = (label: string, color: string) => (
      <Box flexShrink={0}>
        <Text backgroundColor={color} color="inverseText" weight="semibold">
          {` ${label} `}
        </Text>
      </Box>
    )
    const edited =
      entry !== undefined && entry.text !== queuedText ? (
        <Box flexGrow={1} flexShrink={1} minWidth={0}>
          <Text wrap="truncate-end" dimColor>
            now: {entry.text}
          </Text>
        </Box>
      ) : null

    if (entry === undefined) {
      if (droppedIds(state).includes(id)) {
        return (
          <Box justifyContent="flex-end">
            <Text dimColor>
              Removed from the queue
            </Text>
          </Box>
        )
      }
      if (state.boxedId === id) {
        return (
          <Box gap={1} justifyContent="flex-end">
            {pill('In the prompt box', 'warning')}
            <Box flexShrink={0}>
              <Text dimColor>press Enter to send</Text>
            </Box>
          </Box>
        )
      }
      return <Box justifyContent="flex-end">{pill('✓ Sent', 'success')}</Box>
    }
    if (entry.status === 'sent') {
      return (
        <Box gap={1} justifyContent="flex-end">
          {pill('✓ Sent', 'success')}
          {edited}
        </Box>
      )
    }
    if (!isQueued(entry)) {
      return (
        <Box gap={1} justifyContent="flex-end">
          {pill('Sending…', 'warning')}
          {edited}
        </Box>
      )
    }

    const position = queuedItems(state).findIndex(x => x.id === id) + 1
    const status = position === 1 ? waitingOn(state) : `after ${position - 1} more`
    return (
      <Box key={`reply-${id}`} gap={1} justifyContent="flex-end">
        {pill(`Queued #${position}`, ACCENT)}
        <Box flexShrink={0}>
          <Text dimColor>
            {status}
            {entry.maybeSent ? ' (may have been sent)' : ''}
          </Text>
        </Box>
        {edited}
        <Box display="none" hover={{ display: 'flex' }} gap={1} flexShrink={0}>
          <Button key={`reply-send-${id}`} label="Send now" onPress={() => void sendFromBand($, id)} />
          <Button key={`reply-edit-${id}`} label="Edit" dimColor onPress={() => void editFromBand($, id)} />
          <Button key={`reply-remove-${id}`} label="Remove" dimColor onPress={() => void removeFromBand($, id)} />
        </Box>
      </Box>
    )
  })
}

// The band's buttons act by id, through the same paths as the commands.
const sendFromBand = async ($: EngineInterface, id: string): Promise<void> => {
  void $.ui.toast(await sendQueued($, { id }))
}

const moveFromBand = async ($: EngineInterface, id: string, by: -1 | 1): Promise<void> => {
  await modify($, s => moveItem(s, id, by))
}

// Edit pre-fills the prompt box with `/queue edit @id <text>`, as `/queue edit` does.
const editFromBand = async ($: EngineInterface, id: string): Promise<void> => {
  const item = findQueued(await read($, queue), { id })
  if (item === undefined) return

  const outcome = await fillBox($, `/queue edit @${item.id} ${item.text}`)
  if (outcome !== 'filled') refuseFill($, outcome)
}

const removeFromBand = async ($: EngineInterface, id: string): Promise<void> => {
  await modify($, s => dropItem(s, id))
}

const resumeFromBand = async ($: EngineInterface): Promise<void> => {
  await modify($, s => resume(s))
  scheduleDrain($)
}
