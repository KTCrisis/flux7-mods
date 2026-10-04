// The voice: a line synthesized by Piper (or spoken by SAPI when Piper is
// missing), and a WAV played on the host. Pure: argv only; register.tsx runs
// them, since the engine follows $ into nothing imported.

import type { Persona } from './speech'

export const POWERSHELL = '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
// A persona with a `pitch` (-10 to 10) speaks through the SAPI COM voice,
// which takes the pitch as XML; the text is escaped for it.
export const speakScript = (who: { voice: string; rate: number; pitch?: number }, vol: number) =>
  '[Console]::InputEncoding=[Text.Encoding]::UTF8; $t=[Console]::In.ReadToEnd(); ' +
  (who.pitch === undefined
    ? 'Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; ' +
      `$s.SelectVoice("${who.voice}"); $s.Rate=${who.rate}; $s.Volume=${vol}; $s.Speak($t)`
    : '$q=[char]34; $v=New-Object -ComObject SAPI.SpVoice; ' +
      `$v.Voice=($v.GetVoices() | ? { $_.GetDescription() -like "${who.voice}*" } | select -First 1); ` +
      `$v.Rate=${who.rate}; $v.Volume=${vol}; ` +
      `[void]$v.Speak("<pitch absmiddle=" + $q + "${who.pitch}" + $q + ">" + [Security.SecurityElement]::Escape($t) + "</pitch>", 8)`)

// A persona with a `piper` voice speaks through Piper (local neural TTS, on
// the CPU, in WSL), its WAV played by Windows through SAPI; SAPI stays the voice
// when Piper or the model is missing. Piper lives in ~/.local/share/piper:
// .venv with piper-tts, voices/<name>.onnx. A private voice at
// custom/<avatar id>.onnx wins over the persona's (its own pace, no filter
// unless custom/<id>.fx holds one): voices one keeps out of the repo.
// Synthesis and playback are two runs so the line can be typed with the voice:
// this one prints the WAV's path and its length in seconds, or speaks through
// SAPI itself and prints nothing when Piper is missing.
export const PIPER = '$HOME/.local/share/piper'
export const synthArgv = (id: string, who: Persona, vol: number): string[] => [
  'bash',
  '-c',
  [
    't=$(cat)',
    `m="${PIPER}/voices/$1.onnx"`,
    `c="${PIPER}/custom/$6"`,
    'if [ -n "$6" ] && [ -f "$c.onnx" ]; then m="$c.onnx"; set -- "$c" "$2" 1 "$4" "$(cat "$c.fx" 2>/dev/null)" "$6" ""; fi',
    `if [ -n "$1" ] && [ -f "$m" ] && [ -x "${PIPER}/.venv/bin/python" ]; then`,
    '  w=$(mktemp --suffix=.wav); f=""; keep=""',
    // Every temporary goes on exit, but the WAV handed to the player.
    '  trap \'[ -n "$keep" ] || rm -f "$w"; rm -f "$f"\' EXIT',
    // With ffmpeg the user's volume is applied after the leveling below.
    '  v="$2"; command -v ffmpeg >/dev/null && v=1',
    // $7: a speaker of a multi-speaker model (vctk, libritts_r), by its id.
    // A Piper that fails speaks through SAPI, as a missing one does.
    `  printf %s "$t" | "${PIPER}/.venv/bin/python" -m piper -m "$m" \${7:+-s "$7"} -f "$w" --volume "$v" --length-scale "$3" 2>/dev/null || { printf %s "$t" | "${POWERSHELL}" -NoProfile -Command "$4"; exit 0; }`,
    // The persona's ffmpeg filter (pitch, metal, glitch), skipped without ffmpeg.
    '  if [ -n "$5" ] && command -v ffmpeg >/dev/null; then',
    '    f=$(mktemp --suffix=.wav)',
    '    ffmpeg -loglevel error -y -i "$w" -af "$5" "$f" && mv "$f" "$w"',
    '  fi',
    // Every voice leveled to the same loudness, then the user's volume.
    '  if command -v ffmpeg >/dev/null; then',
    '    f=$(mktemp --suffix=.wav)',
    '    ffmpeg -loglevel error -y -i "$w" -af "loudnorm=I=-18:TP=-2:LRA=11,aresample=22050,volume=$2" "$f" && mv "$f" "$w"',
    '  fi',
    `  "${PIPER}/.venv/bin/python" -c 'import sys, wave; w = wave.open(sys.argv[1]); print(sys.argv[1]); print(w.getnframes() / w.getframerate())' "$w" && keep=1`,
    'else',
    `  printf %s "$t" | "${POWERSHELL}" -NoProfile -Command "$4"`,
    'fi',
  ].join('\n'),
  'avatar7-speak',
  who.piper?.voice ?? '',
  String(Math.max(0, Math.min(100, vol)) / 100),
  String(who.piper?.lengthScale ?? 1),
  speakScript(who, vol),
  who.piper?.fx ?? '',
  id,
  who.piper?.speaker === undefined ? '' : String(who.piper.speaker),
]

// SAPI plays the WAV on the host: SoundPlayer on a \\wsl.localhost path can
// fall silent (returns at once, no error) while SAPI still reads it. The
// relay, when this session holds it, takes the WAV instead (relay.ts).
export const SAPI_PLAY = `"${POWERSHELL}" -NoProfile -Command "\\$v=New-Object -ComObject SAPI.SpVoice; \\$s=New-Object -ComObject SAPI.SpFileStream; \\$s.Open('$(wslpath -w "$1")'); [void]\\$v.SpeakStream(\\$s); \\$s.Close()"`

// How long PowerShell takes to start a detached playback, at most (measured
// ~0.3 s warm, more cold): the voice is held this much past the WAV's length.
export const PLAY_START_MS = 900

// A command run in its own session: the engine kills a module's children on
// reload, and a line half spoken was cut with them.
export const detachedArgv = (argv: string[]): string[] => ['bash', '-c', 'setsid "$0" "$@" </dev/null >/dev/null 2>&1 &', ...argv]
