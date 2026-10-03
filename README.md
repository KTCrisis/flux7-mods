# flux7-mods

Claude Code mods: plugins of function hooks that run inside one session
(panes, bands, status line, tool-call hooks). Fleet-wide views stay in deck7;
what lives here sees a single session, from the inside, as events happen.

## Mods

| Mod | What it does |
| --- | --- |
| `avatar7` | A machine face watching tool calls: a flux7-studio portrait baked to 64x64 (`tools/bake.py <persona>`), drawn as a Raster at 15 fps. Cyan on success, amber on error, magenta glitch on a refusal (hook, permission, or mesh7: policy, approval, supervisor, timeout, emergency stop). Comments in one line (Haiku) in the avatar's voice, spoken by Windows SAPI from WSL. Avatars in `personas/<id>/` (portrait, `face.rgb`, `persona.json`): `shodan`, `hal`, `glados`, `ada`. `/avatar <id>` switches and remembers, `/avatar` opens the pane, `/avatar-mute` toggles the voice. |

## Loading

One session:

    claude --plugin-dir ~/flux7-mods/avatar7

Every interactive session: add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the
`env` block of `~/.claude/settings.json` (colon-separated absolute paths).
The folder is watched: saving a file reloads the mod.

## Checking

    claude plugin validate ~/flux7-mods/avatar7
