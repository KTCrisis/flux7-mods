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
amber. Neither mod depends on the other.

## Limits

- It signals and never acts: no compaction, no memory pruning.
- The memory limits are the engine's constants in 2.1.288; a later build may
  move them.
- Cost is left out: on a subscription it means nothing.
