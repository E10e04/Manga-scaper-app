#!/usr/bin/env python3
"""Render the SVG Manga Reader marks into PWA and Android launcher icons."""
import os
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RESVG = os.path.join(ROOT, "node_modules", ".bin", "resvg-js")
FONT = os.path.join(ROOT, "assets", "fonts", "NotoSansJP-Black-Manga.ttf")


def render(source, output, size):
    os.makedirs(os.path.dirname(output), exist_ok=True)
    subprocess.run(
        [
            RESVG,
            "--font-file", FONT,
            "--font-default-family", "Noto Sans JP",
            "--fit-width", str(size),
            source,
            output,
        ],
        check=True,
    )


logo = os.path.join(ROOT, "assets", "icons", "logo.svg")
foreground = os.path.join(ROOT, "assets", "icons", "launcher-foreground.svg")
render(logo, os.path.join(ROOT, "assets", "icons", "icon-192.png"), 192)
render(logo, os.path.join(ROOT, "assets", "icons", "icon-512.png"), 512)

for density, size in [("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)]:
    folder = os.path.join(ROOT, "android", "app", "src", "main", "res", f"mipmap-{density}")
    for name in ("ic_launcher.png", "ic_launcher_round.png"):
        render(logo, os.path.join(folder, name), size)
    render(foreground, os.path.join(folder, "ic_launcher_foreground.png"), size)

print("Icônes 漫画 générées (PWA + Android).")
