export type Track = { id: string; title: string; seconds: number | null }

// What plays: the search results, the one playing, and the process group of
// its yt-dlp | ffplay pipeline. Kept in $.state so a reload still owns it.
export type Player = {
  tracks: Track[]
  index: number
  pgid: number | null
  isPlaying: boolean
  // The genre button behind it: next and the end of a song roll again there.
  genre: string | null
  // When the track started, pushed forward by each pause, and when the
  // current pause began (ms, $.clock.now): what the progress bar reads.
  startedAt: number | null
  pausedAt: number | null
}

// What this mod asks avatar7 to say, if avatar7 is loaded: each song as it
// starts, for the persona to introduce like a radio host; a search that found
// nothing. avatar7 hears the write; nothing here depends on it.
export type Say = { mood: 'watch' | 'error'; event: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    jukebox7: { player: Player; volume: number; say: Say }
    // Read only: avatar7 owns it and says which face is on duty.
    avatar7: { avatar: string; color: string; isVoicing: boolean; station: { name: string; artists: string[] } }
  }
}
