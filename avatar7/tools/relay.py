#!/usr/bin/env python3
"""Carry avatar7's voice to another machine on the tailnet.

While this runs, avatar7 drops each WAV it would play into SPOOL; a browser tab
open on http://<tailnet ip>:8797/ hears it a moment later, and sees the face:
avatar7 mirrors who is on duty, the mood and the line into SPOOL/state.json. Bound to the
tailnet address only, never the LAN. The spool is created on start and
removed on exit; while it exists, void stays silent and the voice goes there.
Started and stopped by /avatar remote on|off.

    python3 avatar7/tools/relay.py [--port 8797] [--host <ip>]
"""

import argparse
import json
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PERSONAS = Path(__file__).resolve().parent.parent / "personas"
# What the page may fetch of a persona: its pictures, nothing else.
ASSETS = ("portrait.png", "portrait-talk.png", "portrait-deny.png", "scene.png")
SPOOL = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "avatar7" / "relay"
STATE = SPOOL / "state.json"
KEEP_S = 120  # a WAV no tab fetched within this is dropped

PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#05070a">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>avatar7</title>
<style>
:root{--tone:#00ff9c;--bg:#05070a;--ink:#cfe9e6}
*{box-sizing:border-box}
html,body{margin:0;height:100%;background:var(--bg);color:var(--ink);
font:15px/1.5 "JetBrains Mono",ui-monospace,Menlo,Consolas,monospace;overflow:hidden}
#scene{position:fixed;inset:0;background:center/cover no-repeat;filter:brightness(.42) saturate(1.1);
transition:background-image .6s}
#stage{position:relative;height:100%;display:flex;flex-direction:column;align-items:center;
justify-content:center;gap:18px;padding:16px}
#frame{position:relative;width:min(86vw,58vh);aspect-ratio:1;border:2px solid var(--tone);
box-shadow:0 0 24px color-mix(in srgb,var(--tone) 45%,transparent);background:#000;transition:border-color .3s,box-shadow .3s}
#frame img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover}
#tint{position:absolute;inset:0;background:var(--tone);mix-blend-mode:color;opacity:0;transition:opacity .3s}
#frame.deny,#frame.error{animation:glitch .18s steps(2) infinite}
@keyframes glitch{0%{transform:translate(0,0)}50%{transform:translate(-3px,1px)}100%{transform:translate(2px,-1px)}}
#frame.wait{animation:breathe 2.5s ease-in-out infinite}
@keyframes breathe{50%{filter:brightness(.8)}}
#name{letter-spacing:.2em;text-transform:uppercase;color:var(--tone);font-size:13px}
#line{width:min(92vw,640px);min-height:6.5em;padding:12px 14px;background:rgba(0,0,0,.55);
border-left:2px solid var(--tone);white-space:pre-wrap}
#line::after{content:"_";animation:blink 1s steps(1) infinite;color:var(--tone)}
@keyframes blink{50%{opacity:0}}
#gate{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;
gap:12px;background:rgba(5,7,10,.88);z-index:2;cursor:pointer;color:#7fe7e1}
#gate b{border:1px solid currentColor;padding:.6em 1.6em;font-weight:normal}
#gate span{opacity:.6;font-size:13px}
#status{position:fixed;bottom:max(8px,env(safe-area-inset-bottom));right:12px;font-size:11px;opacity:.45}
</style></head><body>
<div id="scene"></div>
<div id="stage">
  <div id="name">avatar7</div>
  <div id="frame"><img id="face" alt=""><div id="tint"></div></div>
  <div id="line"></div>
</div>
<div id="gate"><b>listen</b><span>tap once: the browser plays nothing before a gesture</span></div>
<div id="status">waiting</div>
<script>
const TINT = { watch: '#00e5ff', deny: '#ff2a6d', error: '#ffb000', wait: '#7a5cff' };
const MIX = { idle: 0, watch: .25, wait: .35, deny: .5, error: .5 };
const $ = id => document.getElementById(id);
const status = t => $('status').textContent = t;
const faces = {}; let st = null, files = [], persona = '', flapAt = 0;

// The voice: WAVs in arrival order, one at a time.
const queue = []; let busy = false; const audio = new Audio();
function next() {
  if (busy || !queue.length) return;
  busy = true; audio.src = '/wav/' + queue.shift();
  audio.play().catch(e => { status('blocked: ' + e.message); busy = false; });
}
audio.onended = audio.onerror = () => { busy = false; next(); };

async function loadPersona(id) {
  persona = id;
  files = await fetch('/persona/' + id + '/').then(r => r.json()).catch(() => []);
  for (const f of ['portrait', 'portrait-talk', 'portrait-deny']) {
    if (files.includes(f + '.png')) { const i = new Image(); i.src = `/persona/${id}/${f}.png`; faces[id + f] = i.src; }
  }
  $('scene').style.backgroundImage = files.includes('scene.png') ? `url(/persona/${id}/scene.png)` : 'none';
}

// The line, typed: at a reading pace, then over the voice's length once known.
let typedSeq = -1, text = '', shown = 0, rate = 1, typer = 0;
function type(s) {
  if (s.seq !== typedSeq) { typedSeq = s.seq; text = s.line; shown = 0; rate = 1; }
  if (s.speakMs > 0) rate = Math.max(.2, (text.length - shown) / (s.speakMs / 50));
  clearInterval(typer);
  typer = setInterval(() => {
    shown = Math.min(text.length, shown + rate);
    $('line').textContent = text.slice(0, Math.floor(shown));
    if (shown >= text.length) clearInterval(typer);
  }, 50);
}

