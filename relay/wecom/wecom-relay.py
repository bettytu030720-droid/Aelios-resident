#!/usr/bin/env python3
"""The WeCom relay for Aelios-resident.

WeCom only takes API calls from the "trusted IPs" of an app, and a Cloudflare Worker has no fixed address. This runs
on a machine that has one and passes the resident's calls on to qyapi.weixin.qq.com, so WeCom sees this machine.

It listens on 127.0.0.1 only. Reach it through a Cloudflare Tunnel (or anything else that ends on this machine).
Every request needs the X-Relay-Key header. It keeps none of the WeCom keys: they stay with the resident.

    GET  /ping            what this relay can do: {"ok": true, "media": {"amr": true, ...}}
    GET|POST /cgi-bin/... passed on to WeCom as it is (status, type and body come back)
    POST /media/<to>      optional, with WECOM_RELAY_MEDIA=1 and ffmpeg: the body converted to amr (a voice
                          message WeCom takes), mp3 (a voice message she sent, to be heard), gif (a video sticker)
                          or png (a still picture)

Settings come from the environment (install.sh writes them to /etc/wecom-relay/env):
    WECOM_RELAY_KEY       required, at least 32 characters
    WECOM_RELAY_PORT      default 8787
    WECOM_RELAY_MEDIA     1 to turn the media conversions on
    WECOM_RELAY_FFMPEG    default ffmpeg
    WECOM_RELAY_UPSTREAM  default https://qyapi.weixin.qq.com (tests point it at a fake)

Only the Python standard library is used. Python 3.8+.
"""

import hmac
import http.client
import json
import os
import re
import shutil
import ssl
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

KEY = os.environ.get("WECOM_RELAY_KEY", "").strip()
PORT = int(os.environ.get("WECOM_RELAY_PORT", "8787"))
UPSTREAM = urlsplit(os.environ.get("WECOM_RELAY_UPSTREAM", "https://qyapi.weixin.qq.com").strip())
MEDIA_ON = os.environ.get("WECOM_RELAY_MEDIA", "0").strip() == "1"
FFMPEG = os.environ.get("WECOM_RELAY_FFMPEG", "ffmpeg").strip()

# WeCom takes files of up to 20 MB; a little more for the multipart around one.
MAX_FORWARD = 25 * 1024 * 1024
MAX_MEDIA = 10 * 1024 * 1024
FFMPEG_SECONDS = 30
# At most two conversions at a time, so a burst cannot take the machine down.
MEDIA_SLOTS = threading.BoundedSemaphore(2)

