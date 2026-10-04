// Pixel weather in the black around the face: one or two layers per persona,
// read from its persona.json `ambient`. Every pixel is a function of its place
// and the ambient's own time through hashed noise, so no drop is kept; only
// the skyline and the current bolt are cached, per field size.

export type AmbientKind = 'rain' | 'rise' | 'wind' | 'stars' | 'bolt' | 'skyline' | 'pulse'

// density: the share of columns, rows or pixels that carry something (0-1);
// speed: pixels a second for what moves, the twinkle's pace for stars.
export type AmbientLayer = { kind: AmbientKind; color: string; density?: number; speed?: number }

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

// Buildings along the bottom of the field, widths 4-10 px, cached per field.
let skylineFor = ''
let skyline: number[] = []
const roofs = (f: Field): number[] => {
  const id = `${f.width}x${f.height}`
  if (id === skylineFor) return skyline
  skyline = []
  let x = 0
  let b = 0
  while (x < f.width) {
    const w = 4 + Math.floor(hash(b, 41) * 7)
    const h = 6 + Math.floor(hash(b, 42) * Math.min(30, f.height * 0.35))
    for (let i = 0; i < w && x < f.width; i++, x++) skyline.push(f.height - h)
    b++
  }
  skylineFor = id
  return skyline
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

// One layer's light at a pixel, 0 to 1; the skyline's body comes back
// negative so it can be drawn darker than its windows.
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
    case 'skyline': {
      const roof = roofs(f)[x] ?? f.height
      if (y < roof) return 0
      // Windows on a 3 px grid below the roof, lit and dimmed every few seconds.
      const isWindow = x % 3 === 1 && (y - roof) % 3 === 1 && y - roof > 1
      if (!isWindow) return -1
      return hash(x, y, Math.floor(t / 3 + hash(x, y, 43) * 5)) < 0.35 ? 0.8 : -1
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

// The color of a field pixel: the last layer that lights it wins, black when
// none does. `isStorm` raises bolts on a refusal.
export const ambientPixel = (layers: AmbientLayer[], f: Field, x: number, y: number, t: number, isStorm: boolean): number => {
  let out = 0
  for (const layer of layers) {
    const k = light(layer, f, x, y, t, isStorm)
    if (k > 0) out = scale(rgb(layer.color), k * DIM)
    else if (k < 0) out = scale(rgb(layer.color), 0.1)
  }
  return out
}

// A Raster's cells for the field's rectangle at (x0, y0), `columns` wide and
// `rows` tall: upper half blocks, two field pixels per cell.
export const ambientCells = (layers: AmbientLayer[], f: Field, x0: number, y0: number, columns: number, rows: number, t: number, isStorm: boolean): string => {
  const words = new Uint32Array(columns * rows * 3)
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < columns; col++) {
      const i = (row * columns + col) * 3
      words[i] = 0x2580
      words[i + 1] = ambientPixel(layers, f, x0 + col, y0 + row * 2, t, isStorm)
      words[i + 2] = ambientPixel(layers, f, x0 + col, y0 + row * 2 + 1, t, isStorm)
    }
  }
  return new Uint8Array(words.buffer).toBase64()
}
