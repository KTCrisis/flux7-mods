// One thing that happened somewhere: an earthquake (USGS), a tropical cyclone (GDACS), a natural event (NASA
// EONET: storm, fire, volcano, ice) or a headline (a press feed). `at` is when, in milliseconds. `placed` says whether `lon` and `lat` mean
// anything; `exact` whether they were given by the source (a quake, a storm) or are only the capital of the
// country the headline names. `mag` is a quake's magnitude or a cyclone's strongest wind in km/h, 0 otherwise;
// `alert` is a cyclone's GDACS level (0 green or none, 1 orange, 2 red).
export type Kind = 'quake' | 'cyclone' | 'storm' | 'fire' | 'volcano' | 'ice' | 'other' | 'news'
export type Event = { kind: Kind; source: string; title: string; at: number; lon: number; lat: number; placed: boolean; exact: boolean; mag: number; alert: number }

// What the pane shows: the events of the last reading, the newest first, the feeds that did not answer, and when
// it was read (0 before the first reading).
export type Wire = { events: Event[]; failed: string[]; at: number }

// What this mod asks avatar7 to say, if avatar7 is loaded: a strong earthquake just reported. avatar7 hears the
// write; nothing here depends on it.
export type Say = { mood: 'watch' | 'error'; event: string; at: number }

declare module 'claude-code' {
  interface PluginState {
    atlas7: {
      wire: Shaped<Wire>   // kept under a tag (atom's shape): a change of fields declines the old value
      say: Say
    }
    // Read only: avatar7 owns it and says which face is on duty; the frame takes its color.
    avatar7: { color: string }
  }
}
