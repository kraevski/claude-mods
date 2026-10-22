import type { QueueGate, QueueItem, QueueState } from '../types'
import type { Ref } from './command'

// Sent items kept for the list; older ones are dropped.
const SENT_HISTORY = 5

// Dropped ids kept so their reply rows can say Removed; older ones are forgotten.
const REMOVED_HISTORY = 200

export const initialState: QueueState = {
  items: [],
  gate: { mainTurn: 'idle', backgroundTasks: [], awaitingStop: false },
  removedIds: [],
}

// Items the person can see and act on by number: waiting, or flagged as possibly sent.
// A message being sent right now is not numbered, so nothing can act on it mid-send.
export const isQueued = (item: QueueItem): boolean => item.status === 'waiting' || item.maybeSent === true

export const queuedItems = (state: QueueState): QueueItem[] => state.items.filter(isQueued)

// The item at position n (1-based) among the queued items.
export const queuedAt = (state: QueueState, n: number): QueueItem | undefined => queuedItems(state)[n - 1]

// The queued item a reference means. An id that is no longer queued (already sent) finds nothing.
export const findQueued = (state: QueueState, ref: Ref): QueueItem | undefined =>
  'id' in ref ? queuedItems(state).find(x => x.id === ref.id) : queuedAt(state, ref.n)

// The item the drain would release next. Only this one can go, so the order holds.
export const nextItem = (state: QueueState): QueueItem | undefined => state.items.find(x => x.status !== 'sent')

// Pure transitions: each takes the state and returns the new one. Only claim, claimNow and move can refuse, with undefined.

export const add = (state: QueueState, item: QueueItem): QueueState => trim({ ...state, items: [...state.items, item] })

// Claims the next item for sending only if the gate is open and it is still waiting.
// Claiming sets awaitingStop, so the next item waits for the Stop that ends this one.
export const claim = (state: QueueState, id: string, isAgentBusy: boolean): QueueState | undefined =>
  claimBatch(state, id, isAgentBusy, false)?.state

// Like claim, but with `joined` the waiting prompts after the item go out in the same claim, up to the first
// command. Returns the ids claimed, so the drain can send exactly those.
export const claimBatch = (
  state: QueueState,
  id: string,
  isAgentBusy: boolean,
  joined: boolean,
): { state: QueueState; ids: string[] } | undefined => {
  const item = nextItem(state)
  if (item?.id !== id || item.status !== 'waiting') return undefined
  if (!isOpen(state) || isAgentBusy) return undefined

  const ids = batchIds(state, item, joined)
  return { state: claimed(state, ids), ids }
}

// A command, or any item when not joined, goes alone. A joined prompt takes the waiting prompts after it.
const batchIds = (state: QueueState, first: QueueItem, joined: boolean): string[] => {
  if (!joined || first.kind !== 'prompt') return [first.id]

  const ids = [first.id]
  for (const x of state.items.slice(state.items.indexOf(first) + 1)) {
    // A sent item sent out of order by `send <n>` is no longer in the queue, so it does not end the batch.
    if (x.status === 'sent') continue
    if (x.status !== 'waiting' || x.kind !== 'prompt') break
    ids.push(x.id)
  }
  return ids
}

// Claims one item to send now, as `send <n>` does while the main turn is idle. Ignores the background
// tasks and the pause, since the person asked for it; still refuses while a send is waiting for its Stop.
// Always one item, even in joined mode.
export const claimNow = (state: QueueState, id: string): QueueState | undefined => {
  const item = state.items.find(x => x.id === id)
  if (item?.status !== 'waiting') return undefined
  if (state.gate.mainTurn !== 'idle' || state.gate.awaitingStop) return undefined

  return claimed(state, [id])
}

const claimed = (state: QueueState, ids: string[]): QueueState => {
  const items = state.items.map(x => (ids.includes(x.id) ? { ...x, status: 'sending' as const } : x))
  return { ...state, items, gate: { ...state.gate, awaitingStop: true } }
}

export const markSent = (state: QueueState, id: string): QueueState => {
  const items = state.items.map(x => (x.id === id ? { ...x, status: 'sent' as const } : x))
  return trim({ ...state, items })
}

// A failed send may have reached Claude, so the item stays flagged and the queue pauses on it.
export const markFailed = (state: QueueState, id: string): QueueState => {
  const items = state.items.map(x => (x.id === id ? { ...x, status: 'sending' as const, maybeSent: true as const } : x))
  return { ...state, items, gate: { ...state.gate, paused: 'error', awaitingStop: false } }
}

// A send Claude Code refused (a `drop`) never entered, so the items go back to waiting, unflagged, and the queue
// pauses on them. No turn starts, so no Stop is coming: the wait for one ends here.
export const markDropped = (state: QueueState, ids: string[]): QueueState => {
  const items = state.items.map(x => (ids.includes(x.id) ? { ...x, status: 'waiting' as const } : x))
  return { ...state, items, gate: { ...state.gate, paused: 'dropped', awaitingStop: false } }
}

