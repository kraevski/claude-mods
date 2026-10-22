// The desktop drawings: the band's rows and the reply row's pill, each one SVG. The desktop wraps sibling elements
// onto new lines, so a row's marks live in one drawing and only its buttons are elements beside it.

export const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"
const MONO = "ui-monospace,'SF Mono',Menlo,monospace"

// The tones, as the terminal's theme names them: accent (`suggestion`), success, warning, muted.
export type Tone = 'a' | 's' | 'w' | 'm'

// Drawn as an image, the SVG reads the theme from the color scheme. `f*` fills, `c*` text, `b*` a tinted ground.
const CSS = `<style>
.t{fill:#1f1f1f}.m{fill:#8a8a86}.k{fill:#e4e4e2}.inv{fill:#ffffff}
.fa,.ca{fill:#5769f7}.fs,.cs{fill:#2c7a39}.fw,.cw{fill:#966c1e}.fm,.cm{fill:#8a8a86}
.ba{fill:#5769f7;fill-opacity:.13}.bs{fill:#2c7a39;fill-opacity:.13}.bw{fill:#966c1e;fill-opacity:.14}.bm{fill:#8a8a86;fill-opacity:.14}
.ss{stroke:#2c7a39}
@media (prefers-color-scheme: dark){
.t{fill:#ececec}.m{fill:#9a9a96}.k{fill:#343432}.inv{fill:#1f1f1f}
.fa,.ca{fill:#b1b9f9}.fs,.cs{fill:#4eba65}.fw,.cw{fill:#e0b04a}.fm,.cm{fill:#9a9a96}
.ba{fill:#b1b9f9;fill-opacity:.16}.bs{fill:#4eba65;fill-opacity:.16}.bw{fill:#e0b04a;fill-opacity:.16}.bm{fill:#9a9a96;fill-opacity:.16}
.ss{stroke:#4eba65}}
.live{animation:p 1.6s ease-in-out infinite}@keyframes p{50%{opacity:.3}}
@media (prefers-reduced-motion: reduce){.live{animation:none}}
</style>`

const xml = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

// CJK, fullwidth forms and emoji advance about 1em.
const WIDE =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF01-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u

// Rough advance of system UI text, in em; good enough to size a slot. Monospace is 0.6em throughout.
const charEm = (ch: string): number =>
  WIDE.test(ch) ? 1 : /[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-ZА-ЯЁmwшщжюМШЩЖЮ@%]/.test(ch) ? 0.72 : 0.56

export const textWidth = (s: string, size: number, isMono = false): number =>
  [...s].reduce((w, ch) => w + (isMono && !WIDE.test(ch) ? 0.6 : charEm(ch)) * size, 0)

// Cuts `s` to fit `maxW` pixels, with an ellipsis when it had to cut. Line breaks read as spaces.
export const fitText = (s: string, size: number, maxW: number, isMono = false): string => {
  const flat = s.replace(/\s+/g, ' ').trim()
  if (textWidth(flat, size, isMono) <= maxW) return flat
  let out = ''
  for (const ch of flat) {
    if (textWidth(out + ch + '…', size, isMono) > maxW) break
    out += ch
  }
  return out + '…'
}

