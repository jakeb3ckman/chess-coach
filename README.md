# Personal Chess Coach

A personal trainer built from my own Chess.com and Lichess games. A scheduled
GitHub Actions job imports new games, analyzes them with Stockfish, and turns
my real mistakes into spaced-repetition puzzles.

- Design: [docs/spec.md](docs/spec.md)
- Phase 1 results: [docs/phase-1-report.md](docs/phase-1-report.md)

## Layout

| Path | What |
|---|---|
| `coach/` | Python pipeline: importers, Stockfish analysis, classification, cards |
| `config/settings.toml` | Every threshold (time trouble, card rules, node budgets) |
| `data/games/` | One compact JSON file per imported game (written once) |
| `data/analysis/` | One compact JSON file of Stockfish output per game (written once) |
| `data/state/` | Importer cursors and ETags |
| `tests/` | `uv run pytest` |
| `.github/workflows/pipeline.yml` | Nightly import, analysis in 4 shards, build |

## Run locally

```bash
tools/install_stockfish.sh          # pinned Stockfish 19, checksum verified
uv sync --frozen
uv run python -m coach import       # fetch new games from both sites
uv run python -m coach analyze      # analyze games that have no analysis yet
uv run python -m coach build        # rebuild mistakes and cards in data/derived/
uv run pytest
```