# ffmpeg arguments after the input, and the type of what comes out.
CONVERSIONS = {
    # WeCom voice messages are AMR-NB, 8 kHz mono, at most 60 seconds.
    "amr": (["-t", "60", "-ac", "1", "-ar", "8000", "-c:a", "libopencore_amrnb", "-b:a", "12.2k", "-f", "amr"], "audio/amr"),
    "mp3": (["-vn", "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "32k", "-f", "mp3"], "audio/mpeg"),
    "gif": (
        [
            "-t", "10", "-an",
            "-vf", "fps=15,scale='min(320,iw)':-2:flags=lanczos,split[a][b];[a]palettegen=reserve_transparent=1[p];[b][p]paletteuse=alpha_threshold=128",
            "-loop", "0", "-f", "gif",
        ],
        "image/gif",
    ),
    "png": (["-frames:v", "1", "-an", "-c:v", "png", "-f", "image2pipe"], "image/png"),
}
# The encoder each conversion needs.
ENCODERS = {"amr": "libopencore_amrnb", "mp3": "libmp3lame", "gif": "gif", "png": "png"}


def media_abilities():
    """Which conversions this machine can do: none unless they are turned on and ffmpeg is here."""
    if not MEDIA_ON or not shutil.which(FFMPEG):
        return {name: False for name in CONVERSIONS}
    try:
        listed = subprocess.run([FFMPEG, "-hide_banner", "-encoders"], capture_output=True, text=True, timeout=15).stdout
        decoders = subprocess.run([FFMPEG, "-hide_banner", "-decoders"], capture_output=True, text=True, timeout=15).stdout
    except (OSError, subprocess.SubprocessError):
        return {name: False for name in CONVERSIONS}
    abilities = {name: re.search(r"\s%s\s" % re.escape(encoder), listed) is not None for name, encoder in ENCODERS.items()}
    global VP9_ALPHA
    VP9_ALPHA = re.search(r"\slibvpx-vp9\s", decoders) is not None
    return abilities


VP9_ALPHA = False
ABILITIES = {}


def convert(to, data):
    """The body converted, or an error message."""
    args, media_type = CONVERSIONS[to]
    before = []
    # A WebM sticker keeps its see-through background only when libvpx decodes it (the built-in decoder drops it).
    if data[:4] == b"\x1a\x45\xdf\xa3" and VP9_ALPHA:
        before = ["-c:v", "libvpx-vp9"]
    command = [FFMPEG, "-hide_banner", "-loglevel", "error", *before, "-i", "pipe:0", *args, "pipe:1"]
    with MEDIA_SLOTS:
        try:
            done = subprocess.run(command, input=data, capture_output=True, timeout=FFMPEG_SECONDS)
        except subprocess.TimeoutExpired:
            return None, media_type, "ffmpeg took too long"
        except OSError as error:
            return None, media_type, "ffmpeg could not start: %s" % error
    if done.returncode != 0 or not done.stdout:
        return None, media_type, (done.stderr.decode("utf-8", "replace").strip()[-300:] or "ffmpeg failed")
    if len(done.stdout) > MAX_MEDIA:
        return None, media_type, "the result is too large"
    return done.stdout, media_type, None


class Handler(BaseHTTPRequestHandler):
    server_version = "wecom-relay"
    sys_version = ""
    protocol_version = "HTTP/1.1"
    # A connection that sends nothing for a minute is closed.
    timeout = 60

    def log_message(self, format, *args):
        # The address without its query: WeCom's access_token travels in the query.
        sys.stderr.write("%s %s\n" % (self.command, self.path.split("?", 1)[0]))

    def reply(self, status, body=b"", media_type="application/json", extra=None):
        if isinstance(body, (dict, list)):
            body = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", media_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        for name, value in (extra or {}).items():
            self.send_header(name, value)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def allowed(self):
        given = self.headers.get("X-Relay-Key", "")
        return bool(KEY) and hmac.compare_digest(given.encode(), KEY.encode())

    def body(self, limit):
        """The request body (by Content-Length or chunked), or None when it is larger than limit."""
        if "chunked" in self.headers.get("Transfer-Encoding", "").lower():
            parts, size = [], 0
            while True:
                line = self.rfile.readline(1024)
                length = int(line.split(b";", 1)[0].strip() or b"0", 16)
                if length == 0:
                    while self.rfile.readline(1024) not in (b"\r\n", b"\n", b""):
                        pass
                    return b"".join(parts)
                size += length
                if size > limit:
                    return None
                parts.append(self.rfile.read(length))
                self.rfile.readline(1024)
        length = int(self.headers.get("Content-Length") or 0)
        if length > limit:
            return None
        return self.rfile.read(length) if length else b""

    def handle_any(self):
        if not self.allowed():
            # Nothing about what is here for anyone without the key.
            self.close_connection = True
            return self.reply(403, {"error": "forbidden"})
        path = self.path.split("?", 1)[0]
        if path == "/ping" and self.command == "GET":
            return self.reply(200, {"ok": True, "media": ABILITIES})
        if path.startswith("/cgi-bin/") and ".." not in path and self.command in ("GET", "POST"):
            return self.forward()
        match = re.fullmatch(r"/media/(amr|mp3|gif|png)", path)
        if match and self.command == "POST":
            return self.media(match.group(1))
        # Whatever body came with it is left unread, so the connection cannot be used again.
        self.close_connection = True
        self.reply(404, {"error": "not found"})

    def forward(self):
        data = self.body(MAX_FORWARD) if self.command == "POST" else b""
        if data is None:
            self.close_connection = True
            return self.reply(413, {"error": "too large"})
        headers = {"Host": UPSTREAM.netloc, "User-Agent": "aelios-resident-wecom-relay", "Accept-Encoding": "identity"}
        if self.headers.get("Content-Type"):
            headers["Content-Type"] = self.headers["Content-Type"]
        if self.command == "POST":
            headers["Content-Length"] = str(len(data))
        if UPSTREAM.scheme == "https":
            connection = http.client.HTTPSConnection(UPSTREAM.hostname, UPSTREAM.port or 443, timeout=30, context=ssl.create_default_context())
        else:
            connection = http.client.HTTPConnection(UPSTREAM.hostname, UPSTREAM.port or 80, timeout=30)
        try:
            connection.request(self.command, self.path, body=data if self.command == "POST" else None, headers=headers)
            answer = connection.getresponse()
            returned = answer.read(MAX_FORWARD + 1)
        except (OSError, http.client.HTTPException) as error:
            return self.reply(502, {"error": "WeCom could not be reached: %s" % error})
        finally:
            connection.close()
        if len(returned) > MAX_FORWARD:
            return self.reply(502, {"error": "WeCom's answer is too large"})
        extra = {}
        if answer.getheader("Content-Disposition"):
            extra["Content-Disposition"] = answer.getheader("Content-Disposition")
        self.reply(answer.status, returned, answer.getheader("Content-Type") or "application/octet-stream", extra)

    def media(self, to):
        if not ABILITIES.get(to):
            self.close_connection = True
            return self.reply(501, {"error": "this relay does not convert to %s (install it with --media)" % to})
        data = self.body(MAX_MEDIA)
        if data is None:
            self.close_connection = True
            return self.reply(413, {"error": "too large"})
        if not data:
            return self.reply(400, {"error": "empty body"})
        out, media_type, error = convert(to, data)
        if error:
            return self.reply(422, {"error": error})
        self.reply(200, out, media_type)

    do_GET = handle_any
    do_POST = handle_any

    def do_PUT(self):
        self.handle_any()

    do_DELETE = do_PUT
    do_PATCH = do_PUT
    do_HEAD = do_PUT


def main():
    global ABILITIES
    if len(KEY) < 32:
        sys.exit("WECOM_RELAY_KEY must be set, at least 32 characters (install.sh makes one)")
    ABILITIES = media_abilities()
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    on = [name for name, can in ABILITIES.items() if can]
    sys.stderr.write("wecom-relay on 127.0.0.1:%d, media: %s\n" % (PORT, ", ".join(on) if on else "off"))
    server.serve_forever()


if __name__ == "__main__":
    main()
