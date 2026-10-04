# jukebox7: an orphan VLC is ended through its own HTTP interface

- **Problem**: closing the terminal by its button kills the WSL side before `session.end`; the Windows `vlc.exe` survives with no readable command line (the tag kill misses it), refuses `Stop-Process` and `taskkill` even to its own user, and listens on 18797 beside the next VLC, so the controls reach one of the two at random.
- **Decision**: `killVlcArgv` sends `pl_stop` over HTTP once per listener (VLC exits under `--play-and-exit`), then kills by tag and by port owner; `playAt` halts before every start, even with nothing playing from this session.
- **Why**: HTTP is the only path that works without elevation; a guard in WSL would die with the window (the whole `/init` instance goes), so the cleanup happens at the next start or stop instead.
- **Where**: `jukebox7/hooks/register.tsx` (`killVlcArgv`, `playAt`), commit 575952c.
