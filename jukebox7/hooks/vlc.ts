// jukebox7's VLC: pure strings, kept out of register.tsx so they can be run
// for real outside the engine (the plugin tests mock every process).
import { REMOTE } from './remote'

// Audio only, no window, through one VLC on the Windows side (WSLg's
// PulseAudio stalls after a sleep; VLC takes no focus) that stays up for the
// session and plays files, not a stream.
//
// A song is first downloaded into a cache, then played from the file. The
// earlier pipe (yt-dlp | vlc.exe -) started a VLC per song, left ghosts that
// held the port, could not seek, and lost the song after a long pause: VLC
// stopped reading, yt-dlp blocked, YouTube dropped the connection. A file
// pauses as long as it likes and starts again instantly.
//
// The song's process (setsid: a group of its own, whose life is the song's,
// as the poll expects) fetches the file, wakes VLC if it does not answer,
// has it play the file, then watches its status every second and ends when
// VLC stops or another song took the player. The id arrives as $1, checked
// against /^[\w-]{11}$/ before. No single quote: the script runs inside one.
export const VLC = '/mnt/c/Program Files/VideoLAN/VLC/vlc.exe'
export const TAG = '--meta-title=jukebox7'
// VLC's HTTP interface, bound to Windows' loopback. WSL reaches it directly
// with networkingMode=mirrored; curl.exe, run on the Windows side, is the
// fallback otherwise. The password only satisfies VLC, which refuses the
// interface without one.
export const HTTP_PORT = 18797
export const HTTP_PASSWORD = 'jukebox7'
const HTTP = `--extraintf http --http-host 127.0.0.1 --http-port ${HTTP_PORT} --http-password ${HTTP_PASSWORD}`
export const CURL = '/mnt/c/Windows/System32/curl.exe'
export const STATUS_URL = `http://127.0.0.1:${HTTP_PORT}/requests/status.json`
// --no-loop and --no-repeat: VLC keeps "loop" from its saved Windows
// preferences, and a looping song never reaches the stopped state that ends it.
const VLC_UP = `"${VLC}" --intf dummy --dummy-quiet --no-video -q --no-loop --no-repeat ${TAG} ${HTTP}`
// The cache holds what was played, newest kept, up to CACHE_BYTES.
const CACHE = '"\${XDG_CACHE_HOME:-$HOME/.cache}/jukebox7/songs"'
export const CACHE_BYTES = 1024 * 1024 * 1024
const PLAY =
  `C=${CACHE}; mkdir -p "$C"; ` +
  `j() { curl -s -u :${HTTP_PASSWORD} --max-time 2 "$@" || "${CURL}" -s -u :${HTTP_PASSWORD} --max-time 2 "$@"; }; ` +
  `song() { ls "$C/$1".* 2>/dev/null | grep -v "[.]part$" | head -1; }; ` +
  `f=$(song "$1"); if [ -z "$f" ]; then yt-dlp -q --no-warnings -f bestaudio -o "$C/%(id)s.%(ext)s" "https://www.youtube.com/watch?v=$1" || exit 1; f=$(song "$1"); [ -n "$f" ] || exit 1; fi; ` +
  `touch "$f"; ` +
  `( while [ "$(du -sb "$C" | cut -f1)" -gt ${CACHE_BYTES} ]; do o=$(ls -tr "$C" | head -1); [ "$C/$o" = "$f" ] && break; rm -f "$C/$o"; done ) & ` +
  `j -o /dev/null "${STATUS_URL}" || { setsid ${VLC_UP} </dev/null >/dev/null 2>&1 & i=0; until j -o /dev/null "${STATUS_URL}"; do i=$((i+1)); [ $i -gt 40 ] && exit 1; sleep 0.25; done; }; ` +
  `j -o /dev/null -G --data command=in_play --data-urlencode "input=$(wslpath -w "$f")" "${STATUS_URL}" || exit 1; ` +
  `st() { j "${STATUS_URL}" | grep -o "\\"$1\\":[^,}]*" | head -1 | cut -d: -f2 | tr -d "\\" "; }; ` +
  `i=0; until [ "$(st state)" = playing ]; do i=$((i+1)); [ $i -gt 40 ] && exit 1; sleep 0.25; done; ` +
  `id=$(st currentplid); trap exit TERM; ` +
  `while sleep 1; do s=$(st state); [ -z "$s" ] && exit; [ "$s" = stopped ] && exit; [ "$(st currentplid)" != "$id" ] && exit; done`
const PIPE = `${REMOTE}${PLAY}`
export const startArgv = (id: string): string[] => [
  'bash',
  '-c',
  `setsid bash -c '${PIPE}' _ "$1" </dev/null >/dev/null 2>&1 & echo $!`,
  '_',
  id,
]
// A song ends with pl_stop: the one VLC stays up for the next. Sent from WSL,
// or by curl.exe where WSL does not reach Windows' loopback.
export const stopVlcArgv = [
  'sh',
  '-c',
  `curl -s -o /dev/null -u :${HTTP_PASSWORD} --max-time 2 "${STATUS_URL}?command=pl_stop" || "${CURL}" -s -o NUL -u :${HTTP_PASSWORD} --max-time 2 "${STATUS_URL}?command=pl_stop"; true`,
]
// The session's end takes VLC down: every process listening on the port,
// found by netstat (a VLC started from WSL shows no command line to match
// a tag on, and an older one may still hold the port beside it).
const NETSTAT = '/mnt/c/Windows/System32/netstat.exe'
const TASKKILL = '/mnt/c/Windows/System32/taskkill.exe'
export const killVlcArgv = [
  'sh',
  '-c',
  `for p in $("${NETSTAT}" -ano | tr -d "\\r" | awk "/127.0.0.1:${HTTP_PORT} .*LISTENING/ {print \\$NF}" | sort -u); do "${TASKKILL}" /PID "$p" /F >/dev/null 2>&1; done; true`,
]
