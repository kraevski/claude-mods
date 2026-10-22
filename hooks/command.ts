// Which queued message a command means: its position (`3`), or its id (`@k3j2h1`). The id is what
// `edit` pre-fills, so an edit still reaches its message after an earlier one is sent.
export type Ref = { n: number } | { id: string }

// What `/queue <args>` asks for. A control word counts only when its arguments fit, so
// `/queue rm` with no number, or `/queue list now`, queues the text as a message.
export type Command =
  | { kind: 'message'; text: string }
  | { kind: 'list' | 'clear' | 'pause' | 'resume' }
  | { kind: 'rm' | 'send' | 'up' | 'down'; ref: Ref }
  | { kind: 'edit'; ref: Ref; text?: string }

const REF = /^(\d+|@[a-z0-9]+)$/

const toRef = (token: string): Ref => (token.startsWith('@') ? { id: token.slice(1) } : { n: Number(token) })

// The reference as the person typed it, for replies and the edit pre-fill.
export const refText = (ref: Ref): string => ('id' in ref ? `@${ref.id}` : String(ref.n))

export const parse = (args: string): Command => {
  const text = args.trim()

  // `--` makes the rest literal: `/queue -- list` queues the word "list".
  if (text === '--' || text.startsWith('-- ')) return { kind: 'message', text: text.slice(2).trim() }

  if (/^(list|clear|pause|resume)$/.test(text)) return { kind: text as 'list' | 'clear' | 'pause' | 'resume' }

  const targeted = /^(rm|send|up|down)\s+(\S+)$/.exec(text)
  if (targeted && REF.test(targeted[2] ?? '')) {
    return { kind: targeted[1] as 'rm' | 'send' | 'up' | 'down', ref: toRef(targeted[2] ?? '') }
  }

  const edit = /^edit\s+(\S+)(?:\s+([\s\S]+))?$/.exec(text)
  if (edit && REF.test(edit[1] ?? '')) return { kind: 'edit', ref: toRef(edit[1] ?? ''), text: edit[2] }

  return { kind: 'message', text }
}
