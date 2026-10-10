#!/usr/bin/env python3
"""Render the Manga Reader logo to the PNG sizes used by PWA and Android."""
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BG = (11, 13, 19, 255)
PAPER = (244, 238, 231, 255)
PAPER_HI = (255, 250, 244, 255)
INK = (23, 25, 34, 255)
RED = (229, 83, 61, 255)


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

    # Rounded-square background, transparent outside the app icon silhouette.
    radius = 112 * scale
    for py in range(n):
        for px in range(n):
            qx = max(radius, min(n - radius, px + .5))
            qy = max(radius, min(n - radius, py + .5))
            if (px + .5 - qx) ** 2 + (py + .5 - qy) ** 2 <= radius * radius:
                blend(px, py, BG)

    ray = (244, 238, 231, 185)
    for a, b, c, d, w in [
        (49, 164, 158, 193, 12), (28, 230, 133, 245, 12), (42, 310, 142, 302, 12),
        (462, 165, 354, 194, 12), (484, 230, 379, 245, 12), (469, 310, 370, 302, 12),
        (90, 104, 169, 167, 8), (422, 104, 343, 167, 8),
    ]:
        line(a, b, c, d, w, ray)

    circle(352, 157, 78, RED)
    polygon([(113, 157), (173, 145), (222, 151), (256, 170), (256, 395), (229, 379), (171, 371), (113, 382)], PAPER)
    polygon([(256, 170), (290, 151), (342, 145), (399, 157), (399, 382), (342, 371), (285, 379), (256, 395)], PAPER)
    polygon([(127, 190), (168, 180), (238, 199), (238, 351), (171, 341), (127, 351)], PAPER_HI)
    polygon([(274, 199), (343, 180), (385, 190), (385, 351), (341, 341), (274, 351)], PAPER_HI)
    line(256, 170, 256, 392, 12, INK)
    for y, width in [(233, 54), (254, 42), (275, 50), (296, 35)]:
        line(155, y, 155 + width, y, 9, INK)
    polygon([(291, 241), (345, 214), (327, 256), (359, 244), (293, 319), (308, 271), (276, 286)], RED)
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
