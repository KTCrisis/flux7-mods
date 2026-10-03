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
| `/avatar <id>` | switch avatar (`shodan`, `hal`, `glados`, `ada`), greet, remember the choice across sessions |
| `/avatar-mute` | toggle the voice for this session |

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
| `session.start` | registers `/avatar` and `/avatar-mute`, loads the stored avatar (`$.store`), starts the frame clock, opens the pane |
| `command.run` `avatar` | opens the pane, or loads another persona, stores it, speaks its greeting |
| `command.run` `avatar-mute` | flips the `isMuted` state |
| `tool.call` | lets the call run (`await next(e)`), then classifies the outcome and may ask for a line |
| `ui.render` `Pane` | draws the Raster and the line under it; a text fallback off the terminal |

### Moods

| Outcome | Mood | Look |
| --- | --- | --- |
| success | `watch` | slight cyan pull, about 0.8 s |
| `isError` | `error` | amber pull, about 2 s |
| denied by a hook or permission, or a mesh7 refusal | `deny` | magenta pull, shifted rows, snow, about 2 s |

A mesh7 refusal is recognized by the exact texts mesh7 returns
(`mcp/server.go`, `halt/halt.go`): `Policy denied`, `Approval denied`,
`Denied by supervisor`, `Approval timed out`, `halted by operator`. If mesh7
changes those messages, update `MESH_DENY`.

### Drawing

- `personas/<id>/face.rgb` is 64x64 raw RGB (3 bytes per pixel, row-major).
- The face follows the pane: `fit()` takes the pane body width (`e.props.bodyColumns`) and the surface height, and `sample()` averages the portrait blocks each output pixel covers (64 down to 16 pixels a side). The scanlines are drawn at the output size.
- `pixel(x, y)` reads the portrait and applies, in order: eye glow and blink
  (or, with no mouth, eyes that pulse while speaking), the mouth opening while
  speaking, the mood tint by luminance, scanlines, a rolling bar, and the
  deny glitch.
- `cells()` packs two pixel rows per terminal row with the upper half block
  `▀` (foreground = top pixel, background = bottom pixel), base64 as
  `RasterProps` expects.
- The clock calls `$.ui.blit` every 66 ms, which repaints the mounted Raster
  without a render pass.

`Image` (real pixels) would be sharper but needs the kitty graphics protocol
(kitty, Ghostty); Windows Terminal shows only its alt text, hence the Raster.

### Speech

- A line is asked at most every 45 s on success and every 5 s on an error or
  refusal, and never while the previous one is still being spoken.
- `$.model.complete` with `haiku`, the persona's `persona` text as system
  prompt, the event as prompt (preceded by the first 200 characters of the
  last prompt the user typed, at the terminal or through Remote Control, so
  the call is judged against what was asked), 80 tokens, 15 s. If it fails, a line is taken
  from `fallback[mood]`.
- The line goes to the `line` atom (survives reloads), typed out two
  characters per frame.
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

The five shipped portraits (model `krea2_turbo_fp8_scaled.safetensors`, seed
random unless given; the actual seed is in the PNG metadata):

| id | style | prompt |
| --- | --- | --- |
| shodan | `cyber-futur 1995` | frontal symmetric portrait of a cold artificial intelligence goddess, female machine face made of glowing wireframe mesh and circuit plates, piercing luminous eyes staring straight at the viewer, thick cables and wires flowing from the head like hair, face centered and filling the frame, pure black background, high contrast, green and cyan glow, 1994 cyberspace computer graphics |
| hal | `libre` | extreme close-up of a single glowing red camera lens eye set in a brushed aluminium panel, deep red glass iris with a bright yellow-white pinpoint center, concentric reflections, perfectly symmetric, centered and filling the frame, 1968 science fiction spaceship computer, pure black surroundings, high contrast |
| glados | `libre` | giant robotic artificial intelligence hanging from the ceiling, sleek white and black mechanical head seen from the front with a single large glowing yellow eye in the center, articulated robotic neck, cables, sterile laboratory test chamber, head centered and filling the frame, dark background, high contrast, cinematic |
| ada | `decopunk (Belle Époque futur)` | frontal symmetric portrait of a benevolent automaton woman, face of polished brass and ivory porcelain, gentle kind luminous amber eyes, serene soft smile, ornate brass filigree and whiplash curves framing the head like a halo, face centered and filling the frame, warm golden light, dark background, high contrast |
| duck7 | none, seed 11 | cartoon mascot portrait of a cheeky mallard duck head facing the viewer, 1990s animated series style, bold thick black outlines, flat cel shading, big round expressive white eyes with black pupils and a mischievous half-lidded look, wide orange-yellow bill with a smug grin, glossy emerald green head, small tilted golden crown, symmetric, head centered and filling the frame, pure black background, high contrast, vivid saturated colors |

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
| glados | `192 150 832 790` |

### 3. Features

Read the eyes and the mouth on `face-preview.png` and divide by 8 (the preview
is the grid enlarged x8):

- `eyes`: a list of `{ x, y, rx, ry }`, center and radii in grid pixels. Two
  almonds for a face (`rx` 3 to 4, `ry` 1), one disc for a lens (`rx = ry = 4`).
- `mouth`: `{ x, y, half }`, the line where the lips part and its half width;
  or `null` for a face without one, in which case the eyes pulse while the
  avatar speaks and never blink.

### 4. Personality (`persona.json`)

| Field | Meaning |
| --- | --- |
| `name` | pane title |
| `voice` | an installed SAPI voice: `Microsoft Hortense Desktop` (fr), `Microsoft David Desktop`, `Microsoft Zira Desktop` (en) |
| `rate` | SAPI rate, -10 to 10 |
| `pitch` | optional: SAPI pitch, -10 to 10; set, the voice goes through the SAPI COM object, which takes it as XML (duck7: 10) |
| `color` | color of the line under the face |
| `greeting` | spoken on `/avatar <id>` |
| `nobody` | optional: the name used for `{, user}` when `user_name` is empty |
| `persona` | system prompt of the line; the mod appends "No quotes, no emoji, no em dash." |
| `fallback` | lines per mood (`idle`, `watch`, `deny`, `error`) when the model gives none |

Any text field may name the user with a placeholder: `{, user}` becomes
`, <name>` (the braces hold any text around the word `user`), using the
`user_name` option, else `nobody`, else nothing at all. `Bonjour{ user}.`
reads `Bonjour Marc.` or `Bonjour.`.

Writing `persona`, what works:

- say who the avatar is, that it watches the tool calls of an agent named
  Claude, and for whom;
- fix the language to match the voice (a French text in an English voice is
  unintelligible);
- ask for ONE sentence of 90 characters at most: the line is typed under a
  64-column face and spoken;
- give two or three adjectives of temper, and one thing it must never be
  (vulgar, flattering).

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

- Only three Windows voices are installed; HAL and the lab AI speak English.
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
- **duck7** is our own: the crowned mallard of the status line, a claude-buddy
  companion, given a face.
