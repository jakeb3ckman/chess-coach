"""Write the app icons (plain 4x4 board in chessground's brown colours) as PNGs.
Pure standard library, so no image tools are needed: python3 tools/make_icons.py"""
import struct
import zlib
from pathlib import Path

LIGHT, DARK, EDGE = (0xF0, 0xD9, 0xB5), (0xB5, 0x88, 0x63), (0x26, 0x24, 0x21)


def png(size: int) -> bytes:
    margin = size // 8
    cell = (size - 2 * margin) / 4
    rows = []
    for y in range(size):
        row = bytearray([0])
        for x in range(size):
            if margin <= x < size - margin and margin <= y < size - margin:
                cx, cy = int((x - margin) // cell), int((y - margin) // cell)
                row += bytes(LIGHT if (cx + cy) % 2 == 0 else DARK)
            else:
                row += bytes(EDGE)
        rows.append(bytes(row))
    raw = zlib.compress(b"".join(rows), 9)

    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data) & 0xFFFFFFFF)

    return b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)) + chunk(b"IDAT", raw) + chunk(b"IEND", b"")


out = Path(__file__).resolve().parent.parent / "public"
for s in (180, 192, 512):
    (out / f"icon-{s}.png").write_bytes(png(s))
print("icons written")