// A command that failed to run never ran, so the item goes back to waiting, first in line, and the queue pauses on it.
// Resuming retries it; removing it drops it.
export const markCommandFailed = (state: QueueState, id: string): QueueState => {
  const items = state.items.map(x => (x.id === id ? { ...x, status: 'waiting' as const } : x))
  return { ...state, items, gate: { ...state.gate, paused: 'command', awaitingStop: false, commandTurn: undefined } }
}

// `/name args` as the command runs it: the name, and the rest as its arguments.
export const splitCommand = (text: string): { command: string; args: string } => {
  const match = /^\/(\S+)\s*([\s\S]*)$/.exec(text)
  return { command: match?.[1] ?? '', args: match?.[2] ?? '' }
}

// A prompt.submit for a command, raised while the sending command item runs, means that command started a turn.
// Only the item being sent, by its name, counts; any other submission leaves the state alone.
export const markCommandTurn = (state: QueueState, name: string | undefined): QueueState | undefined => {
  const item = nextItem(state)
  if (name === undefined || item?.status !== 'sending' || item.kind !== 'command') return undefined
  if (splitCommand(item.text).command !== name) return undefined

  return { ...state, gate: { ...state.gate, commandTurn: true } }
}

export const onTurnStart = (state: QueueState): QueueState => ({
  ...state,
  gate: { ...state.gate, mainTurn: 'running' },
})

// An aborted, errored or refused turn pauses the queue, but only when something is waiting: with nothing queued
// there is nothing to hold, and a pause would start the next message paused. Neither ends with a Stop,
// so the wait for one is dropped either way.
export const onTurnComplete = (
  state: QueueState,
  turn: { isAborted: boolean; reason: 'answer' | 'aborted' | 'refusal' | 'error' },
): QueueState => {
  const isInterrupted = turn.isAborted || turn.reason === 'error' || turn.reason === 'refusal'
  const gate = { ...state.gate, mainTurn: 'idle' as const }
  if (!isInterrupted) return { ...state, gate }

  const isHolding = queuedItems(state).length > 0
  const paused = isHolding ? interruptReason(turn.reason) : gate.paused
  return { ...state, gate: { ...gate, paused, awaitingStop: false } }
}

const interruptReason = (reason: 'answer' | 'aborted' | 'refusal' | 'error'): 'aborted' | 'error' | 'refusal' => {
  if (reason === 'error') return 'error'
  if (reason === 'refusal') return 'refusal'
  return 'aborted'
}

// A command ran and finished. If it started a turn, that turn's Stop still ends the send, as a prompt's does. If it
// started none, no Stop is coming, so the send is done here and the gate opens.
export const markCommandDone = (state: QueueState, id: string): QueueState => {
  const marked = markSent(state, id)
  const gate = { ...marked.gate, commandTurn: undefined }
  return { ...marked, gate: marked.gate.commandTurn ? gate : { ...gate, awaitingStop: false } }
}

// A short id for a message, unique within the queue. Ids are typed after `@`, so they stay short.
export const newId = (state: QueueState, random: () => number = Math.random): string => {
  const taken = new Set([...state.items.map(x => x.id), ...droppedIds(state)])
  for (;;) {
    const id = Math.floor(random() * 36 ** 4)
      .toString(36)
      .padStart(4, '0')
    if (!taken.has(id)) return id
  }
}

export const onStop = (state: QueueState, backgroundTasks: QueueGate['backgroundTasks']): QueueState => ({
  ...state,
  gate: { ...state.gate, mainTurn: 'idle', backgroundTasks, awaitingStop: false, commandTurn: undefined },
})

export const isOpen = (state: QueueState): boolean =>
  state.gate.paused === undefined &&
  state.gate.mainTurn === 'idle' &&
  state.gate.backgroundTasks.length === 0 &&
  !state.gate.awaitingStop

// Emptying the queue ends a pause that held it for a reason the person has now seen off: an interrupt or an
// error. A pause the person chose with `/queue pause` stays until they resume.
const releaseIfEmptied = (state: QueueState): QueueState => {
  const isEmptied = queuedItems(state).length === 0
  const isReleasable =
    state.gate.paused === 'aborted' ||
    state.gate.paused === 'command' ||
    state.gate.paused === 'dropped' ||
    state.gate.paused === 'error' ||
    state.gate.paused === 'refusal' ||
    state.gate.paused === 'restored'
  if (!isEmptied || !isReleasable) return state

  return { ...state, gate: { ...state.gate, paused: undefined } }
}

// Takes an item out without recording it as dropped: the send to the prompt box, where the text goes on to be sent.
export const removeItem = (state: QueueState, id: string): QueueState =>
  releaseIfEmptied({ ...state, items: state.items.filter(x => x.id !== id) })

