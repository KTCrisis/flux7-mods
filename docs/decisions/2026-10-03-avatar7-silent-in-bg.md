# avatar7 stays silent in background sessions

- **Problem**: after quitting, a voice kept speaking, sometimes another avatar's. A daemon spare (`claude bg-spare`) inherits the spawning session's `--plugin-dir` and ran avatar7 unseen, voicing the bells' toasts with the avatar stored when it started.
- **Decision**: avatar7's `session.start` reads `CLAUDE_CODE_SESSION_KIND`; `bg` leaves at once (no command, no pane, no frame loop, so no voice).
- **Why**: the env var is the only mark that separates a spare from a watched session; the Piper then SAPI split was not the cause.
- **Where**: `avatar7/hooks/register.tsx` (session.start), test in `avatar7/hooks/avatar7.test.ts`.
