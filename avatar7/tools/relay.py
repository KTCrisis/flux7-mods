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
# The page's buttons, one JSON file each, which avatar7 reads and removes.
COMMANDS_DIR = SPOOL / "cmd"
COMMANDS = {"talk", "ask", "answer", "avatar", "mute", "events", "visits", "volume"}
MAX_COMMAND = 2048
KEEP_S = 120  # a WAV no tab fetched within this is dropped

# The page, read at each request: edit it without restarting the relay.
PAGE = Path(__file__).resolve().parent / "relay.html"


def tailnet_ip() -> str:
    out = subprocess.run(["tailscale", "ip", "-4"], capture_output=True, text=True, check=True)
    return out.stdout.split()[0]


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_GET(self):
        if self.path == "/":
            body = PAGE.read_bytes()
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

    def do_POST(self):
        if self.path != "/command":
            self.send_error(404)
            return
        size = int(self.headers.get("Content-Length") or 0)
        if not 0 < size <= MAX_COMMAND:
            self.send_error(413)
            return
        try:
            cmd = json.loads(self.rfile.read(size))
        except ValueError:
            self.send_error(400)
            return
        # avatar7 checks each command again; this only keeps junk out of the spool.
        if not isinstance(cmd, dict) or cmd.get("cmd") not in COMMANDS:
            self.send_error(400)
            return
        COMMANDS_DIR.mkdir(exist_ok=True)
        part = COMMANDS_DIR / f"{time.time_ns()}.part"
        part.write_text(json.dumps(cmd))
        part.rename(part.with_suffix(".json"))
        self.send_bytes(b"{}", "application/json")

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
