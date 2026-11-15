# Opening names

`a.tsv` … `e.tsv` are copied unchanged from
[lichess-org/chess-openings](https://github.com/lichess-org/chess-openings) at commit
`3ba6b20d31b2e6125cb0e6a2e792f400717d9d39` (2026-11-05). License: CC0-1.0 (public domain).

Columns: `eco`, `name`, `pgn`. `coach/openings.py` plays each line with python-chess and
names a game by the last table position it reaches in its first 40 half-moves.
