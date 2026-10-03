# atelier-bell

Tells you, inside a Claude Code session, when an atelier has finished its
work. Studio only for now.

## What it does

Every 3 s it reads `GET localhost:8700/outputs` (flux7-studio) and
`GET localhost:8188/queue` (ComfyUI):

- a new output (image, video) since the last poll: a toast, `studio: image
  kf_00042_.png is ready`, or one toast for a batch;
- dim at the end of the hint line under the prompt (not a pinned status line,
  which the engine draws with a warning sign): `studio: rendering, 2 queued`
  while ComfyUI works, then `studio: last kf_00042_.png at 12:31`;
- `/bell` prints that status; `/bell test` rings a sample toast, to hear
  avatar7 announce it without waiting for a render.

The first answer only seeds what is already there: a session never rings for
renders made before it started. Studio or ComfyUI down: it stays quiet.

With avatar7 loaded, the avatar announces each toast in its own voice
(avatar7 hooks `ui.toast` and keeps those whose `next.origin.plugin` is
`atelier-bell`). Neither mod depends on the other.

## Limits

- Only inside an open session; nothing reaches the phone or a closed terminal.
- audio, press and ops are not watched yet (press and ops need their token).
