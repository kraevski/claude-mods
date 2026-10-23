// One queued message: a prompt sent as the user's own words, or a slash command.
export type QueueItem = {
  id: string
  text: string
  kind: 'prompt' | 'command'
  status: 'waiting' | 'sending' | 'sent'
  createdAt: number
  // Set when a send failed after it started, so the message may already have reached Claude.
  maybeSent?: true
}

// What the drain waits on before it releases the next item.
export type QueueGate = {
  mainTurn: 'running' | 'idle'
  backgroundTasks: { type: string; description: string }[]
  paused?: 'aborted' | 'command' | 'dropped' | 'error' | 'refusal' | 'restored' | 'user'
  // True from a send until the Stop that ends its turn: one item per Stop.
  awaitingStop: boolean
  // Set while the command being sent has raised a prompt.submit, so its turn's Stop ends the send.
  commandTurn?: true
}

// The queue: the messages, the gate, and the ids of messages the person dropped (rm, clear, the band's Remove),
// so their reply rows can say so after the message is gone. Only the latest are kept. Optional: state written
// before the field existed has none, and the readers treat that as no ids. `boxedId` is the message a mid-turn Send
// put in the prompt box, until the person's next submission sends it.
export type QueueState = { items: QueueItem[]; gate: QueueGate; removedIds?: string[]; boxedId?: string }

// The message being edited in place on the desktop: its id, and whether the band or the reply row holds the field.
export type InlineEdit = { id: string; site: 'band' | 'reply' }

declare module 'claude-code' {
  interface PluginState {
    queue: {
      queue: QueueState
      // How many messages the desktop band's field has queued: its key, so each one queued draws a fresh field.
      fieldUses: number
      // The text the desktop band's field had when it grew from one line to two; null while it is one line.
      fieldGrown: string | null
      editing: InlineEdit | null
    }
  }
}
