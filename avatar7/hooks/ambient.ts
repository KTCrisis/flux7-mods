// Pixel weather in the black around the face: one or two layers per persona,
// read from its persona.json `ambient`. Every pixel is a function of its place
// and the ambient's own time through hashed noise, so no drop is kept; only
// the skyline and the current bolt are cached, per field size.

export type AmbientKind = 'rain' | 'rise' | 'wind' | 'stars' | 'bolt' | 'skyline' | 'pulse' | 'scene' | 'grid'

// density: the share of columns, rows or pixels that carry something (0-1);
// speed: pixels a second for what moves, the twinkle's pace for stars.
// palette: for the skyline, the neon colors its buildings pick among.
// scene: a backdrop baked by tools/bake_scene.py, `file` of `width` x `height`
// pixels, its bytes attached as `pixels` when the persona loads.
export type AmbientLayer = {
  kind: AmbientKind
  color: string
  density?: number
  speed?: number
  palette?: string[]
  file?: string
  width?: number
  height?: number
  pixels?: Uint8Array
  // What moves in a scene: blinking red beacons, flickering neon signs,
  // windows going dark; none when absent, the backdrop then stays still.
  animate?: ('beacons' | 'neon' | 'windows')[]
  // grid: the floor's depth on screen, as a share of the field's width (a
  // scene's height follows the width, so the horizon stays on its sea line).
  floor?: number
}

// The field the layers draw on: the pane's width in pixels, and the face's
// height plus the band under the text, two pixels per row.
export type Field = { width: number; height: number }

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

// Buildings along the bottom of the field, in cells (one column wide, one
// row tall), widths 4-10, cached per field: each column's roof row and the
// index of its building.
let skylineFor = ''
let skyline: { roof: number[]; building: number[] } = { roof: [], building: [] }
const city = (f: Field): { roof: number[]; building: number[] } => {
  const id = `${f.width}x${f.height}`
  if (id === skylineFor) return skyline
  const rows = f.height / 2
  skyline = { roof: [], building: [] }
  let x = 0
  let b = 0
  while (x < f.width) {
    const w = 4 + Math.floor(hash(b, 41) * 7)
    const h = 3 + Math.floor(hash(b, 42) * Math.min(15, rows * 0.35))
    for (let i = 0; i < w && x < f.width; i++, x++) {
      skyline.roof.push(rows - h)
      skyline.building.push(b)
    }
    b++
  }
  skylineFor = id
  return skyline
}

// The skyline is drawn in box-drawing lines, finer than a half block: a cell
// is on the outline when it holds a roof, a wall between two buildings or the
// ground; its glyph joins the outline cells around it.
const isOutline = (c: { roof: number[]; building: number[] }, rows: number, x: number, y: number): boolean => {
  if (x < 0 || x >= c.roof.length || y < 0 || y >= rows) return false
  const roof = c.roof[x]
  const isWall = x === 0 || c.building[x] !== c.building[x - 1]
  if (y < roof) return isWall && x > 0 && y >= c.roof[x - 1]
  return y === roof || y === rows - 1 || isWall
}

// Up 1, down 2, left 4, right 8.
const JOINS = ['·', '│', '│', '│', '─', '┘', '┐', '┤', '─', '└', '┌', '├', '─', '┴', '┬', '┼']

// Neon outlines stay brighter than the rest of the weather.
const NEON = 0.85

// A skyline cell's glyph and color, or null to let the pixel layers show.
const skylineCell = (layer: AmbientLayer, f: Field, x: number, y: number, t: number): { code: number; color: number } | null => {
  const c = city(f)
  const rows = f.height / 2
  if (x >= c.roof.length) return null
  const roof = c.roof[x]
  if (isOutline(c, rows, x, y)) {
    const joins =
      (isOutline(c, rows, x, y - 1) ? 1 : 0) |
      (isOutline(c, rows, x, y + 1) ? 2 : 0) |
      (isOutline(c, rows, x - 1, y) ? 4 : 0) |
      (isOutline(c, rows, x + 1, y) ? 8 : 0)
    // A wall belongs to the taller of its two buildings; the ground to none.
    const owner = y === rows - 1 ? -1 : y < roof ? c.building[x - 1] : c.building[x]
    const palette = layer.palette ?? [layer.color]
    const neon = rgb(palette[owner < 0 ? 0 : Math.floor(hash(owner, 44) * palette.length)])
    // Now and then a tube flickers out for a beat.
    const isOut = owner >= 0 && hash(owner, Math.floor(t * 4), 45) < 0.03
    return { code: JOINS[joins].codePointAt(0) ?? 0x2500, color: scale(neon, isOut ? 0.15 : y === rows - 1 ? 0.35 : NEON) }
  }
  // Windows inside a building, lit and dimmed every few seconds.
  if (y > roof && y < rows - 1 && x % 3 === 1 && (y - roof) % 2 === 0) {
    const isLit = hash(x, y, Math.floor(t / 3 + hash(x, y, 43) * 5)) < 0.25
    if (isLit) return { code: 0xb7, color: scale(rgb(layer.color), DIM) }
  }
  return null
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
type Scene = { width: number; height: number; rgb: Uint32Array; sort: Uint8Array }
let sceneOf: Uint8Array | null = null
let sceneWidth = 0
let scene: Scene = { width: 0, height: 0, rgb: new Uint32Array(0), sort: new Uint8Array(0) }

const fitScene = (layer: AmbientLayer, f: Field): Scene | null => {
  const px = layer.pixels
  const sw = layer.width ?? 0
  const sh = layer.height ?? 0
  if (px === undefined || sw === 0 || sh === 0) return null
  if (px === sceneOf && f.width === sceneWidth) return scene
  const w = f.width
  const h = Math.max(1, Math.round((sh * w) / sw))
  const rgbOut = new Uint32Array(w * h)
  const sort = new Uint8Array(w * h)
  const lums = new Float32Array(w * h)
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor((y * sh) / h)
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * sh) / h))
    const fade = Math.min(1, y / (h * 0.25))
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor((x * sw) / w)
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * sw) / w))
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
  scene = { width: w, height: h, rgb: rgbOut, sort }
  return scene
}

