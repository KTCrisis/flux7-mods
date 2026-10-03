# Mods ask avatar7 for a voice, avatar7 knows none by name

- **Problem**: avatar7 kept a table of the mods whose toasts it voiced (`BELLS`), so plugging in a new mod meant editing avatar7. A toast carries only text, and a `$.state.get` must name its plugin as a literal, so avatar7 could not look a mod's wish up by the toast's origin.
- **Decision**: each mod publishes `announce: { mood, event }` under its own name at session start; avatar7 hooks `state.set`, records every `announce` it hears in its own `announcers` state, and voices a toast whose `next.origin.plugin` is recorded.
- **Why**: no mod depends on avatar7 (no `dependencies`, no import), avatar7 depends on none, and the record survives avatar7's reloads in `$.state`; a bell's reload publishes again by itself.
- **Where**: `avatar7/hooks/register.tsx` (`heard`, `state.set`, `ui.toast`), `announce` in the contracts of atelier-bell, usage-bell and jukebox7; convention in `avatar7/README.md`.