function draw() {
  if (!st) return;
  const isDown = st.mood === 'deny' || st.mood === 'error';
  let f = 'portrait';
  if (isDown && faces[persona + 'portrait-deny']) f = 'portrait-deny';
  else if (st.isSpeaking && faces[persona + 'portrait-talk'] && performance.now() < flapAt) f = 'portrait-talk';
  const src = faces[persona + f] || faces[persona + 'portrait'];
  if (src && $('face').src !== new URL(src, location).href) $('face').src = src;
}
// The mouth flaps at an uneven pace while the voice is heard.
setInterval(() => { if (st && st.isSpeaking && Math.random() < .55) flapAt = performance.now() + 140; draw(); }, 160);

async function onState(s) {
  if (s.persona !== persona) await loadPersona(s.persona);
  st = s;
  const tone = TINT[s.mood] || s.color || '#00ff9c';
  document.documentElement.style.setProperty('--tone', tone);
  $('tint').style.opacity = MIX[s.mood] ?? 0;
  $('frame').className = s.mood;
  $('name').textContent = s.name;
  document.title = s.name + ' / avatar7';
  type(s); draw();
}

$('gate').onclick = () => {
  $('gate').remove();
  audio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
  audio.play().catch(() => {});
  const es = new EventSource('/events');
  es.onopen = () => status('connected');
  es.onerror = () => status('lost, retrying');
  es.onmessage = m => { queue.push(m.data); next(); };
  es.addEventListener('state', m => onState(JSON.parse(m.data)));
};
</script></body></html>
"""


def tailnet_ip() -> str:
    out = subprocess.run(["tailscale", "ip", "-4"], capture_output=True, text=True, check=True)
    return out.stdout.split()[0]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == "/":
            body = PAGE.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path == "/events":
            self.events()
        elif self.path.startswith("/wav/"):
            name = Path(self.path[5:]).name
            f = SPOOL / name
            if not name.endswith(".wav") or not f.is_file():
                self.send_error(404)
                return
            body = f.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "audio/wav")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path.startswith("/persona/"):
            self.persona(self.path[9:])
        else:
            self.send_error(404)

    def send_bytes(self, body: bytes, kind: str, cache: bool = False):
        self.send_response(200)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(body)))
        if cache:
            self.send_header("Cache-Control", "max-age=3600")
        self.end_headers()
        self.wfile.write(body)

    def persona(self, rest: str):
        pid, _, name = rest.partition("/")
        folder = PERSONAS / pid
        if not pid.isalnum() or not folder.is_dir():
            self.send_error(404)
        elif name == "":
            have = [a for a in ASSETS if (folder / a).is_file()]
            self.send_bytes(json.dumps(have).encode(), "application/json")
        elif name in ASSETS and (folder / name).is_file():
            self.send_bytes((folder / name).read_bytes(), "image/png", cache=True)
        else:
            self.send_error(404)

    def events(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        # Only WAVs that arrive after the tab connects: no backlog on reconnect.
        seen = {p.name for p in SPOOL.glob("*.wav")}
        last_ping = time.monotonic()
        state_at = 0.0
        try:
            while True:
                # The face's state, at connect and on each change.
                try:
                    at = STATE.stat().st_mtime
                    if at != state_at:
                        state_at = at
                        self.wfile.write(b"event: state\ndata: " + STATE.read_bytes() + b"\n\n")
                        self.wfile.flush()
                except FileNotFoundError:
                    pass
                fresh = sorted(
                    (p for p in SPOOL.glob("*.wav") if p.name not in seen),
                    key=lambda p: p.stat().st_mtime,
                )
                for p in fresh:
                    seen.add(p.name)
                    self.wfile.write(f"data: {p.name}\n\n".encode())
                if fresh or time.monotonic() - last_ping > 15:
                    if not fresh:
                        self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    last_ping = time.monotonic()
                time.sleep(0.2)
        except (BrokenPipeError, ConnectionResetError):
            pass


def sweep():
    while True:
        cutoff = time.time() - KEEP_S
        for p in SPOOL.glob("*.wav"):
            try:
                if p.stat().st_mtime < cutoff:
                    p.unlink()
            except FileNotFoundError:
                pass
        time.sleep(10)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=None, help="address to bind (default: this machine's tailnet IPv4)")
    ap.add_argument("--port", type=int, default=8797)
    args = ap.parse_args()
    host = args.host or tailnet_ip()

    server = ThreadingHTTPServer((host, args.port), Handler)
    server.daemon_threads = True
    SPOOL.mkdir(parents=True, exist_ok=True)
    (SPOOL / "relay.pid").write_text(str(os.getpid()))

    def stop(*_):
        shutil.rmtree(SPOOL, ignore_errors=True)
        sys.exit(0)

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    threading.Thread(target=sweep, daemon=True).start()
    print(f"avatar7 relay on http://{host}:{args.port}/ (spool {SPOOL})", flush=True)
    try:
        server.serve_forever()
    finally:
        stop()


if __name__ == "__main__":
    main()
