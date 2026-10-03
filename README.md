# flux7-mods

Claude Code mods: plugins of function hooks that run inside one session
(panes, bands, status line, tool-call hooks). Fleet-wide views stay in deck7;
what lives here sees a single session, from the inside, as events happen.

## Mods

| Mod | What it does |
| --- | --- |
| `avatar7` | A machine face that watches tool calls and comments on them in the voice of a chosen avatar (SHODAN, HAL, a GLaDOS-like lab AI, Ada). See [avatar7/README.md](avatar7/README.md): how it works, and how to make an avatar (portrait, bake, personality). |

## Loading

One session:

    claude --plugin-dir ~/flux7-mods/avatar7

Every interactive session: add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the
`env` block of `~/.claude/settings.json` (colon-separated absolute paths).
The folder is watched: saving a file reloads the mod.

## Checking

    claude plugin validate ~/flux7-mods/avatar7
