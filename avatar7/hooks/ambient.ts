// Pixel weather in the black around the face: one or two layers per persona,
// read from its persona.json `ambient`. Every pixel is a function of its place
// and the ambient's own time through hashed noise, so no drop is kept; only
// the fitted scene and the current bolt are cached.

export type AmbientKind = 'rain' | 'rise' | 'wind' | 'stars' | 'bolt' | 'pulse' | 'scene' | 'grid'

// density: the share of columns, rows or pixels that carry something (0-1);
// speed: pixels a second for what moves, the twinkle's pace for stars.
// scene: a backdrop baked by tools/bake_scene.py, `file` of `width` x `height`
// pixels, its bytes attached as `pixels` when the persona loads.
export type AmbientLayer = {
  kind: AmbientKind
  color: string
  density?: number
  speed?: number
  file?: string
  width?: number
  height?: number
  pixels?: Uint8Array
  // What moves in a scene: blinking red beacons, flickering neon signs,
  // windows going dark; none when absent, the backdrop then stays still.
  animate?: ('beacons' | 'neon' | 'windows')[]
  // grid: where its horizon sits, as a share of the scene's height up from
  // the scene's bottom (its sea line); the floor runs down to the field's.
  sea?: number
}

// The field the layers draw on: the pane's width, two pixels per column, and
// the face's height plus the band under the text, two pixels per row. A cell
// is drawn as a quadrant block (2x2), so its pixels are half as wide as tall:
// QUAD of them across make one square. A scene covers the field from its top
// down to `sceneBottom`: behind the face, then a few rows past the text.
export type Field = { width: number; height: number; sceneBottom: number }
export const QUAD = 2

// How bright the weather may get against the face: it stays behind it.
const DIM = 0.5

const hash = (a: number, b: number, c = 0): number => {
  let n = (a * 374761393 + b * 668265263 + c * 2147483647) | 0
  n = Math.imul(n ^ (n >>> 13), 1274126177)
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296
}

const rgb = (hex: string): number => parseInt(hex.replace('#', ''), 16) || 0xffffff

const scale = (c: number, k: number): number =>
  (Math.min(255, Math.round(((c >> 16) & 0xff) * k)) << 16) |
  (Math.min(255, Math.round(((c >> 8) & 0xff) * k)) << 8) |
  Math.min(255, Math.round((c & 0xff) * k))

// A streak running along one line, its head brightest: rain down a column,
// wind along a row. Returns the light at `at` on that line, 0 when dark.
const streak = (line: number, at: number, length: number, t: number, speed: number, trail: number, density: number, salt: number): number => {
  if (hash(line, salt) >= density) return 0
  const period = length + trail + Math.floor(hash(line, salt + 1) * length)
  const head = (t * speed * (0.7 + 0.6 * hash(line, salt + 2)) + hash(line, salt + 3) * period) % period
  const d = head - at
  return d >= 0 && d < trail ? 1 - d / trail : 0
}

// A scene fitted to the field's width, anchored to its bottom, its top fading
// into the black; each pixel sorted once so the right ones move: red lights
// on the antennas blink, neon signs flicker, windows go dark and light again.
const STILL = 0
const BEACON = 1
const NEON_SIGN = 2
const WINDOW = 3
// The backdrop stays a little under full light, behind the face.
const SCENE = 0.8
// fitted: the whole scene's height once scaled, cropped sky included.
type Scene = { width: number; height: number; fitted: number; rgb: Uint32Array; sort: Uint8Array }
let sceneOf: Uint8Array | null = null
let sceneWidth = 0
let scene: Scene = { width: 0, height: 0, fitted: 0, rgb: new Uint32Array(0), sort: new Uint8Array(0) }

