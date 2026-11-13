"""Incremental importers for Chess.com and Lichess.

Chess.com (PubAPI, https://www.chess.com/news/view/published-data-api):
  GET /pub/player/{user}/games/archives          -> list of monthly archive URLs
  GET /pub/player/{user}/games/{YYYY}/{MM}       -> {"games": [...]}, by game END month
  Serial requests are unlimited; ETag + If-None-Match give 304 when unchanged.
  A month that ended more than 2 days before we fetched it is marked complete
  and never requested again.

Lichess (GET /api/games/user/{user}, https://lichess.org/api):
  NDJSON (Accept: application/x-ndjson), pgnInJson=true, clocks=true,
  perfType=bullet,blitz,rapid. `since` is a millisecond timestamp. The docs don't
  say which field `since` filters on, so we ask for one extra day and
  de-duplicate by game id.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from .games import SkipGame, normalize_chesscom, normalize_lichess
from .http import HttpClient
from .store import Store

CHESSCOM_API = "https://api.chess.com/pub/player"
LICHESS_API = "https://lichess.org/api/games/user"
DAY_MS = 86_400_000


def _now() -> datetime:
    return datetime.now(timezone.utc)


class ImportStats:
    def __init__(self):
        self.new = 0
        self.already_had = 0
        self.skipped: dict[str, int] = {}
        self.requests = 0
        self.not_modified = 0

    def skip(self, reason: str):
        key = reason.split(":")[0]
        self.skipped[key] = self.skipped.get(key, 0) + 1

    def as_dict(self):
        return dict(new=self.new, already_had=self.already_had, skipped=self.skipped,
                    requests=self.requests, not_modified=self.not_modified)


def import_chesscom(client: HttpClient, store: Store, settings: dict, now=_now) -> ImportStats:
    user = settings["accounts"]["chesscom"]
    tcs = settings["import"]["time_classes"]
    stats = ImportStats()
    state = store.load_state()
    cstate = state.setdefault("chesscom", {}).setdefault("archives", {})

    r = client.get(f"{CHESSCOM_API}/{user}/games/archives")
    stats.requests += 1
    if r.status != 200:
        raise RuntimeError(f"chess.com archives list failed: HTTP {r.status}")
    archives = json.loads(r.body)["archives"]

    for url in archives:
        month = "/".join(url.rstrip("/").split("/")[-2:])  # 'YYYY/MM'
        prev = cstate.get(month, {})
        if prev.get("complete"):
            continue
        headers = {}
        if prev.get("etag"):
            headers["If-None-Match"] = prev["etag"]
        if prev.get("last_modified"):
            headers["If-Modified-Since"] = prev["last_modified"]
        r = client.get(url, headers)
        stats.requests += 1
        fetched_at = now()
        if r.status == 304:
            stats.not_modified += 1
        elif r.status == 200:
            for g in json.loads(r.body)["games"]:
                try:
                    game = normalize_chesscom(g, user, tcs)
                except SkipGame as e:
                    stats.skip(str(e))
                    continue
                if store.add_game(game):
                    stats.new += 1
                else:
                    stats.already_had += 1
        else:
            raise RuntimeError(f"chess.com archive {month} failed: HTTP {r.status}")
        y, m = (int(x) for x in month.split("/"))
        month_end = datetime(y + (m == 12), m % 12 + 1, 1, tzinfo=timezone.utc)
        cstate[month] = {
            "etag": r.headers.get("etag", prev.get("etag")),
            "last_modified": r.headers.get("last-modified", prev.get("last_modified")),
            "fetched_at": fetched_at.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "complete": fetched_at > month_end + timedelta(days=2),
        }
    store.save_state(state)
    return stats


def import_lichess(client: HttpClient, store: Store, settings: dict) -> ImportStats:
    user = settings["accounts"]["lichess"]
    tcs = settings["import"]["time_classes"]
    stats = ImportStats()
    state = store.load_state()
    lstate = state.setdefault("lichess", {})

    params = f"perfType={','.join(tcs)}&pgnInJson=true&clocks=true&tags=true&moves=true&sort=dateAsc"
    if lstate.get("max_created_at"):
        params += f"&since={lstate['max_created_at'] - DAY_MS}"
    r = client.get(f"{LICHESS_API}/{user}?{params}", {"Accept": "application/x-ndjson"})
    stats.requests += 1
    if r.status != 200:
        raise RuntimeError(f"lichess export failed: HTTP {r.status}")

    max_created = lstate.get("max_created_at", 0)
    for line in r.text().splitlines():
        if not line.strip():
            continue
        g = json.loads(line)
        max_created = max(max_created, g.get("createdAt", 0))
        try:
            game = normalize_lichess(g, user, tcs)
        except SkipGame as e:
            stats.skip(str(e))
            continue
        if store.add_game(game):
            stats.new += 1
        else:
            stats.already_had += 1
    lstate["max_created_at"] = max_created
    store.save_state(state)
    return stats
