#!/usr/bin/env python3
"""Generate app icons with no third-party deps (pure-Python PNG writer).

Design: rounded green square, a white "plate" circle, and a diagonal green leaf.
Run: python3 generate_icons.py
"""
import struct, zlib, math

def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))

def make_icon(size):
    bg_top = (52, 211, 153)    # #34d399
    bg_bot = (5, 150, 105)     # #059669
    plate = (255, 255, 255)
    leaf = (22, 163, 74)       # #16a34a

    c = size / 2.0
    rc = size * 0.22           # corner radius
    rp = size * 0.34           # plate radius
    rl = size * 0.30           # leaf circle radius
    d = size * 0.13            # leaf circle offset

    cax, cay = c + d, c - d    # leaf circle A center
    cbx, cby = c - d, c + d    # leaf circle B center

    px = bytearray()
    for y in range(size):
        px.append(0)  # PNG filter byte (none) per row
        t = y / (size - 1)
        bg = lerp(bg_top, bg_bot, t)
        for x in range(size):
            # rounded-square mask
            dx = max(rc - x, x - (size - rc), 0)
            dy = max(rc - y, y - (size - rc), 0)
            if dx * dx + dy * dy > rc * rc:
                px.extend((0, 0, 0, 0))  # transparent corner
                continue

            r, g, b = bg
            # plate
            if (x - c) ** 2 + (y - c) ** 2 <= rp * rp:
                r, g, b = plate
                # leaf = intersection of two circles, clipped to plate
                in_a = (x - cax) ** 2 + (y - cay) ** 2 <= rl * rl
                in_b = (x - cbx) ** 2 + (y - cby) ** 2 <= rl * rl
                if in_a and in_b:
                    r, g, b = leaf
            px.extend((r, g, b, 255))
    return png_bytes(size, size, bytes(px))

def png_bytes(w, h, raw_rgba):
    def chunk(typ, data):
        c = typ + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xffffffff)
    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)  # 8-bit RGBA
    idat = zlib.compress(raw_rgba, 9)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")

for s in (180, 192, 512):
    with open(f"icon-{s}.png", "wb") as f:
        f.write(make_icon(s))
    print(f"wrote icon-{s}.png")
