# avatar7 speaks a mod's `say`, through one queue by urgency

- **Problem**: a mod could only make the avatar speak by toasting, and the next line sat in a single slot: two mods at once, the last overwrote the first; avatar7 also knew mesh7-pane's health by name.
- **Decision**: a mod writes its own `say` key (`{mood, event, at}`) to be spoken without a toast; every line goes through one queue of four, poke > deny > error|wait > watch, stale after ~20 s. mesh7-pane detects mesh7's fall, halt and return itself and says them.
- **Why**: avatar7 is the stage, mods feed it; the stage must know no mod by name, and urgency, not arrival order, decides what is heard.
- **Where**: `avatar7/hooks/register.tsx` (`heardSay`, `enqueue`, `fresh`), `mesh7-pane/hooks/register.tsx` (`meshShift`, `report`). Side fix the same day: commis's `vibrato` fed NaN to the biquads behind it (a full-scale beep); it now runs last (dd43d32).
