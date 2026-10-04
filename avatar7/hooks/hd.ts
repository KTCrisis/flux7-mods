// The pane as real images, where the terminal draws pictures (kitty,
// Ghostty): the band of the face and the band under the text, each the pane
// wide, in art pixels of a chosen grain. The weather (ambient.ts) is drawn on
// its own field as the half blocks draw it; the scene on that field made finer
// by the grain; the portrait at its baked resolution cut out over them,
// tinted by the mood, torn on a refusal, scanlined and framed like a comm
// window. Pure, as draw.ts is: register.tsx hands it an HdView, writes each
// picture once and swaps them as the weather loops.

import { ambientPixel, QUAD, type AmbientLayer, type Field } from './ambient'
import { noise, pickFace, TINT } from './draw'
import type { Mood } from './mood'

// Output pixels per terminal column; a row is twice as tall. Kitty scales
// the picture to the cells, so this is the detail kept, not a size on screen.
export const PX = 6

// The tears a refusal cycles through: a finite set, so each is made once.
export const GLITCH_STEPS = 6

// The pictures tools/bake_hd.py writes beside a persona's PNGs: the portrait
// and its frames, `side` x `side` RGB, and the scene, RGB too.
export type Hd = {
  side: number
  base: Uint8Array
  talk: Uint8Array | null
  deny: Uint8Array | null
  scene: { pixels: Uint8Array; width: number; height: number } | null
  // A print of the bytes above, so a picture baked again never meets a file
  // made from the old one.
  stamp?: string
}

export type HdView = {
  // Whose pane, and which band of it: two personas may share a color, never
  // a picture.
  who: string
  band: 'face' | 'under'
  // The faces; null for the band under the text.
  hd: Hd | null
  mood: Mood
  // Which face: the frown, the open mouth or the portrait (draw.ts pickFace).
  face: 'base' | 'talk' | 'deny'
  // The glitch's draw: one of GLITCH_STEPS tears while a refusal shows, 0 else.
  glitchStep: number
  glitch: number
  // The art pixel's side in output pixels (GRAINS).
  grain: number
  color: string
  cutout: number
  // The band in cells; the face is `size` columns wide (size / 2 rows),
  // centered, 0 for none.
  columns: number
  rows: number
  size: number
  // The weather and its field (ambient.ts), the band's first field row, the
  // weather's time and its step in the loop (the key's share of it).
  layers: AmbientLayer[]
  field: Field
  top: number
  t: number
  step: number
  isStorm: boolean
  stamp?: string
}

// How bright the scene stays behind the face, and the scanlines.
const SCANLINE = 0.8

const hex = (s: string): number => {
  const h = s.replace('#', '')
  return /^[0-9a-f]{6}$/i.test(h) ? parseInt(h, 16) : 0x00ff9c
}

// The face to draw now, by the same rule as the half-block pane.
export const pickHdFace = (hd: Hd, mood: string, isSpeaking: boolean, flap: number): HdView['face'] =>
  pickFace({ base: 'base', talk: hd.talk === null ? null : 'talk', deny: hd.deny === null ? null : 'deny' } as const, mood, isSpeaking, flap)

// What decides the picture: equal keys, equal pixels.
export const hdKey = (v: HdView): string =>
  [v.who, v.band, v.hd === null ? '-' : v.face, v.mood, v.glitchStep, v.grain, v.columns, v.rows, v.size, v.top, v.step, v.isStorm ? 's' : '', v.color, v.cutout, v.hd?.side ?? 0, v.stamp ?? ''].join('|')

// While the pane is being resized, each column brings a new size and the
// pictures for it would be made at every render; the band keeps its last
// picture, stretched by the terminal, until the size has held SETTLE_FRAMES.
export const SETTLE_FRAMES = 6
export type Settle = { size: string; since: number }
export const isSettled = (s: Settle, size: string, frame: number): boolean => {
  if (s.size !== size) {
    s.size = size
    s.since = frame
  }
  return frame - s.since >= SETTLE_FRAMES
}

// FNV-1a over a sample of the bytes: enough to tell two bakes apart.
export const hdStamp = (...parts: (Uint8Array | null)[]): string => {
  let h = 0x811c9dc5
  for (const p of parts) {
    if (p === null) continue
    for (let i = 0; i < p.length; i += 97) h = Math.imul(h ^ (p[i] ?? 0), 0x01000193)
  }
  return (h >>> 0).toString(36)
}

export const hdSize = (columns: number, rows: number): { width: number; height: number } => ({ width: columns * PX, height: rows * 2 * PX })

// One art pixel is `grain` output pixels a side: 6 is the half blocks' own
// grid (one pixel a column), 3 twice as fine, 1 the bake's full detail. Each
// art pixel averages what it covers, as the half blocks do, and the
// scanlines darken every other art row.
export const GRAINS = [1, 2, 3, 6] as const
export const DEFAULT_GRAIN = 3

// A field pixel is half a column wide and half a row tall: 3 x 6 output
// pixels. The scene's field is made `6 / grain` times finer.
const FIELD_X = PX / QUAD
const FIELD_Y = PX

const addRgb = (a: number, b: number): number =>
  (Math.min(255, ((a >> 16) & 0xff) + ((b >> 16) & 0xff)) << 16) |
  (Math.min(255, ((a >> 8) & 0xff) + ((b >> 8) & 0xff)) << 8) |
  Math.min(255, (a & 0xff) + (b & 0xff))