// The scene's color at a field pixel, or -1 where it does not reach.
const scenePixel = (layer: AmbientLayer, f: Field, x: number, y: number, t: number): number => {
  const s = fitScene(layer, f)
  if (s === null) return -1
  const sy = y - (f.height - s.height)
  if (sy < 0 || x >= s.width) return -1
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
      return streak(y, x, f.width, t, speed ?? 40, 12, density ?? 0.12, 11)
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
      if (hash(x, y, 31) >= (density ?? 0.015)) return 0
      return 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(t * (speed ?? 1) * (0.5 + hash(x, y, 32)) + hash(x, y, 33) * 6.28))
    }
    case 'bolt': {
      const path = bolt(f, t, isStorm)
      if (path === null) return 0
      const d = Math.abs(path[y] - x)
      return d === 0 ? 1 : d === 1 ? 0.25 : 0
    }
    case 'skyline':
      // Drawn by cells (skylineCell), not by pixels.
      return 0
    case 'scene':
      // Drawn in color by scenePixel.
      return 0
    case 'grid': {
      // An outrun floor: rows closer together toward the horizon, scrolling
      // toward the viewer; rays fanning out from its middle.
      const horizon = f.height - Math.max(2, Math.round(f.width * (layer.floor ?? 0.1)))
      if (y < horizon) return 0
      if (y === horizon) return 1
      const depth = (y - horizon) / (f.height - horizon)
      // One pixel row spans this much of the floor: a line lands on the row
      // that holds it, so lines stay one pixel thin up to the horizon.
      const near = 4 / depth
      const far = 4 / ((y - horizon + 1) / (f.height - horizon))
      const shift = t * (speed ?? 1.5)
      const isRow = Math.floor(near + shift) !== Math.floor(far + shift)
      const ray = ((x - f.width / 2) * depth) / 6
      const isRay = Math.abs(ray - Math.round(ray)) < 0.5 * depth / 6 + 0.04
      return isRow || isRay ? 0.35 + 0.65 * depth : 0
    }
    case 'pulse': {
      // Wires every 9 rows, a bright pulse running along each.
      if (y % 9 !== 4) return 0
      const wire = Math.floor(y / 9)
      const at = (t * (speed ?? 30) + hash(wire, 61) * (f.width + 20)) % (f.width + 20)
      const d = Math.abs(at - x)
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

// A Raster's cells for the field's rectangle at (x0, y0), `columns` wide and
// `rows` tall: upper half blocks, two field pixels per cell.
export const ambientCells = (layers: AmbientLayer[], f: Field, x0: number, y0: number, columns: number, rows: number, t: number, isStorm: boolean): string => {
  const words = new Uint32Array(columns * rows * 3)
  const sky = layers.find(l => l.kind === 'skyline')
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const i = (row * columns + col) * 3
      const glyph = sky === undefined ? null : skylineCell(sky, f, x0 + col, y0 / 2 + row, t)
      if (glyph !== null) {
        words[i] = glyph.code
        words[i + 1] = glyph.color
        words[i + 2] = 0
        continue
      }
      words[i] = 0x2580
      words[i + 1] = ambientPixel(layers, f, x0 + col, y0 + row * 2, t, isStorm)
      words[i + 2] = ambientPixel(layers, f, x0 + col, y0 + row * 2 + 1, t, isStorm)
    }
  }
  return new Uint8Array(words.buffer).toBase64()
}
