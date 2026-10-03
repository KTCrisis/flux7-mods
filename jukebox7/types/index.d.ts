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
}

declare module 'claude-code' {
  interface PluginState {
    jukebox7: { player: Player }
    // Read only: avatar7 owns it and says which face is on duty.
    avatar7: { avatar: string }
  }
}