const fitScene = (layer: AmbientLayer, f: Field): Scene | null => {
  const px = layer.pixels
  const sw = layer.width ?? 0
  const sh = layer.height ?? 0
  if (px === undefined || sw === 0 || sh === 0 || f.width === 0 || f.sceneBottom <= 0) return null
  if (px === sceneOf && f.width === sceneWidth && f.sceneBottom === scene.height) return scene
  // Cover the region, as a CSS background does: scaled until both sides fill
  // it, centered across, the ground kept and the sky cropped.
  const w = f.width
  const h = f.sceneBottom
  const k = Math.max(w / QUAD / sw, h / sh)
  const left = (sw * k - w / QUAD) / 2
  const top = sh * k - h
  const rgbOut = new Uint32Array(w * h)
  const sort = new Uint8Array(w * h)
  const lums = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const y0 = Math.min(sh - 1, Math.floor((y + top) / k))
    const y1 = Math.max(y0 + 1, Math.min(sh, Math.floor((y + 1 + top) / k)))
    // Faded into the black at the top, and at the bottom where it runs out
    // under the text.
    const fade = Math.min(1, y / (h * 0.2), (h - 1 - y) / (h * 0.12))
    for (let x = 0; x < w; x++) {
      const x0 = Math.min(sw - 1, Math.floor((x / QUAD + left) / k))
      const x1 = Math.max(x0 + 1, Math.min(sw, Math.floor(((x + 1) / QUAD + left) / k)))
      // The block's mean, but a beacon or a sign keeps its strongest pixel:
      // averaged, a light one pixel wide would sink into the night.
      let r = 0
      let g = 0
      let b = 0
      let best = -1
      let bestColor = 0
      let bestSort = STILL
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * sw + sx) * 3
          const pr = px[i]
          const pg = px[i + 1]
          const pb = px[i + 2]
          r += pr
          g += pg
          b += pb
          const max = Math.max(pr, pg, pb)
          const sat = max === 0 ? 0 : (max - Math.min(pr, pg, pb)) / max
          const isBeacon = pr > 140 && pg < pr * 0.5 && pb < pr * 0.5
          const isSign = !isBeacon && sat > 0.45 && max > 150
          if ((isBeacon || isSign) && max > best) {
            best = max
            bestColor = (pr << 16) | (pg << 8) | pb
            bestSort = isBeacon ? BEACON : NEON_SIGN
          }
        }
      }
      const n = (x1 - x0) * (y1 - y0)
      const mean = ((Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(b / n)) >>> 0
      const lum = (0.3 * r + 0.59 * g + 0.11 * b) / n
      const at = y * w + x
      rgbOut[at] = scale(best >= 0 ? bestColor : mean, fade)
      sort[at] = best >= 0 ? bestSort : STILL
      lums[at] = lum
    }
  }
  // A window is a point of light: brighter than the pixels around it, not a
  // lit wall or a patch of sky, which would go dark in specks.
  // A sign stands out from what is beside it; a saturated sky does not, and
  // would flicker in bars. Signs are upright strips: compare left and right.
  const SIDE = 4
  for (let y = 2; y < h - 2; y++) {
    for (let x = SIDE; x < w - SIDE; x++) {
      const at = y * w + x
      if (sort[at] !== NEON_SIGN) continue
      let beside = 0
      for (const dy of [-2, 0, 2]) beside += lums[at + dy * w - SIDE] + lums[at + dy * w + SIDE]
      if (lums[at] < 1.3 * (beside / 6)) sort[at] = STILL
    }
  }
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const at = y * w + x
      if (sort[at] !== STILL || lums[at] < 60) continue
      let around = 0
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) around += lums[at + dy * w + dx]
      if (lums[at] > 1.35 * ((around - lums[at]) / 8)) sort[at] = WINDOW
    }
  }
  sceneOf = px
  sceneWidth = w
  scene = { width: w, height: h, fitted: sh * k, rgb: rgbOut, sort }
  return scene
}

// The scene's color at a field pixel, or -1 where it does not reach.
const scenePixel = (layer: AmbientLayer, f: Field, x: number, y: number, t: number): number => {
  const s = fitScene(layer, f)
  if (s === null) return -1
  const sy = y
  if (sy >= s.height || x >= s.width) return -1
  const at = sy * s.width + x
  let k = SCENE
  const moves = layer.animate ?? []
  const sort = s.sort[at]
  if (!(sort === BEACON ? moves.includes('beacons') : sort === NEON_SIGN ? moves.includes('neon') : sort === WINDOW && moves.includes('windows'))) {
    return scale(s.rgb[at], k)
  }
  switch (sort) {
    case BEACON:
      k *= (t * 0.8 + hash(x >> 1, sy >> 1, 77)) % 1 < 0.6 ? 1 : 0.2
      break
    case NEON_SIGN:
      k *= hash(x >> 2, Math.floor(t * 6), 78) < 0.03 ? 0.3 : 1
      break
    case WINDOW:
      k *= hash(x, sy, Math.floor(t / 4 + hash(x, sy, 79) * 7)) < 0.15 ? 0.45 : 1
      break
  }
  return scale(s.rgb[at], k)
}

