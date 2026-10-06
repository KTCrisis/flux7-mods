#!/usr/bin/env python3
"""Carry avatar7's voice to another machine on the tailnet.

While this runs, avatar7 drops each line it would play into SPOOL (Opus, or
WAV without libopus); a browser tab
open on http://<tailnet ip>:8797/ hears it a moment later, and sees the face:
avatar7 mirrors who is on duty, the mood and the line into SPOOL/state.json. Bound to the
tailnet address only, never the LAN. The spool is created on start and
removed on exit; while it exists, void stays silent and the voice goes there.
Runs as a system service (avatar7-relay.service), or started by /avatar
remote on when none runs; /avatar remote off gives the relay back without
stopping it. Reloads itself when this file changes.

    python3 avatar7/tools/relay.py [--port 8797] [--host <ip>]
"""

import argparse
import json
import os
import re
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
ASSETS = (
    "portrait.png", "portrait-talk.png", "portrait-deny.png", "scene.png",
    # the faces as the terminal draws them, baked at 64 and scaled up
    "face-preview.png", "face-talk-preview.png", "face-deny-preview.png",
)
SPOOL = Path(os.environ.get("XDG_CACHE_HOME", Path.home() / ".cache")) / "avatar7" / "relay"
STATE = SPOOL / "state.json"
# jukebox7, while the relay is held, plays on the phone: it writes the song here
# ({"id", "title", "paused"} or {} when nothing plays) and waits for ended-<id>.
MUSIC = SPOOL / "music.json"
TRACK_ID = re.compile(r"^[\w-]{11}$")
# The system service runs without the user's PATH, where yt-dlp lives.
YTDLP = shutil.which("yt-dlp") or str(Path.home() / "py_env" / "bin" / "yt-dlp")
# The page's buttons, one JSON file each, which avatar7 reads and removes.
COMMANDS_DIR = SPOOL / "cmd"
COMMANDS = {"talk", "ask", "answer", "chat", "avatar", "mute", "events", "visits", "volume"}
MAX_COMMAND = 2048
MAX_PENDING = 16  # presses waiting for the session, at most
KEEP_S = 120  # every voice is dropped after this, fetched or not; replay reaches this far

# The page, read at each request: edit it without restarting the relay.
TOOLS = Path(__file__).resolve().parent
PAGE = TOOLS / "relay.html"
# The page as an installed app: its manifest and icon (Pod 042's face).
STATIC = {
    "/manifest.webmanifest": ("manifest.webmanifest", "application/manifest+json"),
    "/icon-192.png": ("icons/icon-192.png", "image/png"),
    "/icon-512.png": ("icons/icon-512.png", "image/png"),
}


def tailnet_ip() -> str:
    out = subprocess.run(["tailscale", "ip", "-4"], capture_output=True, text=True, check=True)
    return out.stdout.split()[0]


