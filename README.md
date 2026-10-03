# flux7-mods

Claude Code mods: plugins of function hooks that run inside one session
(panes, bands, status line, tool-call hooks). Fleet-wide views stay in deck7;
what lives here sees a single session, from the inside, as events happen.

## Mods

| Mod | What it does |
| --- | --- |
| `shodan7` | A studio portrait baked to 64x64 (`tools/bake.py`), drawn as a Raster at 15 fps that watches tool calls. Cyan on success, amber on error, magenta glitch on a refusal (hook, permission, or mesh7: policy, approval, supervisor, timeout, emergency stop). Comments in one cold French line (Haiku), spoken by the Windows SAPI voice from WSL. `/shodan7` opens the pane, `/shodan7-mute` toggles the voice. |

## Loading

One session:

    claude --plugin-dir ~/flux7-mods/shodan7

Every interactive session: add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the
`env` block of `~/.claude/settings.json` (colon-separated absolute paths).
The folder is watched: saving a file reloads the mod.

## Checking

    claude plugin validate ~/flux7-mods/shodan7
