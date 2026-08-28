#!/usr/bin/env python3
"""Chrome Web Store publishing for this extension. Stdlib only.

  ./scripts/cws.py auth      one-time: browser consent -> CWS_REFRESH_TOKEN in .env
  ./scripts/cws.py status    show the item's current upload/publish state
  ./scripts/cws.py upload    push a zip as a new draft   (default: newest zip in repo root)
  ./scripts/cws.py publish   submit the draft for review
  ./scripts/cws.py ship      upload + publish

Needs CWS_CLIENT_ID / CWS_CLIENT_SECRET in .env (OAuth "Desktop app" client,
project personal-projects-230701, Chrome Web Store API enabled).
"""
import http.server, json, os, pathlib, socket, ssl, sys, threading, urllib.parse, urllib.request, webbrowser

ROOT = pathlib.Path(__file__).resolve().parent.parent
ENV = ROOT / ".env"
SCOPE = "https://www.googleapis.com/auth/chromewebstore"
API = "https://www.googleapis.com/chromewebstore/v1.1"
UPLOAD = "https://www.googleapis.com/upload/chromewebstore/v1.1"


def env():
    out = {}
    for line in ENV.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def env_set(key, value):
    text = ENV.read_text()
    line = f"{key}={value}"
    lines = text.splitlines()
    for i, l in enumerate(lines):
        if l.startswith(f"{key}="):
            lines[i] = line
            break
    else:
        lines.append(line)
    ENV.write_text("\n".join(lines) + "\n")


def need(cfg, *keys):
    missing = [k for k in keys if not cfg.get(k)]
    if missing:
        sys.exit(f"missing in .env: {', '.join(missing)}")
    return [cfg[k] for k in keys]


def post_form(url, data):
    body = urllib.parse.urlencode(data).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def api(method, url, token, body=None, ctype=None):
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Authorization", f"Bearer {token}")
    req.add_header("x-goog-api-version", "2")
    req.add_header("Content-Type", ctype or "application/json")
    if body is None:
        req.add_header("Content-Length", "0")
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            return json.loads(r.read() or "{}")
    except urllib.error.HTTPError as e:
        sys.exit(f"{method} {url}\nHTTP {e.code}: {e.read().decode()[:2000]}")


def access_token(cfg):
    cid, secret, refresh = need(cfg, "CWS_CLIENT_ID", "CWS_CLIENT_SECRET", "CWS_REFRESH_TOKEN")
    tok = post_form("https://oauth2.googleapis.com/token", {
        "client_id": cid, "client_secret": secret,
        "refresh_token": refresh, "grant_type": "refresh_token",
    })
    return tok["access_token"]


def cmd_auth(cfg):
    cid, secret = need(cfg, "CWS_CLIENT_ID", "CWS_CLIENT_SECRET")
    sock = socket.socket(); sock.bind(("127.0.0.1", 0)); port = sock.getsockname()[1]; sock.close()
    redirect = f"http://localhost:{port}"
    got = {}

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            got.update({k: v[0] for k, v in q.items()})
            self.send_response(200); self.send_header("Content-Type", "text/html"); self.end_headers()
            self.wfile.write(b"<h2>Done - close this tab.</h2>" if "code" in got else b"<h2>Failed.</h2>")
            done.set()
        def log_message(self, *a): pass

    done = threading.Event()
    srv = http.server.HTTPServer(("127.0.0.1", port), H)

    def serve():
        while not done.is_set():
            srv.handle_request()
    threading.Thread(target=serve, daemon=True).start()

    url = "https://accounts.google.com/o/oauth2/v2/auth?" + urllib.parse.urlencode({
        "client_id": cid, "redirect_uri": redirect, "response_type": "code",
        "scope": SCOPE, "access_type": "offline", "prompt": "consent",
    })
    print("Sign in as the Web Store publisher account, then approve:\n\n" + url + "\n")
    if "--no-open" not in sys.argv:
        try: webbrowser.open(url)
        except Exception: pass
    if not done.wait(3600):
        sys.exit("timed out waiting for consent")
    if "error" in got:
        sys.exit(f"consent failed: {got['error']}")

    tok = post_form("https://oauth2.googleapis.com/token", {
        "client_id": cid, "client_secret": secret, "code": got["code"],
        "grant_type": "authorization_code", "redirect_uri": redirect,
    })
    if "refresh_token" not in tok:
        sys.exit(f"no refresh_token returned: {tok}")
    env_set("CWS_REFRESH_TOKEN", tok["refresh_token"])
    print("CWS_REFRESH_TOKEN written to .env")


def newest_zip():
    zips = sorted(ROOT.glob("*.zip"), key=lambda p: p.stat().st_mtime)
    if not zips:
        sys.exit("no .zip in repo root - build one first")
    return zips[-1]


def cmd_status(cfg):
    item, = need(cfg, "CWS_ITEM_ID")
    r = api("GET", f"{API}/items/{item}?projection=DRAFT", access_token(cfg))
    print(json.dumps(r, indent=2))


def cmd_upload(cfg, path=None):
    item, = need(cfg, "CWS_ITEM_ID")
    zpath = pathlib.Path(path) if path else newest_zip()
    print(f"uploading {zpath.name} ({zpath.stat().st_size} bytes)")
    r = api("PUT", f"{UPLOAD}/items/{item}?uploadType=media", access_token(cfg),
            zpath.read_bytes(), "application/zip")
    print(json.dumps(r, indent=2))
    if r.get("uploadState") not in ("SUCCESS", "IN_PROGRESS"):
        sys.exit("upload rejected")


def cmd_publish(cfg):
    item, = need(cfg, "CWS_ITEM_ID")
    r = api("POST", f"{API}/items/{item}/publish", access_token(cfg))
    print(json.dumps(r, indent=2))


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "status"
    cfg = env()
    if cmd == "auth": cmd_auth(cfg)
    elif cmd == "status": cmd_status(cfg)
    elif cmd == "upload": cmd_upload(cfg, sys.argv[2] if len(sys.argv) > 2 else None)
    elif cmd == "publish": cmd_publish(cfg)
    elif cmd == "ship": cmd_upload(cfg, sys.argv[2] if len(sys.argv) > 2 else None); cmd_publish(cfg)
    else: sys.exit(__doc__)
