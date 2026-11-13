"""Settings loader. All tunable numbers live in config/settings.toml."""
from __future__ import annotations

import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SETTINGS_PATH = ROOT / "config" / "settings.toml"


def load_settings(path: Path | None = None) -> dict:
    with open(path or SETTINGS_PATH, "rb") as f:
        return tomllib.load(f)
