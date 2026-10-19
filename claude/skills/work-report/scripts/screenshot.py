#!/usr/bin/env python3
"""Screenshot a work report with the details section collapsed, trimmed to content.

  screenshot.py report.html out.png [--width 1200] [--expanded]

Needs headless Firefox and Pillow. Shareable preview for Slack, which shows .html
uploads as source rather than rendering them.
"""
import argparse, subprocess, sys, tempfile
from pathlib import Path
from PIL import Image

ap = argparse.ArgumentParser()
ap.add_argument("html")
ap.add_argument("out")
ap.add_argument("--width", type=int, default=1200)
ap.add_argument("--height", type=int, help="viewport height before trimming (default 4000, 16000 expanded)")
ap.add_argument("--expanded", action="store_true", help="keep the details section open")
args = ap.parse_args()
args.height = args.height or (16000 if args.expanded else 4000)

src = Path(args.html).read_text()
if not args.expanded:
    src = src.replace('<details class="more" open>', '<details class="more">')

with tempfile.TemporaryDirectory() as tmp:
    page = Path(tmp) / "page.html"
    raw = Path(tmp) / "raw.png"
    profile = Path(tmp) / "profile"
    profile.mkdir()
    page.write_text(src)
    subprocess.run(
        ["firefox", "--headless", "--profile", str(profile), f"--window-size={args.width},{args.height}",
         "--screenshot", str(raw), page.as_uri()],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120, check=False,
    )
    if not raw.exists():
        sys.exit("error: firefox produced no screenshot")
    im = Image.open(raw).convert("RGB")
    w, h = im.size
    px = im.load()
    bg = px[5, h - 5]
    last = max((y for y in range(0, h, 4) if any(px[x, y] != bg for x in range(0, w, 16))), default=h)
    im.crop((0, 0, w, min(h, last + 60))).save(args.out, optimize=True)
    print(f"wrote {args.out} ({w}x{min(h, last + 60)})")
