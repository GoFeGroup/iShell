#!/usr/bin/env python3
"""Regenerate Wails icons from frontend/public/appicon.png.

Requires Python Pillow.
Wails generates the macOS ICNS from build/appicon.png during packaging.
"""

from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
source = ROOT / "frontend/public/appicon.png"
png = ROOT / "build/appicon.png"
ico = ROOT / "build/windows/icon.ico"

with Image.open(source) as source_image:
    image = source_image.convert("RGBA").resize((1024, 1024), Image.Resampling.LANCZOS)
    image.save(png)
    image.save(
        ico,
        format="ICO",
        sizes=[(size, size) for size in (16, 24, 32, 48, 64, 128, 256)],
    )
print(f"Generated {png.relative_to(ROOT)} and {ico.relative_to(ROOT)}")
