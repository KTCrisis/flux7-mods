# avatar7: a voiced line is typed on the wall clock

- **Problem**: on the PC the text fell behind the voice. The pace was characters per frame over the WAV's length counted in 66 ms frames; when the engine is busy the frames come late, the voice does not.
- **Decision**: `voiced()` records the start (ms, after PLAY_LEAD_FRAMES) and the WAV's length; `typeOn()` shows length x elapsed / duration on `Date.now()`. Unvoiced and muted lines keep the per-frame pace.
- **Why**: the voice runs on real time, so the text must too; the frame counter stays for everything else (its modulo checks).
- **Where**: `avatar7/hooks/line.ts`, the two calls in register.tsx. The mouth (`isHeard`, `speakUntil`) still counts frames.
