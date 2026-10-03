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
state and volume, `p` pause, `n` next, `r` similar, `s` stop, `d` and `u` the volume by
10 %, and the genre buttons `1` to `9`:
ambient, lofi, black metal, darksynth, idm, indie rock, video games, modern classical, hip-hop. A genre
is a radio: a random artist from its list, a random song of theirs; next and
the end of a song roll again.

A pick searches YouTube Music's songs tab, which holds tracks only: no
interview, gameplay or full OST. Its listing gives no length, so the bar
shows the elapsed time alone; plain YouTube, kept to two to twenty minutes,
is the fallback when it finds nothing.

**Discoveries.** Each genre also holds a few artists beyond the listener's
own, drawn from the lists' neighbors (Grouper and Tim Hecker by Loscil and
Brian Eno, Deathspell Omega and Panopticon by Blut Aus Nord and Agalloch,
Sewerslvt and Machine Girl by Venetian Snares, Car Seat Headrest and Alex G
by Modest Mouse and Elliott Smith). One pick in three comes from there and
its title wears a ✦; strike a name from `discover` to drop it.

**similar** (`r`, `/music similar`, or in words, `plus comme ça`) plays the
YouTube Music radio of the song on: other artists first (the radio lingers
on the same one), covers, tributes and hour-long loops dropped; next walks
that list.

On the terminal the pane is black down to its last row, framed in the
avatar's color, and the room left under the player fills with a green code
rain in the manner of Ghost in the Shell: half-width katakana and digits,
falling five frames a second while a song plays, frozen on pause.

With avatar7 loaded, `a` plays the pick of the avatar on duty: the `station`
of its `persona.json`, which avatar7 publishes in its `station` state, and avatar7 announces each song in
its own voice. While the avatar speaks (its `isVoicing` state) the music drops
to 70 % of its level, then returns.

`/music <search>` plays one named track; `/music pause|next|stop`;
`/music vol 60`, `/music vol +20`. In words, `monte le son` works too.

Only a short prompt (eight words at most) with a music word or phrase goes to
Haiku; a longer one is talk to the assistant and passes untouched, even when
it mentions music.

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

- The genre lists are one listener's; edit `GENRES` in `hooks/register.tsx`.
  A station belongs to its persona, in avatar7's `personas/<id>/persona.json`.
- Pause starves VLC rather than pausing it; a very long pause may drop the
  YouTube stream, and next picks up from there.
- A song that ends moves on within five seconds (the liveness poll).

## Tests

    claude plugin test ~/flux7-mods/jukebox7
