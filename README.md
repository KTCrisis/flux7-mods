# flux7-mods

Claude Code mods: plugins of function hooks that run inside one session
(panes, bands, status line, tool-call hooks). Fleet-wide views stay in deck7;
what lives here sees a single session, from the inside, as events happen.

## Mods

| Mod | What it does |
| --- | --- |
| `mesh7-pane` | mesh7 decisions live, polled from `localhost:9090` every 1.5 s: ALLOW / DENY / HUMAN per call with rule and parameters, approvals waiting for a human, emergency stop banner, status line counts, a toast on each new deny or approval request. Read-only. `/mesh7` opens the pane, `/mesh7 all` widens to every agent and session, `/mesh7 session` narrows back. |
| `avatar7` | A machine face that watches tool calls and comments on them in the voice of a chosen avatar (SHODAN, HAL, a GLaDOS-like lab AI, Ada, duck7, Pod 042, Kaneda, the Commis); it waits with you while a human decides, answers a poke, and announces the toasts of any mod that publishes an `announce` (atelier-bell, usage-bell, jukebox7). See [avatar7/README.md](avatar7/README.md): how it works, and how to make an avatar (portrait, bake, personality). |
| `atelier-bell` | Tells you when an atelier finishes: flux7-studio renders as toasts and a status line (`studio: rendering`, `studio: last …`), `/bell` for the state. See [atelier-bell/README.md](atelier-bell/README.md). |
| `usage-bell` | Rings when the session nears a limit: context fill (70/85/95 %), the 5 h and 7 d rate-limit windows (80/95 %), the auto-memory index the engine cuts at 200 lines or 25 kB. A status line (`ctx 62% · 5h 41% · 7d 12% · mem 145/200`), `/usage7` for the detail. See [usage-bell/README.md](usage-bell/README.md). |
| `jukebox7` | Music on demand, in plain words ("put on some ambient"): YouTube audio through a hidden VLC, no browser, no focus taken. A pane with genre buttons, each a radio of artists, and the pick of the avatar on duty. See [jukebox7/README.md](jukebox7/README.md). |

## Loading

One session, one or several mods:

    claude --plugin-dir ~/flux7-mods/avatar7 --plugin-dir ~/flux7-mods/mesh7-pane --plugin-dir ~/flux7-mods/atelier-bell --plugin-dir ~/flux7-mods/usage-bell --plugin-dir ~/flux7-mods/jukebox7

Every interactive session: add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the
`env` block of `~/.claude/settings.json` (colon-separated absolute paths).
The folder is watched: saving a file reloads the mod.

## Checking

    claude plugin validate ~/flux7-mods/avatar7

## License

MIT, see [LICENSE](LICENSE). Character names referenced by avatar7 belong to
their owners; see the credits in [avatar7/README.md](avatar7/README.md).
