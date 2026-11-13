"""Small, polite HTTP client.

Both sites ask for serial requests (one at a time). Lichess asks to wait a full
minute after a 429. Chess.com supports ETag / If-None-Match for 304 responses.
"""
from __future__ import annotations

import gzip
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field


@dataclass
class Response:
    status: int
    body: bytes
    headers: dict = field(default_factory=dict)

    def text(self) -> str:
        return self.body.decode("utf-8")


class HttpClient:
    def __init__(self, user_agent: str, max_retries: int = 3, sleep=time.sleep):
        self.user_agent = user_agent
        self.max_retries = max_retries
        self.sleep = sleep
        self.requests_made: list[str] = []

    def get(self, url: str, headers: dict | None = None) -> Response:
        hdrs = {"User-Agent": self.user_agent, "Accept-Encoding": "gzip"}
        hdrs.update(headers or {})
        attempt = 0
        while True:
            attempt += 1
            self.requests_made.append(url)
            req = urllib.request.Request(url, headers=hdrs)
            try:
                with urllib.request.urlopen(req, timeout=120) as r:
                    body = r.read()
                    if r.headers.get("Content-Encoding") == "gzip":
                        body = gzip.decompress(body)
                    return Response(r.status, body, {k.lower(): v for k, v in r.headers.items()})
            except urllib.error.HTTPError as e:
                if e.code == 304:
                    return Response(304, b"", {k.lower(): v for k, v in e.headers.items()})
                if e.code == 429 and attempt <= self.max_retries:
                    self.sleep(61)  # both sites: back off a full minute
                    continue
                if 500 <= e.code < 600 and attempt <= self.max_retries:
                    self.sleep(10 * attempt)
                    continue
                if e.code in (404, 410):
                    return Response(e.code, b"", {})
                raise
            except urllib.error.URLError:
                if attempt <= self.max_retries:
                    self.sleep(10 * attempt)
                    continue
                raise
