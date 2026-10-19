from html import escape
from pathlib import Path
from urllib.parse import quote
import xml.etree.ElementTree as ET


ROOT = Path(__file__).resolve().parent
SVG_NS = "http://www.w3.org/2000/svg"
ET.register_namespace("", SVG_NS)
instance = 0


def icon(path, size, css=""):
    global instance
    instance += 1
    svg = ET.parse(path).getroot()
    prefix = f"preview-{instance}-"
    # Inline copies need distinct IDs for titles and reusable paths.
    ids = {node.attrib["id"]: prefix + node.attrib["id"]
           for node in svg.iter() if "id" in node.attrib}
    for node in svg.iter():
        for key, value in list(node.attrib.items()):
            if key == "id":
                node.set(key, ids[value])
            elif key == "aria-labelledby":
                node.set(key, " ".join(ids.get(part, part) for part in value.split()))
            elif value.startswith("#") and value[1:] in ids:
                node.set(key, "#" + ids[value[1:]])
    svg.attrib.update(width=str(size), height=str(size), **{"class": css})
    svg.set("aria-hidden", "true")
    svg.attrib.pop("role", None)
    svg.attrib.pop("aria-labelledby", None)
    return ET.tostring(svg, encoding="unicode")


def samples(path, sizes):
    return '<div class="sizes">' + "".join(
        f'<div class="sample">{icon(path, size)}<span>{size} px</span></div>'
        for size in sizes
    ) + "</div>"


logo = ROOT / "gear-pine-logo.svg"
favicon = ROOT / "gear-pine-favicon.svg"
logos = "".join(
    f'<article class="card {theme}"><h3>{label}</h3>'
    f'<div class="logo-stage">{icon(logo, 256, "desktop-logo")}</div>'
    '<p class="label">Desktop · 256 px</p>'
    f'{icon(logo, 112)}<p class="label">Web · 112 px</p>'
    f'{samples(favicon, [64, 32, 16])}<p class="label">Favicon</p></article>'
    for theme, label in [("light", "Light"), ("dark", "Dark"), ("checker", "Transparent")]
)
clocks = ""
for name, filename, description in [
    ("Outline", "clock-outline.svg", "A minimal clock for everyday navigation."),
    ("Dial", "clock-dial.svg", "Four hour marks for a familiar analog face."),
    ("Solid", "clock-solid.svg", "A stronger silhouette for a selected state."),
]:
    path = ROOT.parent / "scheduled-tasks" / filename
    clocks += (
        f'<article class="clock-card"><div class="clock-hero light">{icon(path, 80)}</div>'
        f'<div class="clock-details"><h3>{name}</h3><p>{description}</p>'
        + "".join(
            f'<div class="clock-surface {theme}">{samples(path, [16, 20, 24, 32])}'
            f'<div class="nav-row">{icon(path, 20)}<span>Scheduled tasks</span></div></div>'
            for theme in ["light", "dark"]
        )
        + f'<a href="data:image/svg+xml;charset=utf-8,{quote(path.read_text())}" download="{escape(filename)}">Download SVG</a>'
        '</div></article>'
    )

page = """<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Gear + Pine · SVG icon preview</title>
  <style>
    :root { font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    * { box-sizing: border-box; }
    body { margin: 0; background: #0b1d27; color: #e9f1f4; line-height: 1.5; }
    main { width: min(1120px, calc(100% - 32px)); margin: auto; padding: 48px 0 64px; }
    h1 { margin: 0; font-size: clamp(28px, 4vw, 42px); letter-spacing: -.04em; }
    h2 { margin: 40px 0 6px; font-size: 24px; letter-spacing: -.02em; }
    h3 { margin: 0; font-size: 17px; }
    .intro { margin: 8px 0 24px; color: #afc1c9; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 300px), 1fr)); gap: 18px; }
    .card, .clock-card { min-width: 0; border: 1px solid #385462; border-radius: 20px; overflow: hidden; }
    .card { padding: 24px 16px; display: flex; align-items: center; flex-direction: column; gap: 16px; }
    .light { background: #f3f6f4; color: #17303c; }
    .dark { background: #132d39; color: #e9f1f4; }
    .checker { color: #17303c; background-color: #eef3f1; background-image: conic-gradient(#dde7e2 25%, transparent 0 50%, #dde7e2 0 75%, transparent 0); background-size: 24px 24px; }
    svg { display: block; flex-shrink: 0; }
    .logo-stage { width: 100%; min-height: 256px; display: grid; place-items: center; }
    .desktop-logo { width: 256px; max-width: 100%; height: auto; aspect-ratio: 1; }
    .label { margin: 0; font-size: 12px; font-weight: 650; letter-spacing: .08em; text-transform: uppercase; }
    .sizes { display: flex; align-items: end; justify-content: center; gap: 24px; }
    .sample { display: grid; justify-items: center; gap: 10px; font-size: 12px; }
    .clock-card { background: #16303c; }
    .clock-hero { height: 160px; display: grid; place-items: center; }
    .clock-details { padding: 20px; }
    .clock-details > p { min-height: 42px; margin: 6px 0 20px; font-size: 14px; color: #afc1c9; }
    .clock-surface { border-radius: 10px; padding: 18px 12px; margin-top: 12px; }
    .clock-surface .sizes { justify-content: space-between; gap: 12px; }
    .nav-row { display: flex; align-items: center; gap: 10px; margin-top: 22px; font-size: 14px; }
    a { display: inline-block; margin-top: 18px; color: #b1dac8; font-size: 13px; text-underline-offset: 3px; }
  </style>
</head>
<body>
  <main>
    <h1>Gear + Pine</h1>
    <p class="intro">Logo, favicon, and interface icons.</p>
    <h2>Logo &amp; favicon</h2>
    <p class="intro">Full marks and small icons on light, dark, and transparent surfaces.</p>
    <section class="grid" aria-label="Logo and favicon previews">LOGO_CARDS</section>
    <h2>Scheduled tasks</h2>
    <p class="intro">Three analog clocks at 16, 20, 24, and 32 pixels. Each follows the interface color.</p>
    <section class="grid" aria-label="Scheduled task icons">CLOCK_CARDS</section>
  </main>
</body>
</html>
"""
page = page.replace("LOGO_CARDS", logos).replace("CLOCK_CARDS", clocks)
(ROOT / "preview.html").write_text("\n".join(line.rstrip() for line in page.splitlines()) + "\n")
