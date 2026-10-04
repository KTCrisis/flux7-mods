#!/usr/bin/env python3
"""Carry avatar7's voice to another machine on the tailnet.

While this runs, avatar7 drops each WAV it would play into SPOOL; a browser tab
open on http://<tailnet ip>:8796/ hears it a moment later. Bound to the
tailnet address only, never the LAN. The spool is created on start and
removed on exit; while it exists, void stays silent and the voice goes there.
Started and stopped by /avatar remote on|off.

    python3 avatar7/tools/relay.py [--port 8796] [--host <ip>]
"""

import argparse
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SPOOL = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "avatar7" / "relay"
KEEP_S = 120  # a WAV no tab fetched within this is dropped

PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>avatar7 relay</title>
<style>
body{margin:0;background:#07090c;color:#7fe7e1;font:15px/1.5 "JetBrains Mono",monospace;
display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh}
button{background:none;color:inherit;border:1px solid currentColor;padding:.6em 1.4em;font:inherit;cursor:pointer}
#s{opacity:.7;margin-top:1em}
</style></head><body>
<button id="b">listen</button><div id="s">click once: the browser plays nothing before a gesture</div>
<script>
const s = document.getElementById('s'), b = document.getElementById('b');
const queue = []; let busy = false; const a = new Audio();
function next() {
  if (busy || !queue.length) return;
  busy = true; a.src = '/wav/' + queue.shift();
  a.play().catch(e => { s.textContent = 'blocked: ' + e.message; busy = false; });
}
a.onended = a.onerror = () => { busy = false; next(); };
b.onclick = () => {
  b.disabled = true; b.textContent = 'listening';
  a.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YQAAAAA=';
  a.play().catch(() => {});
  const es = new EventSource('/events');
  es.onopen = () => s.textContent = 'connected';
  es.onerror = () => s.textContent = 'lost, retrying';
  es.onmessage = m => { s.textContent = 'voice ' + m.data; queue.push(m.data); next(); };
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
        try:
            while True:
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
    ap.add_argument("--port", type=int, default=8796)
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
