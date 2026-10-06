# usage-bell

Rings, inside a Claude Code session, when the session nears a limit.

## What it does

On each `session.measure` (the engine pushes one after every turn, and when a
rate-limit window moves a point):

- **context**: a toast at 70, 85 and 95 % of the window, with the tokens;
- **rate limits**: a toast at 80 and 95 % of each window the last response
  reported (`5h`, `7d`), with the time it resets; none off a subscription.

And for the **auto-memory index** (`MEMORY.md`, found in the session's own
context breakdown at start): read at start and after each Write or Edit into
its folder. The engine cuts it at load past 200 lines or 25,000 bytes
(2.1.288); the bell rings at 90 % of either, and again once it is past.

Each threshold rings once on the way up; a value that falls 5 points under it
(a compaction, `/clear`, a window that reset) arms it again.

The readings ride dim at the end of the hint line under the prompt, `ctx 62%
· 5h 41% · 7d 12% · mem 145/200`, rather than as a pinned status line, which
the engine draws with a warning sign; `/usage7` prints them against their
thresholds.

With avatar7 loaded, the avatar announces each toast in its own voice, in
amber. Neither mod depends on the other. `/usage7 test` rings a sample toast,
to hear that voice without waiting for a threshold.

## Spend

Two kinds, never added up:

- **mods**: every model call another mod makes (`$.model.complete`: avatar7's
  Haiku, jukebox7's intents) goes through the subscription. The bell counts
  their tokens per model and prices them as the API would, `mods 41k tok
  ≈$0.06`: what they take from the plan, not dollars billed.
- **api**: the real dollars of the API keys (projects run outside Claude Code),
  from flux7-ops's `GET /spend` on 127.0.0.1:8710, asked every five minutes.
  ops7 alone holds the organization's Admin key; the bell sees amounts only:
  `api $6.20 today`, and in `/usage7` yesterday, the month and each workspace.
  A day rings at $5, $10 and $20. Without ops7 the bell says so and stays quiet.

## Limits

- It signals and never acts: no compaction, no memory pruning.
- The memory limits are the engine's constants in 2.1.288; a later build may
  move them.
- The session's own cost is left out: on a subscription it means nothing.
