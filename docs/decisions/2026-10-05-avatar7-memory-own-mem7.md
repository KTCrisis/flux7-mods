# avatar7: the personas remember through a mem7 of their own

- **Problem**: a persona forgot everything at the end of a session (three last lines and the chats, in memory only); and the agents' mem7 (:9070) holds the mesh's decisions and the working agents' memories, where persona chatter would be noise read by unscoped clients (supervisor, console).
- **Decision**: a second instance, `mem7-play` on 127.0.0.1:9071 (own data dir, token, chain key, scopes), each persona a mem7 agent reading itself and `world`; episodes word for word with a 30-day TTL, a journal summed up by Haiku at session start, kept for good; verdicts on tools neither recall nor keep.
- **Why**: isolation by construction, near-zero cost (13 MB RAM, no embeddings), and it rehearses on real use the identity and scope model hoshi7 needs; the journal at start, not at end, because `session.end` does not run when the window closes.
- **Where**: `avatar7/hooks/memory.ts` (pure), `register.tsx` (`remembered`, `keep`, `summarize`), `avatar7/tools/mem7-play.service`; mem7 TTL fix in flux7-memory adb1fd9.
