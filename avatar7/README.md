# avatar7

A machine face in a Claude Code pane. It watches every tool call of the
session, changes color with the outcome, and comments in one spoken line, in
the voice and temper of the chosen avatar: SHODAN, HAL 9000, a GLaDOS-like lab
AI, or Ada, a benevolent brass automaton.

It is a mod: a plugin of function hooks that runs inside one Claude Code
session. It sees the session's events at the source and nothing of other
sessions.

## Using it

    avatar7                      # alias for: claude --plugin-dir ~/flux7-mods/avatar7
    avatar7 --resume             # any claude flag passes through

| Command | Effect |
| --- | --- |
| `/avatar` | open the pane |
| `/avatar <id>` | switch avatar (`shodan`, `hal`, `glados`, `ada`, `duck7`, `pod042`, `kaneda`, `commis`, `fox`, `adjutant`, `morte`), greet, remember the choice across sessions |
| `/avatar-talk` | ask the avatar what it thinks of the conversation; the `talk` button under the face (hotkey `t` while the pane has the focus) does the same |
| `avatars` button (hotkey `c`) | lists every avatar by name above the controls; click one and it takes over, as `/avatar <id>` does |
| `/avatar-mute` | toggle the voice for this session; the `mute` / `unmute` button under the face (hotkey `m`) does the same |
| `vol - N +` | buttons under the face: SAPI volume by steps of 10, 0 to 100, kept across sessions (`$.store`) |

The pane opens by itself at session start when the terminal is at least 144
columns wide; below that, `/avatar` seats it. The plugin folder is watched:
saving a file reloads the mod in every session started with the alias.

It is deliberately not in the global `CLAUDE_CODE_PLUGIN_DIRS`: a plain
`claude` session has no avatar.

### Your name

The avatars address you by the `user_name` option, empty by default. Set it in
the config menu (`/config`, row "Your name"), or in `~/.claude/settings.json`
under `pluginConfigs` for `avatar7`. Empty, they stay impersonal; HAL falls
back to Dave.

### Requirements

- Claude Code with function hooks (plugins loaded by `--plugin-dir`).
- The voice runs Windows SAPI through `powershell.exe` from WSL2. Elsewhere
  the call fails silently and the avatar only writes; `/avatar-mute` avoids
  the attempt.
- A terminal that draws 24-bit colors (Windows Terminal, kitty, Ghostty,
  iTerm2).

## How it works

```
tool.call ──► next(e) runs the tool ──► outcome ──► mood (color, glitch)
                                            │
                                            └──► (rate-limited) Haiku line
                                                   │
                                                   ├──► line atom ──► typewriter text in the pane
                                                   └──► powershell.exe SAPI voice (WSL interop)

clock.every 66 ms ──► pixel() over face.rgb ──► Raster cells ──► $.ui.blit (15 fps)
```

### Hooks (`hooks/register.tsx`)

