# avatar7's relay: one owner, following the user, kept awake on a phone

- **Problem**: two avatar7 sessions on one machine both wrote their face and voice to the single relay; and a locked Android phone put the relay page to sleep mid-line, closing the floating face.
- **Decision**: the spool's `owner` file names the one session that relays; a prompt from Remote Control or typed over ssh takes it, one typed at the host's terminal gives it back (`/avatar remote on` holds it). The page loops a breath on the last bit (about -90 dBFS) from `listen` on.
- **Why**: the user is where they last typed; ssh prompts arrive as `composer` but their user is elsewhere. Android keeps a page alive as a player only while it plays; -60 dBFS was audible, -90 is not and still holds.
- **Where**: `avatar7/hooks/register.tsx` (playArgv, prompt.submit, clock mirror), `avatar7/tools/relay.py`, `avatar7/tools/relay.html` (keepAwake).
