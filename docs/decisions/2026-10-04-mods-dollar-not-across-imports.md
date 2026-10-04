# Splitting a mod: pure modules, engine calls stay in the hooks file

- **Problem**: avatar7's register.tsx had grown into one closure of 49 `let` written by 16 hooks; a first `relay.ts` holding the relay whole was refused by `claude plugin validate`: `$ is followed only into a function declared in this same file, never across an import`.
- **Decision**: a split module is pure (state as plain objects, argv, decisions, drawing); the few functions that call `$` stay in register.tsx as file-level functions taking that state (`relayTick($, relay, …)`, `speak($, stage, ask, c)`), and a value that moves on during awaits is passed as a function (`now: () => frame`).
- **Why**: the validator reads the engine calls statically, per file; a pure module is also testable without the engine. Moving `frame` into a shared object would have rewritten 49 uses for nothing a callback does not give.
- **Where**: avatar7/hooks/{relay,mood,line,speech,voice,hearing,draw}.ts; register.tsx; commits 4fd4508, 294b335, e4e8c43, 8be9af5, 9ceef2c, b1f667e, 929ad65.