// A mid-turn Send: the item leaves the queue for the prompt box, and its reply row reads In the prompt box until the
// person sends it. A message still marked from an earlier Send left the box without being sent, so it reads Removed.
export const moveToBox = (state: QueueState, id: string): QueueState => {
  const moved = { ...removeItem(state, id), boxedId: id }
  return state.boxedId === undefined ? moved : { ...moved, removedIds: remembered(droppedIds(state), [state.boxedId]) }
}

// The person's next submission sends what the box held, so the boxed message now reads Sent. The plugin cannot see
// whether they changed the text first; an edited message still counts as sent.
export const onPersonSubmit = (state: QueueState): QueueState | undefined =>
  state.boxedId === undefined ? undefined : { ...state, boxedId: undefined }

// Drops an item the person chose to remove (rm, the band's Remove), so its reply row reads Removed.
export const dropItem = (state: QueueState, id: string): QueueState => ({
  ...removeItem(state, id),
  removedIds: remembered(droppedIds(state), [id]),
})

export const clearQueued = (state: QueueState): QueueState => {
  const cleared = queuedItems(state).map(x => x.id)
  return releaseIfEmptied({
    ...state,
    items: state.items.filter(x => !isQueued(x)),
    removedIds: remembered(droppedIds(state), cleared),
  })
}

const remembered = (ids: string[], added: string[]): string[] => [...ids, ...added].slice(-REMOVED_HISTORY)

// The ids of dropped messages. State written before the field existed has none.
export const droppedIds = (state: QueueState): string[] => state.removedIds ?? []

export const editItem = (state: QueueState, id: string, text: string): QueueState => ({
  ...state,
  items: state.items.map(x => (x.id === id ? { ...x, text } : x)),
})

// Swaps the item with its neighbour among the queued items: by -1 moves it up, by 1 moves it down.
export const moveItem = (state: QueueState, id: string, by: -1 | 1): QueueState | undefined => {
  const queued = queuedItems(state)
  const from = queued.findIndex(x => x.id === id)
  const to = from + by
  const a = queued[from]
  const b = queued[to]
  if (a === undefined || b === undefined) return undefined

  const items = state.items.map(x => (x.id === a.id ? b : x.id === b.id ? a : x))
  return { ...state, items }
}

export const setPaused = (state: QueueState, paused: QueueGate['paused']): QueueState => ({
  ...state,
  gate: { ...state.gate, paused },
})

// Resuming is the person accepting the risk: a message flagged as possibly sent goes out again.
export const resume = (state: QueueState): QueueState => ({
  ...state,
  items: state.items.map(x => (x.maybeSent ? { ...x, status: 'waiting' as const, maybeSent: undefined } : x)),
  gate: { ...state.gate, paused: undefined },
})

// Keeps every item still to go and the last few sent ones.
const trim = (state: QueueState): QueueState => {
  const sent = state.items.filter(x => x.status === 'sent')
  const keep = new Set(sent.slice(-SENT_HISTORY).map(x => x.id))
  return { ...state, items: state.items.filter(x => x.status !== 'sent' || keep.has(x.id)) }
}

// What a restart or a /clear brings back, saved under the session's id after each write.
export type SavedQueue = {
  savedAt: number
  items: QueueItem[]
  removedIds?: string[]
  paused?: QueueGate['paused']
}

// A saved queue this old is dropped, not restored.
const SAVED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

// Reads a stored value as a saved queue. The store holds plain JSON, so a value of another shape is not one.
export const isSaved = (value: unknown): value is SavedQueue => {
  const saved = value as Partial<SavedQueue> | null
  return typeof saved === 'object' && saved !== null && Array.isArray(saved.items) && typeof saved.savedAt === 'number'
}

export const isStale = (saved: SavedQueue, now: number): boolean => now - saved.savedAt > SAVED_MAX_AGE_MS

// What to keep of the queue: the messages still to go, the dropped ids, and a pause. With nothing queued and no
// pause there is nothing to keep, so undefined, and the caller deletes the key.
export const toSaved = (state: QueueState, savedAt: number): SavedQueue | undefined => {
  const items = state.items.filter(x => x.status !== 'sent')
  if (items.length === 0 && state.gate.paused === undefined) return undefined

  return { savedAt, items, removedIds: droppedIds(state), paused: state.gate.paused }
}

// The queue as a restart or a /clear leaves it, or undefined when nothing is queued. Nothing is mid-turn any more,
// so the gate starts clear. A message that was mid-send may have reached Claude, so it is flagged. The queue waits
// paused until the person resumes it: `restored`, or the `user` pause they chose.
export const restoredState = (saved: SavedQueue): QueueState | undefined => {
  const items = saved.items
    .filter(x => x.status !== 'sent')
    .map(x => (x.status === 'sending' ? { ...x, maybeSent: true as const } : x))
  if (items.length === 0) return undefined

  const paused = saved.paused === 'user' ? 'user' : 'restored'
  return {
    items,
    gate: { mainTurn: 'idle', backgroundTasks: [], awaitingStop: false, paused },
    removedIds: saved.removedIds ?? [],
  }
}