class Handler(BaseHTTPRequestHandler):
    # A request that stalls, or a phone gone from the network mid-stream,
    # frees its thread after this many seconds instead of TCP's ~15 minutes.
    timeout = 30

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
            if not name.endswith((".wav", ".ogg")) or not f.is_file():
                self.send_error(404)
                return
            try:
                body = f.read_bytes()
            except FileNotFoundError:  # swept meanwhile
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "audio/ogg" if name.endswith(".ogg") else "audio/wav")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif self.path in STATIC:
            name, kind = STATIC[self.path]
            self.send_bytes((TOOLS / name).read_bytes(), kind, cache=True)
        elif self.path.startswith("/persona/"):
            self.persona(self.path[9:])
        elif self.path.startswith("/track/"):
            self.track(self.path[7:])
        else:
            self.send_error(404)

    def do_POST(self):
        if self.path != "/command":
            self.send_error(404)
            return
        # Nobody holds the relay: a press would wait in cmd/ and fire, with
        # all the others, when a session next takes it.
        if not (SPOOL / "owner").is_file():
            self.send_error(409, "no session holds the relay")
            return
        if len(list(COMMANDS_DIR.glob("*.json"))) >= MAX_PENDING:
            self.send_error(429)
            return
        try:
            size = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            size = 0
        if not 0 < size <= MAX_COMMAND:
            self.send_error(413)
            return
        try:
            cmd = json.loads(self.rfile.read(size))
        except ValueError:
            self.send_error(400)
            return
        # The phone finished a song, or skips it: jukebox7's waiter for it ends,
        # and jukebox7 moves on as when VLC ends a song.
        if isinstance(cmd, dict) and cmd.get("cmd") == "ended":
            tid = str(cmd.get("id", ""))
            if not TRACK_ID.match(tid):
                self.send_error(400)
                return
            (SPOOL / f"ended-{tid}").touch()
            self.send_bytes(b"{}", "application/json")
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

    def track(self, tid: str):
        """A song's audio, streamed from YouTube through yt-dlp as it comes: the
        phone asks void, whose address YouTube's links are bound to, not YouTube."""
        if not TRACK_ID.match(tid):
            self.send_error(404)
            return
        p = subprocess.Popen(
            [YTDLP, "-q", "--no-warnings", "-f", "bestaudio", "-o", "-", f"https://www.youtube.com/watch?v={tid}"],
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
        )
        try:
            first = p.stdout.read(65536)
            if not first:
                self.send_error(502, "yt-dlp gave nothing")
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(first)
            while chunk := p.stdout.read(65536):
                self.wfile.write(chunk)
        except OSError:  # the phone went: skipped, closed, or lost
            pass
        finally:
            p.kill()
            p.wait()

    def events(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        # A new tab hears only what arrives after it connects. A tab that lost
        # the link (a dead zone, a cell change) sends back the last voice it
        # got, as Last-Event-ID: what came after, still in the spool
        # (KEEP_S), is replayed.
        try:
            last = int(self.headers.get("Last-Event-ID", ""))
        except ValueError:
            last = None
        seen = {p.name for p in voices() if last is None or mtime_ns(p) <= last}
        last_ping = time.monotonic()
        state_at = 0.0
        music_at = 0.0
        try:
            while True:
                # What jukebox7 plays on the phone, at connect and on each change.
                try:
                    at = MUSIC.stat().st_mtime
                    if at != music_at:
                        music_at = at
                        self.wfile.write(b"event: music\ndata: " + MUSIC.read_bytes().replace(b"\n", b" ") + b"\n\n")
                        self.wfile.flush()
                except FileNotFoundError:
                    pass
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
                    ((mtime_ns(p), p) for p in voices() if p.name not in seen),
                    key=lambda tp: tp[0],
                )
                for at_ns, p in fresh:
                    seen.add(p.name)
                    if at_ns < 0:  # swept between the glob and now
                        continue
                    self.wfile.write(f"id: {at_ns}\ndata: {p.name}\n\n".encode())
                if fresh or time.monotonic() - last_ping > 15:
                    if not fresh:
                        self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
                    last_ping = time.monotonic()
                time.sleep(0.2)
        except OSError:  # the page went: closed, reset, or timed out
            pass


def mtime_ns(p: Path) -> int:
    """A voice's time, or -1 once sweep() took it."""
    try:
        return p.stat().st_mtime_ns
    except FileNotFoundError:
        return -1


def voices():
    """The voices waiting in the spool: Opus, or WAV when ffmpeg failed."""
    return [*SPOOL.glob("*.ogg"), *SPOOL.glob("*.wav")]


def sweep():
    while True:
        cutoff = time.time() - KEEP_S
        for p in voices():
            try:
                if p.stat().st_mtime < cutoff:
                    p.unlink()
            except FileNotFoundError:
                pass
        time.sleep(10)


def reload_on_edit():
    """Become the new relay.py when the file changes, keeping the PID (systemd
    or not) and the spool; the pages reconnect and get what they missed. A
    version that does not compile is skipped: this one keeps running."""
    me = Path(__file__).resolve()
    at = me.stat().st_mtime_ns
    while True:
        time.sleep(2)
        try:
            now = me.stat().st_mtime_ns
            if now == at:
                continue
            # A save still being written: wait until the file holds still.
            time.sleep(1)
            if me.stat().st_mtime_ns != now:
                continue
            at = now
            compile(me.read_text(), str(me), "exec")
        except (OSError, SyntaxError, ValueError) as e:
            print(f"relay.py changed but not reloaded: {e}", flush=True)
            continue
        print("relay.py changed: reloading", flush=True)
        os.execv(sys.executable, [sys.executable, str(me), *sys.argv[1:]])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default=None, help="address to bind (default: this machine's tailnet IPv4)")
    ap.add_argument("--port", type=int, default=8797)
    args = ap.parse_args()
    def stop(*_):
        shutil.rmtree(SPOOL, ignore_errors=True)
        sys.exit(0)

    # A start that fails (no tailnet, port taken, a reload that breaks at run
    # time) takes the spool with it, so the sessions speak on this machine
    # again instead of into a spool nobody serves.
    try:
        host = args.host or tailnet_ip()
        server = ThreadingHTTPServer((host, args.port), Handler)
    except BaseException:
        shutil.rmtree(SPOOL, ignore_errors=True)
        raise
    server.daemon_threads = True
    SPOOL.mkdir(parents=True, exist_ok=True)
    for part in COMMANDS_DIR.glob("*.part"):
        part.unlink(missing_ok=True)
    (SPOOL / "relay.pid").write_text(str(os.getpid()))

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    threading.Thread(target=sweep, daemon=True).start()
    threading.Thread(target=reload_on_edit, daemon=True).start()
    print(f"avatar7 relay on http://{host}:{args.port}/ (spool {SPOOL})", flush=True)
    try:
        server.serve_forever()
    finally:
        stop()


if __name__ == "__main__":
    main()
