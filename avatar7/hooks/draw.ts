// The face as the pane draws it: the portrait tinted by the mood, glitched on
// a refusal, scanlined, framed like a comm window and cut out over the scene
// behind it. Pure: register.tsx hands it a View, once per frame, and blits
// the cells.

import { ambientPixel, QUAD, type AmbientLayer, type Field } from './ambient'
import type { Mood } from './mood'
import type { Hd } from './hd'

// Portraits are baked by tools/bake.py into W x H raw RGB pixels; each cell
// is an upper half block, so two pixel rows per cell row.
export const W = 64
export const H = 64

// The comm window's corner brackets, in face pixels.
const BRACKET = 7

export const TINT: Record<Mood, number> = {
  idle: 0x000000,
  watch: 0x00e5ff,
  deny: 0xff2a6d,
  error: 0xffb000,
  wait: 0x7a5cff,
}

// Cheap deterministic noise for the glitch.
export const noise = (a: number, b: number): number => {
  let n = (a * 374761393 + b * 668265263) | 0
  n = Math.imul(n ^ (n >>> 13), 1274126177)
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296
}

// `hd`: the same faces as real images (hd.ts), where the terminal draws them
// and tools/bake_hd.py has baked them; null otherwise.
export type Faces = { base: Uint8Array; talk: Uint8Array | null; deny: Uint8Array | null; hd?: Hd | null }

// Which face to draw now: the frown on a refusal or a failure, the mouth
// flapping at an uneven pace while the voice is heard, else the portrait.
export const pickFace = <T,>(faces: { base: T; talk: T | null; deny: T | null }, mood: string, isSpeaking: boolean, flap: number): T =>
  (mood === 'deny' || mood === 'error') && faces.deny !== null
    ? faces.deny
    : isSpeaking && faces.talk !== null && flap < 0.55
      ? faces.talk
      : faces.base

// Everything a frame of the face depends on.
export type View = {
  frame: number
  frameMs: number
  mood: Mood
  // The faces of whoever is shown (the guest's during a visit), and that
  // persona's frame color, cutout and weather; null while none is loaded.
  faces: Faces | null
  persona: { color?: string; cutout?: number } | null
  isHeard: boolean
  // How hard a refusal glitches the portrait: 1 for a call denied, less for
  // a refusal the persona acts in a scene of its own.
  glitch: number
  // The face's side in output pixels.
  size: number
  layers: AmbientLayer[]
  field: Field
  ambLeft: number
  ambT: number
}

// A portrait pixel, x and y in W x H.
export const facePixel = (v: View, x: number, y: number): number => {
  const t = v.frame * (v.frameMs / 1000)
  const isGlitch = v.mood === 'deny' && noise(v.frame, y >> 2) < 0.35 * v.glitch
  const gx = isGlitch ? Math.min(W - 1, Math.max(0, x + Math.round((noise(y, v.frame) - 0.5) * 10 * v.glitch))) : x

  const img = v.faces === null ? null : pickFace(v.faces, v.mood, v.isHeard, noise(v.frame >> 2, 7))
  if (img === null || v.persona === null) return noise(x * 7 + v.frame, y) < 0.3 ? 0x1a2a22 : 0x020806

  const i = (y * W + gx) * 3
  let r = img[i] ?? 0
  let g = img[i + 1] ?? 0
  let b = img[i + 2] ?? 0
  // No eye glow, blink or pulse for now: on several portraits the ellipses
  // missed the eyes and read as smudges. `eyes` and `mouth` stay in each
  // persona.json for a better effect.
  let k = 1

  // Mood: pull the portrait toward the mood's color by its luminance.
  if (v.mood !== 'idle') {
    const lum = (0.3 * r + 0.59 * g + 0.11 * b) / 255
    const tint = TINT[v.mood]
    const mix = v.mood === 'watch' ? 0.3 : v.mood === 'wait' ? 0.45 : 0.65
    r = r * (1 - mix) + ((tint >> 16) & 0xff) * lum * 1.3 * mix
    g = g * (1 - mix) + ((tint >> 8) & 0xff) * lum * 1.3 * mix
    b = b * (1 - mix) + (tint & 0xff) * lum * 1.3 * mix
  }

  // Holding its breath while a human decides.
  if (v.mood === 'wait') k *= 0.8 + 0.2 * Math.sin(t * 2.5)

  // Snow when glitching; the scanlines are drawn at the output size.
  if (isGlitch && noise(x, y + v.frame) < 0.04 * v.glitch) return 0xffffff

  const c = (n: number) => Math.min(255, Math.round(n * k))
  return (c(r) << 16) | (c(g) << 8) | c(b)
}

