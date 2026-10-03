# jukebox7

Music on demand inside a Claude Code session, asked in plain words, played
without a browser.

## What it does

A prompt that names music (`put on some ambient`, `coupe la musique`, `next`)
goes to Haiku first, which answers one intent: play, toggle, next, stop, or
none. Anything else, including requests aimed at play7, keys7, Renoise or a
melody, reaches the session untouched; a prompt without a music word skips
the model call altogether.

- **play**: `yt-dlp` searches YouTube, keeps songs of two to twenty minutes
  (a mood asked in words prefers five and more), and streams the audio into
  Windows' VLC with its dummy interface: no window, no focus taken.
- **toggle / next / stop**: the WSL side runs in a process group of its own
  (`setsid`); pause is `SIGSTOP` (VLC drains its buffer, a second or two),
  stop is `CONT` then `TERM`, and the `vlc.exe` it started is terminated by
  its `--meta-title=jukebox7` tag, so a VLC opened by hand is never touched.

The **pane** (`/music`, or opened on the first song) shows the title, its
state and volume, `p` pause, `n` next, `s` stop, `-` and `+` the volume by
10 %, and the genre buttons `1` to `7`:
ambient, lofi, black metal, darksynth, idm, indie rock, video games. A genre
is a radio: a random artist from its list, a random song of theirs; next and
the end of a song roll again.

With avatar7 loaded, `a` plays the pick of the avatar on duty: a station per
face, read from avatar7's `avatar` state, and avatar7 announces each song in
its own voice.

`/music <search>` plays one named track; `/music pause|next|stop`;
`/music vol 60`, `/music vol +20`. In words, `monte le son` works too.

The volume goes through VLC's HTTP interface on Windows' loopback (port
18797), reached with Windows' own `curl.exe`. The level is kept apart from
the player, survives a stop, and is set again on each new song: a fresh VLC
starts at whatever level Windows kept for it.

## Requirements

WSL with Windows interop, `yt-dlp` on the path, VLC at
`C:\Program Files\VideoLAN\VLC`. VLC rather than `ffplay` on WSLg's
PulseAudio: that server stalls after a sleep (it takes audio at a tenth of
real time and nothing comes out) until `wsl --shutdown`.

## Limits

- The genre and station lists are one listener's; edit `GENRES` and
  `STATIONS` in `hooks/register.tsx`.
- Pause starves VLC rather than pausing it; a very long pause may drop the
  YouTube stream, and next picks up from there.
- A song that ends moves on within five seconds (the liveness poll).

## Tests

    claude plugin test ~/flux7-mods/jukebox7
