# avatar7: journals that say what is new and keep the visits

- **Problem**: pda's 19 journals were one sentence each; 15 opened with "Marc holds every key", and of 191 visits about 6 left a trace. Past 30 days only journals remain, so the visits were forgotten.
- **Decision**: the journal prompt now carries the last journal ("never again what it already said") and asks, after two or three sentences on the user, one "With <name>:" line per persona met (at most four, under twenty words). JOURNAL_CHARS 700 -> 900, maxTokens 200 -> 320.
- **Why**: the refrain came from the persona, not the data; showing the last journal is the cheapest way to stop it, and a line per persona is what a "tell me about GLaDOS" needs months later.
- **Where**: `journalPrompt` in `avatar7/hooks/memory.ts`, `summarize()` in register.tsx.
