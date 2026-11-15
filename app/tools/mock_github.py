"""A local stand-in for the few GitHub REST endpoints the app's sync uses, for
testing sync with two browser profiles without a real token or repository.

    python3 tools/mock_github.py [port]        (default 8787)

Mimics GitHub's behaviour as documented and as checked against api.github.com:
CORS for any origin; 401 {"message": "Bad credentials"} for a bad token; 404 for
an unknown repo; 409 for the file list of an empty repo; base64 file contents with
line breaks; the blob sha of a file (git's sha1 of "blob <len>\\0<data>"); PUT
needs the current sha to replace a file (422 without it, 409 if it is stale).

Test controls (not GitHub): POST /__admin/revoke | /__admin/restore | /__admin/public |
/__admin/private | /__admin/reset, GET /__admin/state, GET /__admin/log.
Valid token: "test-token" (any token starting with "test-").
"""
from __future__ import annotations

import base64
import hashlib
import json
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

REPO = "jakeb3ckman/chess-coach-progress"
STATE = {"files": {}, "revoked": False, "private": True, "commits": 0, "log": []}


def blob_sha(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def b64_lines(data: bytes) -> str:
    s = base64.b64encode(data).decode()
    return "\n".join(s[i:i + 60] for i in range(0, len(s), 60)) + "\n"


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):  # keep the console quiet
        pass

    def cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type, X-GitHub-Api-Version")
        self.send_header("Access-Control-Allow-Methods", "GET, PUT, POST, OPTIONS")
        self.send_header("Access-Control-Expose-Headers", "X-RateLimit-Remaining, Retry-After")

    def reply(self, code: int, obj=None):
        body = json.dumps(obj if obj is not None else {}).encode()
        self.send_response(code)
        self.cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def authed(self) -> bool:
        tok = self.headers.get("Authorization", "")
        ok = tok.startswith("Bearer test-") and not STATE["revoked"]
        if not ok:
            self.reply(401, {"message": "Bad credentials", "status": "401"})
        return ok

    def body(self):
        n = int(self.headers.get("Content-Length", 0))
        return json.loads(self.rfile.read(n) or b"{}")

    def do_POST(self):
        p = urlparse(self.path).path
        if p == "/__admin/revoke":
            STATE["revoked"] = True
        elif p == "/__admin/restore":
            STATE["revoked"] = False
        elif p == "/__admin/public":
            STATE["private"] = False
        elif p == "/__admin/private":
            STATE["private"] = True
        elif p == "/__admin/reset":
            STATE.update(files={}, revoked=False, private=True, commits=0, log=[])
        else:
            return self.reply(404, {"message": "Not Found"})
        self.reply(200, {"ok": True})

    def do_GET(self):
        u = urlparse(self.path)
        p = u.path
        if p == "/__admin/state":
            return self.reply(200, {"commits": STATE["commits"], "revoked": STATE["revoked"],
                                    "files": {k: v.decode().count("\n") for k, v in STATE["files"].items()},
                                    "contents": {k: v.decode() for k, v in STATE["files"].items()}})
        if p == "/__admin/log":
            return self.reply(200, STATE["log"])
        STATE["log"].append(f"GET {p}")
        if not self.authed():
            return
        if p == f"/repos/{REPO}":
            return self.reply(200, {"full_name": REPO, "private": STATE["private"], "default_branch": "main"})
        if p == f"/repos/{REPO}/git/trees/main":
            if not STATE["files"]:
                return self.reply(409, {"message": "Git Repository is empty."})
            tree = [{"path": k, "mode": "100644", "type": "blob", "sha": blob_sha(v), "size": len(v)} for k, v in sorted(STATE["files"].items())]
            return self.reply(200, {"sha": "t%d" % STATE["commits"], "tree": tree, "truncated": False})
        m = re.fullmatch(rf"/repos/{REPO}/git/blobs/([0-9a-f]+)", p)
        if m:
            for v in STATE["files"].values():
                if blob_sha(v) == m.group(1):
                    return self.reply(200, {"sha": m.group(1), "size": len(v), "encoding": "base64", "content": b64_lines(v)})
            return self.reply(404, {"message": "Not Found"})
        m = re.fullmatch(rf"/repos/{REPO}/contents/(.+)", p)
        if m:
            data = STATE["files"].get(m.group(1))
            if data is None:
                return self.reply(404, {"message": "Not Found"})
            return self.reply(200, {"type": "file", "path": m.group(1), "sha": blob_sha(data), "size": len(data),
                                    "encoding": "base64", "content": b64_lines(data)})
        self.reply(404, {"message": "Not Found"})

    def do_PUT(self):
        p = urlparse(self.path).path
        STATE["log"].append(f"PUT {p}")
        if not self.authed():
            return
        m = re.fullmatch(rf"/repos/{REPO}/contents/(.+)", p)
        if not m:
            return self.reply(404, {"message": "Not Found"})
        b = self.body()
        path = m.group(1)
        old = STATE["files"].get(path)
        if old is not None and "sha" not in b:
            return self.reply(422, {"message": 'Invalid request.\n\n"sha" wasn\'t supplied.'})
        if old is not None and b["sha"] != blob_sha(old):
            return self.reply(409, {"message": f"{path} does not match {b['sha']}"})
        data = base64.b64decode(b["content"])
        STATE["files"][path] = data
        STATE["commits"] += 1
        self.reply(201 if old is None else 200, {"content": {"path": path, "sha": blob_sha(data)}, "commit": {"sha": "c%d" % STATE["commits"]}})


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8787
    print(f"mock GitHub API on http://localhost:{port} (repo {REPO}, token test-token)")
    ThreadingHTTPServer(("0.0.0.0", port), H).serve_forever()