// One output pixel averages the block of portrait pixels it covers, so the
// face shrinks with the pane and keeps its features.
export const faceSample = (v: View, ox: number, oy: number): number => {
  const { size } = v
  const x0 = Math.floor((ox * W) / size)
  const x1 = Math.max(x0 + 1, Math.floor(((ox + 1) * W) / size))
  const y0 = Math.floor((oy * H) / size)
  const y1 = Math.max(y0 + 1, Math.floor(((oy + 1) * H) / size))
  let r = 0
  let g = 0
  let b = 0
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const p = facePixel(v, x, y)
      r += (p >> 16) & 0xff
      g += (p >> 8) & 0xff
      b += p & 0xff
    }
  }
  const n = (x1 - x0) * (y1 - y0)
  let k = oy % 2 === 1 ? 0.7 : 1
  if (oy === Math.floor((v.frame * 0.8 * size) / H) % size) k *= 1.35
  const c = (s: number) => Math.min(255, Math.round((s / n) * k))
  const drawn = (c(r) << 16) | (c(g) << 8) | c(b)
  // A comm window's frame: bright brackets at the corners, a faint line
  // along the edges, in the persona's color or the mood's.
  const edge = Math.min(ox, oy, size - 1 - ox, size - 1 - oy)
  if (edge === 0 && v.layers.length > 0) {
    const isCorner = Math.min(ox, size - 1 - ox) < BRACKET && Math.min(oy, size - 1 - oy) < BRACKET
    const tone = v.mood === 'idle' ? parseInt((v.persona?.color ?? '#00ff9c').slice(1), 16) : TINT[v.mood]
    const kk = isCorner ? 1 : 0.3
    return (Math.round(((tone >> 16) & 0xff) * kk) << 16) | (Math.round(((tone >> 8) & 0xff) * kk) << 8) | Math.round((tone & 0xff) * kk)
  }
  // The portrait's dark background lets the scene behind it through, by
  // degrees so its edge does not ring.
  if (v.layers.length === 0) return drawn
  const cutout = v.persona?.cutout ?? 12
  const alpha = Math.min(1, Math.max(0, ((0.3 * r + 0.59 * g + 0.11 * b) / n - cutout) / (cutout * 2 + 4)))
  if (alpha === 1) return drawn
  const back = ambientPixel(v.layers, v.field, (v.ambLeft + ox) * QUAD, oy, v.ambT, v.mood === 'deny')
  const mix = (shift: number) => Math.round(((drawn >> shift) & 0xff) * alpha + ((back >> shift) & 0xff) * (1 - alpha)) << shift
  return mix(16) | mix(8) | mix(0)
}

// The Raster's cells for the face: one upper half block per cell, its two
// pixels as foreground and background, base64 as the Raster takes them.
export const faceCells = (v: View): string => {
  const rows = v.size / 2
  const words = new Uint32Array(v.size * rows * 3)
  for (let row = 0; row < rows; row++) {
    for (let x = 0; x < v.size; x++) {
      const i = (row * v.size + x) * 3
      words[i] = 0x2580
      words[i + 1] = faceSample(v, x, row * 2)
      words[i + 2] = faceSample(v, x, row * 2 + 1)
    }
  }
  return new Uint8Array(words.buffer).toBase64()
}
