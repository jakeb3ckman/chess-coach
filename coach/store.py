"""File layout and write-once storage.

data/games/{site}/{YYYY-MM}/{site_id}.json     imported game (written once)
data/analysis/{site}/{YYYY-MM}/{site_id}.json  engine output (written once)
data/state/import.json                         importer cursors / ETags
data/derived/                                  rebuilt every run, not committed
"""
from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path

from .config import ROOT


class Store:
    def __init__(self, root: Path | None = None):
        self.data = Path(root) if root else ROOT / "data"

    # ---- paths
    def _rel(self, game: dict) -> Path:
        return Path(game["site"]) / game["ended_at"][:7] / f"{game['site_id']}.json"

    def game_path(self, game: dict) -> Path:
        return self.data / "games" / self._rel(game)

    def analysis_path(self, game: dict) -> Path:
        return self.data / "analysis" / self._rel(game)

    @property
    def state_path(self) -> Path:
        return self.data / "state" / "import.json"

    @property
    def derived(self) -> Path:
        return self.data / "derived"

    # ---- io
    @staticmethod
    def write_json_atomic(path: Path, obj, compact: bool = True) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        text = json.dumps(obj, separators=(",", ":")) if compact else json.dumps(obj, indent=1)
        fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp-")
        with os.fdopen(fd, "w") as f:
            f.write(text + "\n")
        os.chmod(tmp, 0o644)  # mkstemp creates 0600
        os.replace(tmp, path)  # atomic: a killed process never leaves a half-written file

    def known_game_ids(self) -> set[str]:
        ids = set()
        for p in (self.data / "games").glob("*/*/*.json"):
            ids.add(f"{p.parent.parent.name}:{p.stem}")
        return ids

    def add_game(self, game: dict) -> bool:
        """Write a new game. Returns False (and writes nothing) if it already exists."""
        path = self.game_path(game)
        if path.exists():
            return False
        self.write_json_atomic(path, game)
        return True

    def iter_games(self):
        for p in sorted((self.data / "games").glob("*/*/*.json")):
            with open(p) as f:
                yield json.load(f)

    def failure_path(self, game: dict) -> Path:
        return self.data / "analysis-failed" / self._rel(game)

    def has_failure(self, game: dict) -> bool:
        return self.failure_path(game).exists()

    def save_failure(self, game: dict, error: str) -> None:
        self.write_json_atomic(self.failure_path(game), {"id": game["id"], "error": error})

    def has_analysis(self, game: dict) -> bool:
        return self.analysis_path(game).exists()

    def load_analysis(self, game: dict) -> dict | None:
        p = self.analysis_path(game)
        if not p.exists():
            return None
        with open(p) as f:
            return json.load(f)

    def save_analysis(self, game: dict, analysis: dict) -> None:
        path = self.analysis_path(game)
        if path.exists():
            raise FileExistsError(f"analysis already exists, refusing to overwrite: {path}")
        self.write_json_atomic(path, analysis)

    def load_state(self) -> dict:
        if self.state_path.exists():
            with open(self.state_path) as f:
                return json.load(f)
        return {}

    def save_state(self, state: dict) -> None:
        self.write_json_atomic(self.state_path, state, compact=False)