const svg = (W: number, H: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${CSS}${body}</svg>`

const text = (x: number, y: number, cls: string, size: number, s: string, extra = ''): string =>
  `<text class="${cls}" x="${x}" y="${y}" font-family="${FONT}" font-size="${size}"${extra}>${xml(s)}</text>`

// A strip of slots, one per waiting message, `lit` the one drawn in the accent; `pulse` animates it.
const slots = (x: number, y: number, count: number, lit: number, pulse: boolean): string =>
  Array.from({ length: count }, (_, i) => {
    const cls = i === lit ? `fa${pulse ? ' live' : ''}` : 'k'
    return `<rect class="${cls}" x="${x + i * (SLOT_W + SLOT_GAP)}" y="${y}" width="${SLOT_W}" height="6" rx="3"/>`
  }).join('')

const SLOT_W = 12
const SLOT_GAP = 3
const MAX_SLOTS = 10
const slotsWidth = (count: number): number => (count > 0 ? count * SLOT_W + (count - 1) * SLOT_GAP : 0)

export const HEADER_H = 22

// The band's first row: the state dot, "Queue", the summary, and a slot per waiting message at the right edge.
export const headerSvg = (W: number, count: number, summary: string, tone: Tone, isLive: boolean): string => {
  const shown = Math.min(count, MAX_SLOTS)
  const more = count > shown ? `+${count - shown}` : ''
  const moreW = more ? textWidth(more, 11) + 6 : 0
  const stripX = W - slotsWidth(shown) - moreW
  const titleW = textWidth('Queue', 13)
  const summaryX = Math.round(16 + titleW + 10)
  const summaryText = fitText(summary, 12.5, Math.max(0, stripX - summaryX - 14))
  const y = HEADER_H / 2 + 4.5
  return svg(
    W,
    HEADER_H,
    `<circle class="f${tone}${isLive ? ' live' : ''}" cx="5" cy="${HEADER_H / 2}" r="4"/>
${text(16, y, 't', 13, 'Queue', ' font-weight="600"')}
${text(summaryX, y, 'm', 12.5, summaryText)}
${slots(stripX, HEADER_H / 2 - 3, shown, 0, isLive && tone === 'a')}
${more ? text(W, y - 0.5, 'm', 11, more, ' text-anchor="end" font-variant-numeric="tabular-nums"') : ''}`,
  )
}

export const ROW_H = 26

// A waiting message: its number in a badge (solid for the next one out), the text, and a tag when it may have gone.
export const rowSvg = (W: number, n: number, body: string, opts: { isCommand: boolean; isDim: boolean; maybeSent: boolean }): string => {
  const cy = ROW_H / 2
  const tag = opts.maybeSent ? 'may have been sent' : ''
  const tagW = tag ? Math.round(textWidth(tag, 11) + 14) : 0
  const textX = 30
  const maxW = Math.max(20, W - textX - (tag ? tagW + 8 : 0) - 4)
  const shown = fitText(body, 13, maxW, opts.isCommand)
  const font = opts.isCommand ? MONO : FONT
  const size = opts.isCommand ? 12.5 : 13
  const cls = opts.isDim ? 'm' : 't'
  const number = String(n)
  return svg(
    W,
    ROW_H,
    `<circle class="${n === 1 ? 'fa' : 'ba'}" cx="11" cy="${cy}" r="9.5"/>
<text class="${n === 1 ? 'inv' : 'ca'}" x="11" y="${cy + 4}" text-anchor="middle" font-family="${FONT}" font-size="11" font-weight="600" font-variant-numeric="tabular-nums">${number}</text>
<text class="${cls}" x="${textX}" y="${cy + 4.5}" font-family="${font}" font-size="${size}">${xml(shown)}</text>
${
  tag
    ? `<rect class="bw" x="${W - tagW}" y="${cy - 9}" width="${tagW}" height="18" rx="9"/>${text(W - tagW / 2, cy + 4, 'cw', 11, tag, ' text-anchor="middle" font-weight="500"')}`
    : ''
}`,
  )
}

export const PILL_H = 22

// The reply row's pill: a tinted chip with its mark, then the status, then the slot strip, then an edit note.
export type Pill = {
  label: string
  tone: Tone
  mark: 'dot' | 'live' | 'check' | 'none'
  status?: string
  // The message's place among `of` waiting messages, drawn as the band's strip.
  place?: { at: number; of: number }
  note?: string
}

const NOTE_MAX = 300

export const pillSvg = (p: Pill): { source: string; width: number } => {
  const cy = PILL_H / 2
  const markW = p.mark === 'none' ? 0 : 14
  const chipW = Math.round(10 + markW + textWidth(p.label, 11.5) + 10)
  const parts: string[] = [`<rect class="b${p.tone}" x="0" y="1" width="${chipW}" height="${PILL_H - 2}" rx="${(PILL_H - 2) / 2}"/>`]

  if (p.mark === 'dot' || p.mark === 'live') {
    parts.push(`<circle class="f${p.tone}${p.mark === 'live' ? ' live' : ''}" cx="14" cy="${cy}" r="3.5"/>`)
  } else if (p.mark === 'check') {
    parts.push(
      `<path class="ss" d="M10 ${cy}l3 3 5.5-6" fill="none" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
    )
  }
  parts.push(text(10 + markW, cy + 4, `c${p.tone}`, 11.5, p.label, ' font-weight="600" font-variant-numeric="tabular-nums"'))

  let x = chipW + 8
  if (p.status) {
    parts.push(text(x, cy + 4.5, 'm', 12, p.status))
    x += Math.round(textWidth(p.status, 12)) + 10
  }
  if (p.place && p.place.of > 1) {
    const shown = Math.min(p.place.of, MAX_SLOTS)
    const lit = Math.min(p.place.at, shown) - 1
    parts.push(slots(x, cy - 3, shown, lit, false))
    x += slotsWidth(shown) + 10
  }
  if (p.note) {
    const note = fitText(p.note, 12, NOTE_MAX)
    parts.push(text(x, cy + 4.5, 'm', 12, note, ' font-style="italic"'))
    x += Math.round(textWidth(note, 12)) + 4
  }

  const width = Math.max(chipW, x - 6)
  return { source: svg(width, PILL_H, parts.join('\n')), width }
}