// A bolt strikes in a slot of 0.4 s: rarely on its own, every slot while
// `isStorm`. Its path is cached for the slot.
let boltFor = ''
let boltPath: number[] = []
const bolt = (f: Field, t: number, isStorm: boolean): number[] | null => {
  const slot = Math.floor(t / 0.4)
  if (!isStorm && hash(slot, 51) >= 0.03) return null
  if (isStorm && hash(slot, 52) >= 0.5) return null
  const id = `${slot}:${f.width}x${f.height}`
  if (id !== boltFor) {
    boltPath = []
    let x = Math.floor(hash(slot, 53) * f.width)
    for (let y = 0; y < f.height; y++) {
      x += Math.round((hash(slot, y, 54) - 0.5) * 3)
      boltPath.push(x)
    }
    boltFor = id
  }
  return boltPath
}

// One layer's light at a pixel, 0 to 1.
const light = (layer: AmbientLayer, f: Field, x: number, y: number, t: number, isStorm: boolean): number => {
  const density = layer.density
  const speed = layer.speed
  switch (layer.kind) {
    case 'rain':
      return streak(x, y, f.height, t, speed ?? 24, 6, density ?? 0.25, 1)
    case 'wind':
      return streak(y, x, f.width, t, (speed ?? 40) * QUAD, 12 * QUAD, density ?? 0.12, 11)
    case 'rise': {
      // Up a column, swaying a pixel either side, fading as it climbs.
      for (let c = x - 1; c <= x + 1; c++) {
        if (hash(c, 21) >= (density ?? 0.15)) continue
        const period = f.height + Math.floor(hash(c, 22) * f.height)
        const climbed = (t * (speed ?? 8) * (0.6 + 0.8 * hash(c, 23)) + hash(c, 24) * period) % period
        const py = Math.round(f.height - climbed)
        const px = c + Math.round(Math.sin(t * 1.7 + c) * 1)
        if (px === x && (py === y || py === y + 1)) return Math.max(0.15, py / f.height) * (py === y ? 1 : 0.5)
      }
      return 0
    }
    case 'stars': {
      if (hash(x, y, 31) >= (density ?? 0.015) / QUAD) return 0
      return 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(t * (speed ?? 1) * (0.5 + hash(x, y, 32)) + hash(x, y, 33) * 6.28))
    }
    case 'bolt': {
      const path = bolt(f, t, isStorm)
      if (path === null) return 0
      const d = Math.abs(path[y] - x)
      return d === 0 ? 1 : d === 1 ? 0.25 : 0
    }
    case 'scene':
      // Drawn in color by scenePixel.
      return 0
    case 'grid': {
      // An outrun floor: rows closer together toward the horizon, scrolling
      // toward the viewer; rays fanning out from its middle.
      const fitted = scene.height === f.sceneBottom && scene.width === f.width ? scene.fitted : f.sceneBottom
      const horizon = Math.round(f.sceneBottom - fitted * (layer.sea ?? 0.15))
      if (y < horizon) return 0
      if (y === horizon) return 1
      const depth = (y - horizon) / (f.height - horizon)
      // One pixel row spans this much of the floor: a line lands on the row
      // that holds it, so lines stay one pixel thin up to the horizon.
      const near = 4 / depth
      const far = 4 / ((y - horizon + 1) / (f.height - horizon))
      const shift = t * (speed ?? 1.5)
      const isRow = Math.floor(near + shift) !== Math.floor(far + shift)
      const ray = ((x - f.width / 2) * depth) / (6 * QUAD)
      const isRay = Math.abs(ray - Math.round(ray)) < 0.5 * depth / 6 + 0.04
      return isRow || isRay ? 0.35 + 0.65 * depth : 0
    }
    case 'pulse': {
      // Wires every 9 rows, a bright pulse running along each.
      if (y % 9 !== 4) return 0
      const wire = Math.floor(y / 9)
      const at = (t * (speed ?? 30) * QUAD + hash(wire, 61) * (f.width + 20)) % (f.width + 20)
      const d = Math.abs(at - x) / QUAD
      return d < 3 ? 1 - d / 3 : 0.12
    }
  }
}

