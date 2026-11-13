# avatar7: recall visits by the name asked about

- **Problem**: asked in French "quel est ta mémoire sur glados", pda answered it had one exchange with GLaDOS (17/10) while 7 visits were stored. Visits and journals are in English; the search matched only "glados" and ranked French chats above them.
- **Decision**: when a line names another persona, the persona also reads its last 2 visits with it (`namedIn`, `visitsWith`, `withVisits` in memory.ts), recalled by tag `visit` and the "Visit with <Name>:" prefix, before the search hits.
- **Why**: a name is the one word shared across languages; the lookup costs one mem7 call and no model call, and only on lines that name someone.
- **Where**: `avatar7/hooks/memory.ts`, `remembered()` in register.tsx (display names now in `Stage.names`); mem7 side fixed apart (flux7-memory 2026-11-13-natural-query-french).
