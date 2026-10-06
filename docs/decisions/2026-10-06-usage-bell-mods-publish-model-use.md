# usage-bell: the mods publish their model calls, usage-bell does not intercept them

- **Problem**: a hook on `model.complete` in usage-bell, meant to tally every mod's Haiku calls, counted nothing in a real session while avatar7 spoke; the test bench could not show it (its `$` has no state and runs one plugin).
- **Decision**: avatar7 (lines, journals) and jukebox7 (intents) set `modelUse` in their own state after each call; usage-bell listens with `state.set` and prices the tokens at API rates, shown as "mods … tok ≈$" (billed to the plan). The session's own cost stays in claude-buddy, not duplicated.
- **Why**: a mod's op call does not run through another mod's op hooks; `state.set` listening is the path already proven between mods (announces, 03/10). Verified by Marc on 06/10, 23:20.
- **Where**: `avatar7/hooks/register.tsx` (`used`), `jukebox7/hooks/register.tsx` (prompt.submit), `usage-bell/hooks/register.ts`; commit 46dea95. API dollars come from flux7-ops `/spend` (a82885a), the Admin key in ops7.env only.
