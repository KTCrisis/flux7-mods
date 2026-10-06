// jukebox7's remote branch: pure strings, run for real by
// tools/test_remote_shell.ts (the plugin tests mock every process).
//
// While avatar7's relay is held (the voice is on the phone), the music goes
// there too: the song is written for the relay (music.json), the phone streams
// it through the relay, and this process waits for the phone to say it ended
// (or skipped it): then it ends, and the poll moves on as when VLC ends a song.
// Given back meanwhile, it ends too, and the next song plays here. Its exit
// clears music.json unless a newer song took it already. No single quote: it
// runs inside one.
export const RELAY = '"\${XDG_CACHE_HOME:-$HOME/.cache}/avatar7/relay"'
export const REMOTE =
  `R=${RELAY}; if [ -f "$R/owner" ]; then rm -f "$R/ended-$1"; ` +
  `printf "{\\"id\\": \\"%s\\", \\"paused\\": false}" "$1" > "$R/music.part" && mv "$R/music.part" "$R/music.json"; ` +
  `trap "grep -q $1 $R/music.json 2>/dev/null && printf {} > $R/music.part && mv $R/music.part $R/music.json" EXIT; trap exit TERM; ` +
  `while [ ! -f "$R/ended-$1" ] && [ -f "$R/owner" ]; do sleep 1; done; rm -f "$R/ended-$1"; exit; fi; `

// Pause on the phone flips the flag of the song music.json holds; otherwise
// the arguments after the script (VLC's curl) run as they are.
export const pauseScript = (isPaused: boolean): string =>
  `R=${RELAY}; if [ -f "$R/owner" ] && grep -q '"id"' "$R/music.json" 2>/dev/null; then ` +
  `sed 's/"paused": [a-z]*/"paused": ${isPaused}/' "$R/music.json" > "$R/music.part" && mv "$R/music.part" "$R/music.json"; else exec "$@"; fi`
