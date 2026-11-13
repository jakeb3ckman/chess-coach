"""Incremental import and de-duplication, with recorded real API responses."""
import json
from datetime import datetime, timezone

from coach.http import Response
from coach.importers import DAY_MS, import_chesscom, import_lichess
from coach.store import Store

from .conftest import FIX

ARCH = "https://api.chess.com/pub/player/jakeb3ckman/games"


class FakeClient:
    """Serves recorded responses; honours If-None-Match like the real API."""

    def __init__(self, routes):
        self.routes = routes  # url -> (body bytes, etag)
        self.calls = []
        self.user_agent = "chess-coach-personal/1.0 (username: jakeb3ckman)"

    def get(self, url, headers=None):
        headers = headers or {}
        self.calls.append((url, headers))
        base = url.split("?")[0]
        body, etag = self.routes[base]
        if etag and headers.get("If-None-Match") == etag:
            return Response(304, b"", {"etag": etag})
        return Response(200, body, {"etag": etag} if etag else {})


def chesscom_routes(months, games_by_month):
    routes = {f"{ARCH}/archives": (json.dumps({"archives": [f"{ARCH}/{m}" for m in months]}).encode(), None)}
    for m in months:
        routes[f"{ARCH}/{m}"] = (json.dumps({"games": games_by_month[m]}).encode(), f'W/"{m}-v1"')
    return routes


def n_files(store):
    return len(list((store.data / "games").glob("*/*/*.json")))


def test_chesscom_second_run_imports_nothing_and_uses_etags(tmp_path, settings, chesscom_games):
    store = Store(tmp_path)
    routes = chesscom_routes(["2026/10", "2026/11"], {"2026/10": chesscom_games[:4], "2026/11": chesscom_games[4:]})
    now = lambda: datetime(2026, 11, 13, tzinfo=timezone.utc)
    first = import_chesscom(FakeClient(routes), store, settings, now=now)
    assert first.new == 6 and first.skipped == {"time class daily": 1}
    assert n_files(store) == 6

    client = FakeClient(routes)
    second = import_chesscom(client, store, settings, now=now)
    assert second.new == 0
    assert n_files(store) == 6
    requested = [u for u, _ in client.calls]
    assert f"{ARCH}/2026/10" not in requested  # October is complete: never asked again
    nov = [h for u, h in client.calls if u == f"{ARCH}/2026/11"]
    assert nov and nov[0]["If-None-Match"] == 'W/"2026/11-v1"'
    assert second.not_modified == 1


def test_chesscom_changed_month_adds_only_new_games(tmp_path, settings, chesscom_games):
    store = Store(tmp_path)
    now = lambda: datetime(2026, 11, 13, tzinfo=timezone.utc)
    routes = chesscom_routes(["2026/11"], {"2026/11": chesscom_games[:3]})
    import_chesscom(FakeClient(routes), store, settings, now=now)
    before = n_files(store)
    routes = chesscom_routes(["2026/11"], {"2026/11": chesscom_games})  # month grew
    routes[f"{ARCH}/2026/11"] = (routes[f"{ARCH}/2026/11"][0], 'W/"2026/11-v2"')
    stats = import_chesscom(FakeClient(routes), store, settings, now=now)
    assert stats.already_had == before  # old games re-seen, not rewritten
    assert n_files(store) == before + stats.new
    assert len(store.known_game_ids()) == n_files(store)  # no duplicates


def test_lichess_incremental_uses_since_with_one_day_overlap(tmp_path, settings, lichess_games):
    store = Store(tmp_path)
    body = "\n".join(json.dumps(g) for g in lichess_games).encode()
    routes = {"https://lichess.org/api/games/user/jbeck1026": (body, None)}
    client = FakeClient(routes)
    first = import_lichess(client, store, settings)
    assert first.new == 6
    assert "since=" not in client.calls[0][0]
    assert client.calls[0][1]["Accept"] == "application/x-ndjson"

    client2 = FakeClient(routes)  # the overlap day returns the same games again
    second = import_lichess(client2, store, settings)
    assert second.new == 0 and second.already_had == 6
    since = int(client2.calls[0][0].split("since=")[1].split("&")[0])
    assert since == max(g["createdAt"] for g in lichess_games) - DAY_MS
    assert n_files(store) == 6


def test_same_game_from_two_fetches_is_stored_once(tmp_path, settings, lichess_games):
    store = Store(tmp_path)
    dup = [lichess_games[0], lichess_games[0], lichess_games[1]]
    body = "\n".join(json.dumps(g) for g in dup).encode()
    stats = import_lichess(FakeClient({"https://lichess.org/api/games/user/jbeck1026": (body, None)}), store, settings)
    assert stats.new == 2 and stats.already_had == 1
    assert n_files(store) == 2


def test_user_agent_has_username_and_no_email(settings):
    ua = settings["import"]["user_agent"]
    assert "jakeb3ckman" in ua and "@" not in ua


def test_written_files_are_compact_single_line(tmp_path, settings, lichess_games):
    store = Store(tmp_path)
    body = json.dumps(lichess_games[0]).encode()
    import_lichess(FakeClient({"https://lichess.org/api/games/user/jbeck1026": (body, None)}), store, settings)
    p = next((store.data / "games").glob("*/*/*.json"))
    text = p.read_text()
    assert text.count("\n") == 1 and ": " not in text