| Hook | Role |
| --- | --- |
| `session.start` | registers `/avatar`, `/avatar-talk` and `/avatar-mute`, loads the stored avatar (`$.store`), starts the frame clock, opens the pane |
| `command.run` `avatar` | opens the pane, or loads another persona, stores it, speaks its greeting |
| `command.run` `avatar-talk`, the `talk` Button | raise a flag; the frame clock, which holds the session's `$`, reads the last 6 messages (`$.session.messages()`, 300 characters each) and asks Haiku for one line, outside the tool-call rate limits |
| `command.run` `avatar-mute` | flips the `isMuted` state |
| `state.set` | another mod's write to its own `announce` key is recorded in `announcers`, by plugin name; a write to its own `say` key queues a line at once (see below) |
| `ui.toast` | a toast from a recorded mod (`next.origin.plugin`) queues a line announcing it in that mod's mood, past the rate limits |
| `tool.check` | an `ask` verdict on a real call (a settings rule, or mesh7's hook answering `ask` for Bash) sets the waiting face; the line comes only if the prompt is still up after ~2 s, since auto mode may settle the ask alone |
| `tool.call` | lets the call run (`await next(e)`), then classifies the outcome and queues a line; a mesh7 answer `Approval required (id: …)` holds the face in `wait`, and the clock polls `GET /approvals` every ~1.5 s until the human decides |
| `ui.render` `Pane` | draws the Raster and the line under it; a text fallback off the terminal |

### Giving a mod a voice

avatar7 knows no mod by name. A mod that wants its toasts spoken publishes,
at session start, one value under its own name, declared in its own contract:

```ts
// types/index.d.ts
export type Announce = { mood: 'watch' | 'error'; event: string }
declare module 'claude-code' {
  interface PluginState { 'my-mod': { announce: Announce } }
}

// hooks/register.ts, in session.start
await $.state.set({ plugin: 'my-mod', key: 'announce' }, { mood: 'watch', event: 'a build finished' })
```

`mood` is the face (`watch` calm, `error` amber), `event` what happened, in
words the line is written from; the toast text is added to it. avatar7 hears
the write and keeps it across its own reloads; the mod never imports avatar7,
and without it the value just sits unread. atelier-bell, usage-bell and
jukebox7 do this. `/avatar voices` lists the mods heard so far.

A mod that wants a line without a toast writes its own `say` key instead,
each time it has something to say:

```ts
export type Say = { mood: 'watch' | 'error' | 'deny' | 'wait'; event: string; at: number }
await $.state.set({ plugin: 'my-mod', key: 'say' }, { mood: 'deny', event: 'the deploy was refused', at: Date.now() })
```

`at` makes the same event twice two writes. mesh7-pane does this for mesh7
going down (`error`), an emergency stop (`deny`) and their end (`watch`); its
DENY and HUMAN toasts stay unvoiced, the calls already speak.

Every line, from a call, a toast, a `say` or a poke, goes through one queue of
four: a poke first, then `deny`, then `error` and `wait`, then `watch`, the
oldest first among equals. Full, the least urgent is dropped; a line that
waited more than ~20 s is dropped unspoken.

### Moods

| Outcome | Mood | Look |
| --- | --- | --- |
| success | `watch` | slight cyan pull, about 0.8 s |
| `isError` | `error` | amber pull, about 2 s |
| denied by a hook or permission, or a mesh7 refusal | `deny` | magenta pull, shifted rows, snow, about 2 s |
| held for a human: a mesh7 approval, or a permission prompt | `wait` | violet pull, slow breathing, until the decision; the pane shows `waiting: mesh approve <id>` for a mesh7 hold |

A mesh7 refusal is recognized by the exact texts mesh7 returns
(`mcp/server.go`, `halt/halt.go`): `Policy denied`, `Approval denied`,
`Denied by supervisor`, `Approval timed out`, `halted by operator`. If mesh7
changes those messages, update `MESH_DENY`.

### Drawing

- `personas/<id>/face.rgb` is 64x64 raw RGB (3 bytes per pixel, row-major).
- The face follows the pane: `fit()` takes the pane body width (`e.props.bodyColumns`) and the surface height, and `sample()` averages the portrait blocks each output pixel covers (64 down to 16 pixels a side). The scanlines are drawn at the output size.
- `pixel(x, y)` reads the portrait and applies, in order: the mood tint by
  luminance, the waiting breath, scanlines, a rolling bar, and the deny
  glitch. The eye glow, blink and pulse are off for now: on several portraits
  the ellipses missed the eyes and read as smudges.
- `cells()` packs two pixel rows per terminal row with the upper half block
  `▀` (foreground = top pixel, background = bottom pixel), base64 as
  `RasterProps` expects.
- The clock calls `$.ui.blit` every 66 ms, which repaints the mounted Raster
  without a render pass.

`Image` (real pixels) would be sharper but needs the kitty graphics protocol
(kitty, Ghostty); Windows Terminal shows only its alt text, hence the Raster.

### Speech

- A line is asked at most every 45 s on success and every 5 s on an error or
  refusal, and never while the previous one is still being spoken. Every call
  counts toward a run of like outcomes: from the second denial or failure in
  a row the event says so (`3rd denial in a row`), and a success after three
  or more says `first success after N failures in a row`, at the 5 s pace.
- `$.model.complete` with `haiku`, the persona's `persona` text as system
  prompt, the event as prompt (preceded by the first 200 characters of the
  last prompt the user typed, at the terminal or through Remote Control, so
  the call is judged against what was asked) and followed by the avatar's
  last three lines, not to be reworded, 80 tokens, 15 s. If it fails, a line
  is taken from `fallback[mood]`.
- The line goes to the `line` atom (survives reloads), typed out two
  characters per frame.
- Piper, for the personas that name a `piper` voice, sits outside the repo:
  `uv venv ~/.local/share/piper/.venv && uv pip install --python
  ~/.local/share/piper/.venv/bin/python piper-tts`, then `python -m
  piper.download_voices --download-dir ~/.local/share/piper/voices <name>`.
  A line takes one to two seconds to synthesize on the CPU, no GPU, no account.
- A voice of one's own for an avatar goes in
  `~/.local/share/piper/custom/<avatar id>.onnx` (with its `.onnx.json`, and
  an optional `<id>.fx` filter): it wins over the persona's, and stays out of
  the repo.
- The voice is Windows SAPI, run from WSL: `powershell.exe` with the text on
  stdin in UTF-8, the persona's `voice` and `rate`.

### State

| Where | Key | Lifetime |
| --- | --- | --- |
| `$.state` | `avatar7.line`, `avatar7.isMuted` | the session, across reloads |
| `$.store` | `avatar` | across sessions |
| module variables | frame, mood, loaded face and persona | one load |

## Making an avatar

An avatar is a folder `personas/<id>/`:

```
personas/<id>/
  portrait.png        the studio render (kept as the source)
  face.rgb            baked by tools/bake.py, what the mod draws
  face-preview.png    the same grid x8, to read coordinates on
  persona.json        name, voice, features, temper
```

### 1. The portrait (flux7-studio)

`POST http://localhost:8700/keyframe`, 1024x1024. What survives a 64x64
reduction is contrast and a large central subject, so the prompt asks for:

- a frontal, symmetric face (or a single eye) centered and filling the frame;
- a pure black or dark background;
- high contrast and one dominant glow color.

The twelve shipped portraits (model `krea2_turbo_fp8_scaled.safetensors`, seed
random unless given; the actual seed is in the PNG metadata):

| id | style | prompt |
| --- | --- | --- |
| shodan | `cyber-futur 1995` | frontal symmetric portrait of a cold artificial intelligence goddess, female machine face made of glowing wireframe mesh and circuit plates, piercing luminous eyes staring straight at the viewer, thick cables and wires flowing from the head like hair, face centered and filling the frame, pure black background, high contrast, green and cyan glow, 1994 cyberspace computer graphics |
| hal | `libre` | extreme close-up of a single glowing red camera lens eye set in a brushed aluminium panel, deep red glass iris with a bright yellow-white pinpoint center, concentric reflections, perfectly symmetric, centered and filling the frame, 1968 science fiction spaceship computer, pure black surroundings, high contrast |
| glados | `libre` | giant robotic artificial intelligence hanging from the ceiling, sleek white and black mechanical head seen from the front with a single large glowing yellow eye in the center, articulated robotic neck, cables, sterile laboratory test chamber, head centered and filling the frame, dark background, high contrast, cinematic |
| ada | `decopunk (Belle Époque futur)` | frontal symmetric portrait of a benevolent automaton woman, face of polished brass and ivory porcelain, gentle kind luminous amber eyes, serene soft smile, ornate brass filigree and whiplash curves framing the head like a halo, face centered and filling the frame, warm golden light, dark background, high contrast |
| duck7 | none, seed 11 | cartoon mascot portrait of a cheeky mallard duck head facing the viewer, 1990s animated series style, bold thick black outlines, flat cel shading, big round expressive white eyes with black pupils and a mischievous half-lidded look, wide orange-yellow bill with a smug grin, glossy emerald green head, small tilted golden crown, symmetric, head centered and filling the frame, pure black background, high contrast, vivid saturated colors |
| pod042 | none, seed 42 | frontal symmetric view of a small floating support robot pod, boxy grey metal casing with rounded edges, a single horizontal glowing slit eye in the center, two small mechanical arms folded at its sides, minimalist post-apocalyptic android design, centered and filling the frame, pure black background, high contrast, soft white and pale yellow glow, 2017 video game concept art |
| kaneda | none, seed 1988 | frontal portrait of a cocky teenage biker gang leader, spiky brown hair, smirking confidently straight at the viewer, red leather biker jacket with a white pill capsule emblem on the chest, neon red city lights behind, 1988 japanese anime cel animation style, bold outlines, face centered and filling the frame, dark background, high contrast, saturated red |
| commis | none, seed 1769 | frontal symmetric portrait of an 18th century East India Company clerk, a weathered ship log keeper with a powdered wig and round brass spectacles, quill pen behind the ear, teak and rattan background with brass navigation instruments and a faded nautical chart, warm candlelight, face centered and filling the frame, dark surroundings, high contrast, oil painting in the style of a colonial era portrait |
| fox | none, seed 1994 | frontal portrait of a cocky anthropomorphic fox fighter pilot, orange and white fur, sharp green eyes looking straight at the viewer with a confident smirk, a radio headset with a small microphone over the muzzle, green flight jacket collar with a white scarf, starfield and a blue cockpit glow behind, 1990s video game box art style, bold outlines, head centered and filling the frame, dark background, high contrast |
| adjutant | none, seed 1999 | frontal symmetric portrait of a pale female android face, bald, porcelain white skin with thin seams, blank glowing pale blue eyes staring straight ahead, thick black cables and tubes plugged into the skull and neck, holographic blue scanlines and monitor glow, military command interface, face centered and filling the frame, pure black background, high contrast, cold cyan blue light, 1998 science fiction video game cinematic |
| morte | none, seed 2009 | frontal portrait of a floating grinning human skull, cracked yellowed bone, empty dark eye sockets with tiny glowing embers, wide toothy grin with chattering teeth, mischievous expression, no body, faint purple and green planar haze, ink and watercolor dark fantasy illustration in the style of 1999 Planescape role-playing game art, skull centered and filling the frame, black background, high contrast |
| pda | none, seed 2018 | frontal symmetric view of a rugged handheld survival PDA device floating in dark deep ocean water, a round glowing screen in the center showing a single luminous cyan signal ring like an eye, concentric rings, small status lights on a scratched white and orange casing, faint bubbles and bioluminescent particles around, device centered and filling the frame, pure black abyssal background, high contrast, cold cyan and teal glow, 2018 underwater survival video game interface |

A render takes about 25 to 50 s on Krea 2 turbo.

### 2. Bake

    mkdir personas/<id>
    cp ~/ComfyUI/output/kf_000NN_.png personas/<id>/portrait.png
    ~/py_env/bin/python tools/bake.py <id> --box LEFT TOP RIGHT BOTTOM

`--box` crops the 1024x1024 original before the reduction; keep it square and
tight around the face (the shipped boxes are in the table below). The tool
boosts contrast by 1.25, reduces with Lanczos to 64x64, and writes
`face.rgb` and `face-preview.png`. Look at the preview: if the features are
mush, crop tighter or re-render with more contrast.

| id | box |
| --- | --- |
| shodan, ada | `112 100 912 900` |
| hal | `150 150 874 874` |
| duck7 | none (full frame) |
| pod042 | `64 20 960 916` |
| kaneda | `180 40 860 720` |
| commis | `192 100 832 740` |
| glados | `192 150 832 790` |
| fox | `112 60 912 860` |
| adjutant | `92 10 932 850` |
| morte | `50 30 970 950` |
| pda | `130 120 890 880` |

### 3. Features

Read the eyes and the mouth on `face-preview.png` and divide by 8 (the preview
is the grid enlarged x8):

- `eyes`: a list of `{ x, y, rx, ry }`, center and radii in grid pixels. Two
  almonds for a face (`rx` 3 to 4, `ry` 1), one disc for a lens (`rx = ry = 4`).
- `mouth`: `{ x, y, half }`, the line of the lips and its half width, which
  marks a face; or `null` for a lens or a slit.

Both are kept for an eye effect to come; nothing draws them today (the glow,
blink and pulse were dropped, like the wind and the auras before them).

### 4. Personality (`persona.json`)

| Field | Meaning |
| --- | --- |
| `name` | pane title |
| `voice` | an installed SAPI voice: `Microsoft Hortense Desktop` (fr), `Microsoft David Desktop`, `Microsoft Zira Desktop` (en) |
| `rate` | SAPI rate, -10 to 10 |
| `pitch` | optional: SAPI pitch, -10 to 10; set, the voice goes through the SAPI COM object, which takes it as XML (duck7: 10) |
| `piper` | optional: `{ "voice": "en_GB-alan-medium", "lengthScale": 0.95, "fx": "…" }`, a [Piper](https://github.com/OHF-Voice/piper1-gpl) neural voice run on the CPU in WSL, its WAV played by Windows; `fx` is an ffmpeg audio filter (GLaDOS's metal, SHODAN's glitch, duck7's pitch). Every persona names one; SAPI speaks when Piper or the model is missing |
| `color` | color of the line under the face |
| `station` | optional: artists this persona would put on; avatar7 publishes them in its `station` state and jukebox7's `a` plays them |
| `greeting` | spoken on `/avatar <id>` |
| `nobody` | optional: the name used for `{, user}` when `user_name` is empty |
| `persona` | system prompt of the line; the mod appends the rules every persona keeps: answer in English even to French, never flattering, no quotes, no emoji, no em dash (`STYLE`) |
| `fallback` | lines per mood (`idle`, `watch`, `deny`, `error`, `wait`) when the model gives none; without `wait`, a held call takes a `watch` line |

Any text field may name the user with a placeholder: `{, user}` becomes
`, <name>` (the braces hold any text around the word `user`), using the
`user_name` option, else `nobody`, else nothing at all. `Bonjour{ user}.`
reads `Bonjour Marc.` or `Bonjour.`.

Writing `persona`, what works:

- say who the avatar is, that it watches the tool calls of an agent named
  Claude, and for whom;
- the language is fixed by the mod (`STYLE`: English, even to a French
  prompt), to match the voices (a French text in an English voice is
  unintelligible);
- ask for ONE sentence of 90 characters at most: the line is typed under a
  64-column face and spoken;
- give two or three adjectives of temper, and what it must never be beyond
  flattering, which `STYLE` already forbids (vulgar, emotional).

Ada's text is the model for a kind avatar: warm but precise, no flattery,
explains a refusal rather than mocking it.

### 5. Register and check

Add the id to `AVATARS` in `hooks/register.tsx`, then:

    claude plugin validate .
    git add personas/<id> hooks/register.tsx
    git commit -m "feat(avatar7): add <id>"

In a session started with the alias, the save reloads the mod; `/avatar <id>`
shows it.

## Limits

- The pane shows how to approve a held call and never approves it: the mod
  runs in the governed agent's session, which can edit it (see
  `docs/decisions/2026-10-03-mesh7-pane-read-only.md`).
- A mesh7 in supervisor mode blocks the call inside `next(e)`; the waiting
  face does not show then.

- Only three Windows voices are installed; every avatar speaks English (the
  French voice mangled English tool names), whatever language the user types.
  A local neural voice (piper) would change the rendition; not done.
- Eye and mouth coordinates are read by eye on the preview.
- The mesh7 refusal detection depends on mesh7's message texts.
- Each spoken line is one Haiku call; the rate limits above bound the cost.

## Credits

The avatars pay homage to machines other people imagined; the names and a few
lines belong to their works, the portraits are original renders.

- **SHODAN**: *System Shock*, Looking Glass Technologies, 1994.
- **HAL 9000**: *2001: A Space Odyssey*, Stanley Kubrick and Arthur C. Clarke,
  1968. "I'm sorry, Dave. I'm afraid I can't do that." is theirs.
- **The lab AI** is modeled on GLaDOS, *Portal*, Valve, 2007.
- **Ada** is our own, named in tribute to Ada Lovelace.
- **Pod 042**: *NieR:Automata*, PlatinumGames and Square Enix, 2017.
- **Kaneda**: *Akira*, Katsuhiro Otomo, 1982 manga and 1988 film; his
  fallback name for an unnamed user is Tetsuo.
- **The Commis** is our own, a trading post clerk keeping the log; he never
  praises the Company.
- **Fox McCloud**: *Star Fox*, Nintendo, 1993.
- **The Adjutant**: *StarCraft*, Blizzard Entertainment, 1998; her fallback
  name for an unnamed user is Commander.
- **Morte**: *Planescape: Torment*, Black Isle Studios and Interplay, 1999.
- **duck7** is our own: the crowned mallard of the status line, a claude-buddy
  companion, given a face.
