# tsc saw no engine call: `Engine` was no longer exported

- **Problem**: tsc reported 54 errors of noise, and the mods' `$: Engine` parameters checked nothing: the engine's types no longer export `Engine` (only `claude-code/testing` does), so every `$` was silently `any`; a jukebox7 check compared `$.state.get`'s `{ value, version }` to `true` and was always false.
- **Decision**: `import type { EngineInterface as Engine }` in each hooks module, base64 on Uint8Array declared in `hooks/globals.d.ts` (the engine has it, the es2023 lib does not), then every remaining error fixed until tsc is at zero; run `npx -y -p typescript@5 tsc -p <mod> --noEmit` before each commit.
- **Why**: at zero, tsc caught two bugs the tests passed over (the always-false check; a local `face` shadowing the mood state, which would have dropped the frame's color without an error); 54 errors of noise would have hidden both.
- **Where**: avatar7 and jukebox7 `hooks/register.tsx`, `avatar7/hooks/globals.d.ts`; commits e768065, 294b335.
