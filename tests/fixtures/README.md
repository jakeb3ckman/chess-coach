# Test fixtures

- `chesscom_month.json`: real game objects from the Chess.com PubAPI monthly
  archive for jakeb3ckman (unchanged API output, 7 games incl. one daily game).
- `lichess_games.ndjson`: real NDJSON lines from the Lichess export API for
  jbeck1026 (pgnInJson=true, clocks=true), incl. correspondence games against
  the computer that must be skipped.
- `engine/*.analysis.json`: real Stockfish output captured by `python -m coach
  analyze`. The engine name and every search setting (threads, hash, node
  budgets, MultiPV) are stored inside each file under `"engine"`. No evaluation
  or best move in any fixture was written by hand.
- `engine/*.game.json`: the matching normalized games.