// Light added to light, each channel capped: a faint drop over a bright sky
// brightens it a little instead of punching a dark hole in it.
const add = (a: number, b: number): number =>
  (Math.min(255, ((a >> 16) & 0xff) + ((b >> 16) & 0xff)) << 16) |
  (Math.min(255, ((a >> 8) & 0xff) + ((b >> 8) & 0xff)) << 8) |
  Math.min(255, (a & 0xff) + (b & 0xff))

// The color of a field pixel: a scene lays its backdrop, the layers above
// add their light to it; black when nothing does. `isStorm` raises bolts on
// a refusal.
export const ambientPixel = (layers: AmbientLayer[], f: Field, x: number, y: number, t: number, isStorm: boolean): number => {
  let out = 0
  for (const layer of layers) {
    if (layer.kind === 'scene') {
      const c = scenePixel(layer, f, x, y, t)
      if (c >= 0) out = c
      continue
    }
    const k = light(layer, f, x, y, t, isStorm)
    if (k > 0) out = add(out, scale(rgb(layer.color), k * DIM))
  }
  return out
}

// Quadrant blocks by the mask of their lit quarters: upper left 1, upper
// right 2, lower left 4, lower right 8.
const QUADRANTS = [0x20, 0x2598, 0x259d, 0x2580, 0x2596, 0x258c, 0x259e, 0x259b, 0x2597, 0x259a, 0x2590, 0x259c, 0x2584, 0x2599, 0x259f, 0x2588]

const distance = (a: number, b: number): number =>
  Math.abs(((a >> 16) & 0xff) - ((b >> 16) & 0xff)) + Math.abs(((a >> 8) & 0xff) - ((b >> 8) & 0xff)) + Math.abs((a & 0xff) - (b & 0xff))

const mean = (colors: number[]): number => {
  let r = 0
  let g = 0
  let b = 0
  for (const c of colors) {
    r += (c >> 16) & 0xff
    g += (c >> 8) & 0xff
    b += c & 0xff
  }
  const n = colors.length
  return (Math.round(r / n) << 16) | (Math.round(g / n) << 8) | Math.round(b / n)
}

// A Raster's cells for the field's rectangle at column x0 and pixel row y0,
// `columns` wide and `rows` tall. Each cell holds four pixels and shows two
// colors, as chafa does: the two most different quarters lead, each other
// quarter joins the nearer one, and the glyph draws the first group.
export const ambientCells = (layers: AmbientLayer[], f: Field, x0: number, y0: number, columns: number, rows: number, t: number, isStorm: boolean): string => {
  const words = new Uint32Array(columns * rows * 3)
  const q = [0, 0, 0, 0]
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const i = (row * columns + col) * 3
      const x = (x0 + col) * QUAD
      const y = y0 + row * 2
      q[0] = ambientPixel(layers, f, x, y, t, isStorm)
      q[1] = ambientPixel(layers, f, x + 1, y, t, isStorm)
      q[2] = ambientPixel(layers, f, x, y + 1, t, isStorm)
      q[3] = ambientPixel(layers, f, x + 1, y + 1, t, isStorm)
      let a = 0
      let b = 1
      let far = -1
      for (let m = 0; m < 4; m++) {
        for (let n = m + 1; n < 4; n++) {
          const d = distance(q[m], q[n])
          if (d > far) {
            far = d
            a = m
            b = n
          }
        }
      }
      let mask = 0
      const lit: number[] = []
      const dark: number[] = []
      for (let m = 0; m < 4; m++) {
        if (distance(q[m], q[a]) <= distance(q[m], q[b])) {
          mask |= 1 << m
          lit.push(q[m])
        } else {
          dark.push(q[m])
        }
      }
      words[i] = QUADRANTS[mask]
      words[i + 1] = mean(lit)
      words[i + 2] = dark.length > 0 ? mean(dark) : 0
    }
  }
  return new Uint8Array(words.buffer).toBase64()
}
