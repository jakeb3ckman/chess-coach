# Personal Chess Coach

A personal trainer built from my own Chess.com and Lichess games. A scheduled
GitHub Actions job imports new games, analyzes them with Stockfish, and turns
my real mistakes into spaced-repetition puzzles.

- Design: [docs/spec.md](docs/spec.md)
- Phase 1 results: [docs/phase-1-report.md](docs/phase-1-report.md)
- Phase 2 notes: [docs/phase-2-notes.md](docs/phase-2-notes.md)
- Trainer app: https://jakeb3ckman.github.io/chess-coach/
- License: GPL-3.0 ([LICENSE](LICENSE))

## Layout

| Path | What |
|---|---|
| `coach/` | Python pipeline: importers, Stockfish analysis, classification, cards |
| `config/settings.toml` | Every threshold (time trouble, card rules, node budgets) |
| `data/games/` | One compact JSON file per imported game (written once) |
| `data/analysis/` | One compact JSON file of Stockfish output per game (written once) |
| `data/state/` | Importer cursors and ETags |
| `tests/` | `uv run pytest` |
| `app/` | The trainer app (TypeScript, static site). Tests: `npm test` in `app/` |
| `.github/workflows/pipeline.yml` | Nightly import, analysis in 4 shards, build, then publish the app |
| `.github/workflows/site.yml` | Build, test and publish the app to GitHub Pages |
| `.github/workflows/screen-check.yml` | Manual: deep-check every move in a sample of games |
| `.github/workflows/verify-repeatability.yml` | Manual: re-analyze a sample and compare |

## Run locally

```bash
tools/install_stockfish.sh          # pinned Stockfish 19, checksum verified
uv sync --frozen
uv run python -m coach import       # fetch new games from both sites
uv run python -m coach analyze      # analyze games that have no analysis yet
uv run python -m coach build        # rebuild mistakes and cards in data/derived/
uv run pytest
```

App, locally:

```bash
uv run python -m coach build --app-out data/derived/app-cards.json
cd app && npm ci && npm test && npm run dev   # http://localhost:8000
```