export const hdFrame = (v: HdView): Uint8Array => {
  const { width, height } = hdSize(v.columns, v.rows)
  const out = new Uint8Array(width * height * 4)
  const hd = v.hd
  const img = hd === null ? null : (hd[v.face] ?? hd.base)
  const S = hd?.side ?? 0
  const side = hd === null ? 0 : v.size * PX
  const left = Math.floor((v.columns - v.size) / 2) * PX
  const isDeny = v.mood === 'deny'
  const tint = TINT[v.mood]
  const mix = v.mood === 'watch' ? 0.3 : v.mood === 'wait' ? 0.45 : 0.65
  const tone = v.mood === 'idle' ? hex(v.color) : tint
  const g = Math.max(1, Math.round(v.grain))
  const k = Math.max(1, Math.round(PX / g))
  const fine: Field = { width: v.field.width * k, height: v.field.height * k, sceneTop: v.field.sceneTop * k, sceneBottom: v.field.sceneBottom * k }
  const scenes = v.layers.filter(l => l.kind === 'scene')
  const weather = v.layers.filter(l => l.kind !== 'scene')
  const bracket = Math.max(6, Math.round(side * 0.11))
  // The frame's line: two output pixels, or one art pixel when coarser.
  const rim = Math.max(2, g)
  // The glitch tears the face into bands, a few of them shifted sideways.
  const bands = 16
  const shiftOf = (y: number): number => {
    if (!isDeny || v.glitch === 0 || side === 0) return 0
    const band = Math.floor((y * bands) / side)
    return noise(v.glitchStep, band) < 0.35 * v.glitch ? Math.round((noise(band, v.glitchStep) - 0.5) * side * 0.08 * v.glitch) : 0
  }

  // The color at an output point, before scanlines: the scene and the
  // weather, the face over them.
  const rgb = [0, 0, 0]
  const at = (x: number, y: number): void => {
    let back = 0
    if (scenes.length > 0) back = ambientPixel(scenes, fine, Math.floor((x * k) / FIELD_X), v.top * k + Math.floor((y * k) / FIELD_Y), v.t, v.isStorm)
    if (weather.length > 0) back = addRgb(back, ambientPixel(weather, v.field, Math.floor(x / FIELD_X), v.top + Math.floor(y / FIELD_Y), v.t, v.isStorm))
    let r = (back >> 16) & 0xff
    let gg = (back >> 8) & 0xff
    let b = back & 0xff
    const fx = x - left
    if (img !== null && fx >= 0 && fx < side && y < side) {
      const gx = Math.min(side - 1, Math.max(0, Math.floor(fx + shiftOf(y))))
      const i = (Math.floor((y * S) / side) * S + Math.floor((gx * S) / side)) * 3
      let fr = img[i] ?? 0
      let fg = img[i + 1] ?? 0
      let fb = img[i + 2] ?? 0
      const lum = 0.3 * fr + 0.59 * fg + 0.11 * fb
      if (v.mood !== 'idle') {
        const l = (lum / 255) * 1.3 * mix
        fr = fr * (1 - mix) + ((tint >> 16) & 0xff) * l
        fg = fg * (1 - mix) + ((tint >> 8) & 0xff) * l
        fb = fb * (1 - mix) + (tint & 0xff) * l
      }
      if (v.mood === 'wait') {
        fr *= 0.9
        fg *= 0.9
        fb *= 0.9
      }
      // The portrait's dark background lets what is behind it through, by degrees.
      const alpha = Math.min(1, Math.max(0, (lum - v.cutout) / (v.cutout * 2 + 4)))
      r = fr * alpha + r * (1 - alpha)
      gg = fg * alpha + gg * (1 - alpha)
      b = fb * alpha + b * (1 - alpha)
    }
    rgb[0] = r
    rgb[1] = gg
    rgb[2] = b
  }

  // Up to 3 x 3 samples an art pixel: enough to average a coarse grain.
  const n = Math.min(3, g)
  for (let y0 = 0; y0 < height; y0 += g) {
    const line = (g === 1 ? y0 % 2 : (y0 / g) % 2) === 1 ? SCANLINE : 1
    for (let x0 = 0; x0 < width; x0 += g) {
      let r = 0
      let gg = 0
      let b = 0
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          at(Math.min(width - 1, x0 + ((i + 0.5) * g) / n), Math.min(height - 1, y0 + ((j + 0.5) * g) / n))
          r += rgb[0] ?? 0
          gg += rgb[1] ?? 0
          b += rgb[2] ?? 0
        }
      }
      r /= n * n
      gg /= n * n
      b /= n * n
      // The comm window: bright brackets at the corners, a faint line between.
      const fx = x0 - left
      if (side > 0 && fx >= 0 && fx < side && y0 < side) {
        const edge = Math.min(fx, y0, side - g - fx, side - g - y0)
        if (edge < rim) {
          const isCorner = Math.min(fx, side - 1 - fx) < bracket && Math.min(y0, side - 1 - y0) < bracket
          const kk = isCorner ? 1 : edge < Math.max(1, g) ? 0.3 : -1
          if (kk > 0) {
            r = ((tone >> 16) & 0xff) * kk
            gg = ((tone >> 8) & 0xff) * kk
            b = (tone & 0xff) * kk
          }
        } else if (shiftOf(y0) !== 0 && noise(x0, y0 + v.glitchStep) < 0.02 * v.glitch) r = gg = b = 255
      }
      const cr = Math.min(255, Math.round(r * line))
      const cg = Math.min(255, Math.round(gg * line))
      const cb = Math.min(255, Math.round(b * line))
      for (let y = y0; y < Math.min(height, y0 + g); y++) {
        for (let x = x0; x < Math.min(width, x0 + g); x++) {
          const o = (y * width + x) * 4
          out[o] = cr
          out[o + 1] = cg
          out[o + 2] = cb
          out[o + 3] = 255
        }
      }
    }
  }
  return out
}
