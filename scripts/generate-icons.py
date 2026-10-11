#!/usr/bin/env python3
"""Render the Manga Reader logo to the PNG sizes used by PWA and Android."""
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BG = (255, 92, 58, 255)
PAPER_HI = (255, 250, 244, 255)


def png_chunk(kind, data):
    body = kind + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def inside_polygon(x, y, points):
    hit = False
    j = len(points) - 1
    for i, (xi, yi) in enumerate(points):
        xj, yj = points[j]
        if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
            hit = not hit
        j = i
    return hit


def render(size):
    ss = 2
    n = size * ss
    scale = n / 512
    pixels = bytearray(n * n * 4)

    def blend(px, py, color):
        if px < 0 or py < 0 or px >= n or py >= n:
            return
        off = (py * n + px) * 4
        alpha = color[3] / 255
        for c in range(3):
            pixels[off + c] = round(color[c] * alpha + pixels[off + c] * (1 - alpha))
        pixels[off + 3] = 255

    def polygon(points, color):
        pts = [(x * scale, y * scale) for x, y in points]
        min_x = max(0, int(min(x for x, _ in pts)) - 1)
        max_x = min(n, int(max(x for x, _ in pts)) + 2)
        min_y = max(0, int(min(y for _, y in pts)) - 1)
        max_y = min(n, int(max(y for _, y in pts)) + 2)
        for py in range(min_y, max_y):
            for px in range(min_x, max_x):
                if inside_polygon(px + .5, py + .5, pts):
                    blend(px, py, color)

    def circle(cx, cy, radius, color):
        cx, cy, radius = cx * scale, cy * scale, radius * scale
        r2 = radius * radius
        for py in range(max(0, int(cy - radius)), min(n, int(cy + radius) + 1)):
            for px in range(max(0, int(cx - radius)), min(n, int(cx + radius) + 1)):
                if (px + .5 - cx) ** 2 + (py + .5 - cy) ** 2 <= r2:
                    blend(px, py, color)

    def line(x1, y1, x2, y2, width, color):
        x1, y1, x2, y2, width = (v * scale for v in (x1, y1, x2, y2, width))
        radius = width / 2
        min_x = max(0, int(min(x1, x2) - radius) - 1)
        max_x = min(n, int(max(x1, x2) + radius) + 2)
        min_y = max(0, int(min(y1, y2) - radius) - 1)
        max_y = min(n, int(max(y1, y2) + radius) + 2)
        dx, dy = x2 - x1, y2 - y1
        length2 = dx * dx + dy * dy
        for py in range(min_y, max_y):
            for px in range(min_x, max_x):
                t = max(0, min(1, ((px + .5 - x1) * dx + (py + .5 - y1) * dy) / length2))
                qx, qy = x1 + t * dx, y1 + t * dy
                if (px + .5 - qx) ** 2 + (py + .5 - qy) ** 2 <= radius * radius:
                    blend(px, py, color)

    # Rounded-square orange background, transparent outside the app icon silhouette.
    radius = 112 * scale
    for py in range(n):
        for px in range(n):
            qx = max(radius, min(n - radius, px + .5))
            qy = max(radius, min(n - radius, py + .5))
            if (px + .5 - qx) ** 2 + (py + .5 - qy) ** 2 <= radius * radius:
                blend(px, py, BG)

    # Readable, hand-built strokes for 読 (read) so launcher PNGs do not
    # depend on whether a Japanese font is installed on the build machine.
    strokes = [
        # 言 (speech radical)
        ((112, 117, 150, 101, 12), (82, 151, 208, 151, 13),
         (101, 184, 189, 184, 12), (101, 213, 189, 213, 12),
         (101, 245, 101, 325, 12), (101, 245, 191, 245, 12),
         (191, 245, 191, 325, 12), (101, 325, 191, 325, 12)),
        # 売 (sell), the right half of the character.
        ((244, 119, 420, 119, 13), (330, 119, 330, 197, 13),
         (257, 197, 405, 197, 13), (266, 239, 403, 239, 13),
         (276, 239, 276, 270, 12), (393, 239, 393, 270, 12),
         (314, 278, 287, 385, 13), (353, 278, 399, 353, 13),
         (399, 353, 386, 386, 13)),
    ]
    for group in strokes:
        for x1, y1, x2, y2, width in group:
            line(x1, y1, x2, y2, width, PAPER_HI)
    # 2x supersampling keeps the small launcher icons smooth.
    out = bytearray(size * size * 4)
    for y in range(size):
        for x in range(size):
            dst = (y * size + x) * 4
            srcs = [((y * ss + sy) * n + x * ss + sx) * 4 for sy in range(ss) for sx in range(ss)]
            for channel in range(4):
                out[dst + channel] = sum(pixels[i + channel] for i in srcs) // (ss * ss)
    rows = b"".join(b"\x00" + out[y * size * 4:(y + 1) * size * 4] for y in range(size))
    return b"\x89PNG\r\n\x1a\n" + png_chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)) + png_chunk(b"IDAT", zlib.compress(rows, 9)) + png_chunk(b"IEND", b"")


def save(path, size):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(render(size))


save(os.path.join(ROOT, "assets/icons/icon-192.png"), 192)
save(os.path.join(ROOT, "assets/icons/icon-512.png"), 512)
for density, size in [("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)]:
    folder = os.path.join(ROOT, "android/app/src/main/res", f"mipmap-{density}")
    for name in ("ic_launcher.png", "ic_launcher_round.png"):
        save(os.path.join(folder, name), size)

print("Icônes Manga Reader générées (PWA + Android).")
