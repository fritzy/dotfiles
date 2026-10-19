#!/usr/bin/env python3
"""Render a self-contained HTML work report (inline SVG charts, light/dark).

Inputs: gh-activity.sh -j and linear-activity.sh -j output for the window, plus a
content.json holding the narrative (see SKILL.md and example/content.json).

  build_report.py --gh gh.json --linear linear.json --content content.json --out report.html [--collapsed]
"""
import argparse, html, json, math, re, sys
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))  # -I drops the script dir
from days import Days
e = html.escape

ap = argparse.ArgumentParser()
ap.add_argument("--gh", required=True)
ap.add_argument("--linear", required=True)
ap.add_argument("--content", required=True)
ap.add_argument("--out", required=True)
ap.add_argument("--start", help="override content.json start")
ap.add_argument("--end", help="override content.json end")
ap.add_argument("--collapsed", action="store_true", help="render the details section closed (for screenshots)")
args = ap.parse_args()

gh = json.load(open(args.gh))
lin = json.load(open(args.linear))
C = json.load(open(args.content))

TZ = ZoneInfo(C.get("tz", "America/Los_Angeles"))
DAYS = Days(C)
START, END = date.fromisoformat(args.start or C["start"]), date.fromisoformat(args.end or C["end"])
AUTHOR = C["author"]
LINEAR_WS = C.get("linear_workspace", "chainguard")
GH_OWNER = C.get("github_owner", "chainguard-dev")
REPO_ALIAS = C.get("repo_aliases", {})
PROJECT_ALIAS = C.get("project_aliases", {})

def warn(msg):
    print(f"warning: {msg}", file=sys.stderr)

lday = DAYS.of_ts

def fmt_day(d):
    return f"{d.strftime('%b')} {d.day}"

def tlink(code):
    return f'<a class="tk" href="https://linear.app/{LINEAR_WS}/issue/{code}">{code}</a>'

def repo_short(full):
    name = full.split("/")[-1]
    return REPO_ALIAS.get(name, name)

PR_BY_REF = {}
for p in gh["prs"]:
    name = p["repo"].split("/")[1]
    for alias in {name, repo_short(p["repo"])}:
        PR_BY_REF[f"{alias}#{p['number']}"] = p

def pr_url(ref):
    p = PR_BY_REF.get(ref)
    if p:
        return p["url"]
    repo, num = ref.split("#")
    full = next((k for k, v in REPO_ALIAS.items() if v == repo), repo)
    return f"https://github.com/{GH_OWNER}/{full}/pull/{num}"

def md(text):
    """Expand [[ECO-123]] to a Linear link and [[repo#123]] to a PR link. Rest is trusted HTML."""
    def sub(m):
        ref = m.group(1)
        if "#" in ref:
            return f'<a class="pr" href="{pr_url(ref)}">{e(ref)}</a>'
        return tlink(ref)
    return re.sub(r"\[\[([^\]]+)\]\]", sub, text)

# --- PRs ----------------------------------------------------------------------
# Keep only actions inside the window, so data gathered through a later day (e.g.
# today) can't leak into a report that ends earlier.
for p in gh["prs"]:
    for a in p["actions"]:
        a["day"] = lday(a["at"]).isoformat()
    p["actions"] = [a for a in p["actions"] if START <= date.fromisoformat(a["day"]) <= END]
mine = [p for p in gh["prs"] if p["mine"] and p["actions"]]

def first_day(p, action):
    for a in p["actions"]:
        if a["action"] == action:
            return date.fromisoformat(a["day"])
    return None

def in_window(d):
    return d is not None and START <= d <= END

def status(p):
    # merged/closed after the window end reads as still open at the window end
    if p["state"] == "merged" and (first_day(p, "merged") or p.get("mergedAt") and lday(p["mergedAt"]) <= END):
        return "merged"
    if p["state"] == "closed" and first_day(p, "closed"):
        return "closed"
    if p["state"] == "draft":
        return "draft"
    return "approved" if p.get("reviewDecision") == "APPROVED" else "review"

def ref_of(p):
    return f"{repo_short(p['repo'])}#{p['number']}"

merged = [p for p in mine if status(p) == "merged"]
opened_in = [p for p in mine if in_window(first_day(p, "opened"))]
repos = sorted({repo_short(p["repo"]) for p in mine})
st_counts = {s: sum(1 for p in mine if status(p) == s) for s in ["merged", "approved", "review", "draft", "closed"]}

# --- workstreams --------------------------------------------------------------
# Four validated categorical slots + neutral "Other"; a fifth named stream needs a palette change.
SLOTS = ["s1", "s2", "s3", "s4"]
named = C["workstreams"]
if len(named) > len(SLOTS):
    sys.exit(f"error: {len(named)} workstreams; fold the smallest into 'other' (max {len(SLOTS)} named)")
other = C.get("other", {"name": "Other", "sub": "", "summary": ""})
WS = [(f"w{i}", w["name"], w.get("sub", ""), SLOTS[i]) for i, w in enumerate(named)] + [("other", other["name"], other.get("sub", ""), "s0")]
WSD = {w[0]: w for w in WS}
WS_TEXT = {f"w{i}": w.get("summary", "") for i, w in enumerate(named)} | {"other": other.get("summary", "")}
WS_OF = {}
for key, w in [(f"w{i}", w) for i, w in enumerate(named)] + [("other", other)]:
    for ref in w.get("prs", []):
        p = PR_BY_REF.get(ref)
        if not p:
            warn(f"workstream {w['name']!r}: {ref} not in gh data")
            continue
        WS_OF[id(p)] = key
for p in mine:
    if id(p) not in WS_OF:
        warn(f"{ref_of(p)} not assigned to a workstream; counted as {other['name']}")
        WS_OF[id(p)] = "other"
ws_of = lambda p: WS_OF[id(p)]
n_by_ws = {k: sum(1 for p in mine if ws_of(p) == k) for k, *_ in WS}

# --- Linear -------------------------------------------------------------------
issues = lin["issues"]
done_mine = []
for i in issues:
    if i["role"] == "mine" and i["state"] == "Done" and (i["net"] or {}).get("to") == "Done":
        t = [x for x in i["transitions"] if x["to"] == "Done"][-1]
        if lday(t["at"]) <= END:
            done_mine.append((lday(t["at"]), i))
done_mine.sort(key=lambda x: (x[0], x[1]["id"]))
net_to = lambda i: (i["net"] or {}).get("to") if (i["net"] or {}).get("changed") else None
canceled = [i for i in issues if i["role"] == "mine" and net_to(i) == "Canceled"]
in_review = [i for i in issues if i["role"] == "mine" and net_to(i) == "In Review"]
in_prog = [i for i in issues if i["role"] == "mine" and net_to(i) == "In Progress"]
filed = sorted(
    (i for i in issues if i["creator"] == AUTHOR["name"] and START <= lday(i["createdAt"]) <= END),
    key=lambda i: i["createdAt"],
)

def short_project(p):
    if not p:
        return "—"
    if p in PROJECT_ALIAS:
        return PROJECT_ALIAS[p]
    return p.split(" — ")[0] if " — " in p else p

proj_done = {}
for _, i in done_mine:
    k = short_project(i["project"])
    proj_done[k] = proj_done.get(k, 0) + 1

# --- per-day PR activity --------------------------------------------------------
days = [START + timedelta(d) for d in range((END - START).days + 1)]
ACTS = [("created", "Created", "o4"), ("updated", "Updated", "o3"), ("merged", "Merged", "o1")]
act_by_day = {d: {k: [] for k, *_ in ACTS} for d in days}
for p in mine:
    hit = {}
    for a in p["actions"]:
        d = date.fromisoformat(a["day"])
        if d not in act_by_day:
            continue
        kind = {"opened": "created", "pushed": "updated", "ready for review": "updated", "merged": "merged"}.get(a["action"])
        if kind:
            hit.setdefault(d, set()).add(kind)
    for d, ks in hit.items():
        # one bucket per PR per day, by furthest step, so stacks sum to PRs touched
        act_by_day[d][next(k for k in ("merged", "created", "updated") if k in ks)].append(p)

# --- SVG: pie -----------------------------------------------------------------
def pie_svg():
    total = sum(n_by_ws.values())
    cx = cy = 120
    r = 110
    a0 = -math.pi / 2
    parts = []
    for k, name, sub, cls in WS:
        v = n_by_ws[k]
        if not v:
            continue
        a1 = a0 + 2 * math.pi * v / total
        pct = round(100 * v / total)
        tip = f"{name}|{v} PRs · {pct}%|{sub}"
        if v == total:
            d = f"M{cx},{cy - r} A{r},{r} 0 1 1 {cx - 0.01},{cy - r} Z"
        else:
            x0, y0 = cx + r * math.cos(a0), cy + r * math.sin(a0)
            x1, y1 = cx + r * math.cos(a1), cy + r * math.sin(a1)
            d = f"M{cx},{cy} L{x0:.2f},{y0:.2f} A{r},{r} 0 {1 if a1 - a0 > math.pi else 0} 1 {x1:.2f},{y1:.2f} Z"
        parts.append(
            f'<path class="slice {cls}" d="{d}" tabindex="0" data-tip="{e(tip)}" '
            f'aria-label="{e(name)}: {v} PRs, {pct} percent"/>'
        )
        # inline count only when the slice can hold it
        if v / total >= 0.12:
            am = (a0 + a1) / 2
            lx, ly = cx + r * 0.62 * math.cos(am), cy + r * 0.62 * math.sin(am)
            parts.append(f'<text class="slice-label on-{cls}" x="{lx:.1f}" y="{ly:.1f}">{v}</text>')
        a0 = a1
    return (
        f'<svg class="pie" viewBox="0 0 240 240" role="img" '
        f'aria-label="Pie chart: {total} authored PRs by workstream">{"".join(parts)}</svg>'
    )

def pie_legend():
    total = sum(n_by_ws.values()) or 1
    rows = "".join(
        f'<li><span class="sw {cls}"></span><span class="lg-name"><b>{e(name)}</b>'
        f'<small>{e(sub)}</small></span><span class="lg-val">{n_by_ws[k]}</span>'
        f'<span class="lg-pct">{round(100 * n_by_ws[k] / total)}%</span></li>'
        for k, name, sub, cls in WS if n_by_ws[k]
    )
    return f'<ul class="legend-list">{rows}</ul>'

def pie_table():
    rows = "".join(
        f"<tr><td>{e(n)}</td><td>{n_by_ws[k]}</td>"
        f"<td>{sum(1 for p in mine if ws_of(p) == k and status(p) == 'merged')}</td></tr>"
        for k, n, _, _ in WS if n_by_ws[k]
    )
    return (
        f'<table class="data"><thead><tr><th>Workstream</th><th>PRs</th><th>Merged</th></tr></thead>'
        f"<tbody>{rows}</tbody></table>"
    )

# --- SVG: daily stacked columns ------------------------------------------------
STACK = ["merged", "updated", "created"]  # baseline up

def cols_svg():
    W, H = 680, 270
    ml, mr, mt, mb = 34, 10, 22, 46
    pw, ph = W - ml - mr, H - mt - mb
    tmax = max([sum(len(v) for v in act_by_day[d].values()) for d in days] + [2])
    top = tmax + (tmax % 2)
    ymax = top + 0.8
    step = 2 if top <= 16 else 4
    band = pw / len(days)
    bw, gap = min(24, band * 0.6), 2
    y = lambda v: mt + ph - ph * v / ymax
    cls_of = {k: c for k, _, c in ACTS}
    out = []
    for t in range(0, top + 1, step):
        out.append(f'<line class="grid" x1="{ml}" x2="{W - mr}" y1="{y(t):.1f}" y2="{y(t):.1f}"/>')
        out.append(f'<text class="tick" x="{ml - 8}" y="{y(t) + 4:.1f}" text-anchor="end">{t}</text>')
    out.append(f'<line class="base" x1="{ml}" x2="{W - mr}" y1="{y(0):.1f}" y2="{y(0):.1f}"/>')
    for i, d in enumerate(days):
        cx = ml + band * i + band / 2
        x = cx - bw / 2
        wknd = d.weekday() >= 5
        if wknd:
            out.append(f'<rect class="wknd" x="{ml + band * i:.1f}" y="{mt}" width="{band:.1f}" height="{ph}"/>')
        stack = [(k, len(act_by_day[d][k])) for k in STACK if act_by_day[d][k]]
        tot = sum(c for _, c in stack)
        acc = 0
        for j, (k, c) in enumerate(stack):
            ybot = y(acc) - (gap if j else 0)
            y1 = y(acc + c)
            if j == len(stack) - 1:
                rr = min(4, ybot - y1)
                out.append(
                    f'<path class="seg {cls_of[k]}" d="M{x:.1f},{ybot:.1f} V{y1 + rr:.1f} Q{x:.1f},{y1:.1f} {x + rr:.1f},{y1:.1f} '
                    f'H{x + bw - rr:.1f} Q{x + bw:.1f},{y1:.1f} {x + bw:.1f},{y1 + rr:.1f} V{ybot:.1f} Z"/>'
                )
            else:
                out.append(f'<rect class="seg {cls_of[k]}" x="{x:.1f}" y="{y1:.1f}" width="{bw:.1f}" height="{ybot - y1:.1f}"/>')
            acc += c
        if tot:
            out.append(f'<text class="cap" x="{cx:.1f}" y="{y(tot) - 6:.1f}" text-anchor="middle">{tot}</text>')
        out.append(f'<text class="xl{" muted" if wknd else ""}" x="{cx:.1f}" y="{H - mb + 18}" text-anchor="middle">{d.day}</text>')
        out.append(f'<text class="xw" x="{cx:.1f}" y="{H - mb + 33}" text-anchor="middle">{d.strftime("%a")[:2]}</text>')
        rows = [f"{tot} PR{'s' if tot != 1 else ''} touched"]
        for k, label, cls in ACTS:
            ps = act_by_day[d][k]
            rows.append(f"{len(ps)}\t{label.lower()}\t{cls}")
            if ps:
                rows.append("  " + " ".join(f"#{p['number']}" for p in ps))
        tip = d.strftime("%a, %b ") + str(d.day) + "|" + "|".join(rows)
        label = f"{tot} touched: " + ", ".join(f"{len(act_by_day[d][k])} {l.lower()}" for k, l, _ in ACTS)
        out.append(
            f'<rect class="hit" x="{ml + band * i:.1f}" y="{mt}" width="{band:.1f}" height="{ph}" '
            f'tabindex="0" data-tip="{e(tip)}" aria-label="{e(d.strftime("%a %b ") + str(d.day))}: {label}"/>'
        )
    return (
        f'<svg class="cols" viewBox="0 0 {W} {H}" role="img" '
        f'aria-label="Stacked column chart: authored PRs touched per day, split into created, updated and merged">'
        f'{"".join(out)}</svg>'
    )

def cols_table():
    head = "".join(f"<th>{l}</th>" for _, l, _ in ACTS)
    rows = []
    for d in days:
        cells = "".join(
            f"<td>{len(act_by_day[d][k]) or ''}"
            + (f' <span class="refs">{" ".join("#" + str(p["number"]) for p in act_by_day[d][k])}</span>' if act_by_day[d][k] else "")
            + "</td>"
            for k, _, _ in ACTS
        )
        tot = sum(len(act_by_day[d][k]) for k, _, _ in ACTS)
        rows.append(f"<tr><td>{d.strftime('%a %b')} {d.day}</td>{cells}<td><b>{tot or ''}</b></td></tr>")
    return (
        f'<table class="data"><thead><tr><th>Day</th>{head}<th>Touched</th></tr></thead>'
        f'<tbody>{"".join(rows)}</tbody></table>'
    )

# --- velocity ------------------------------------------------------------------
# Averages over active days only (any authored PR touched); a week is 5 active days.
WEEK_DAYS = 5
touched_by_day = {d: sum(len(v) for v in act_by_day[d].values()) for d in days}
active_days = [d for d in days if touched_by_day[d]]
n_active = len(active_days) or 1
touched_total = sum(touched_by_day[d] for d in active_days)
merged_total = sum(len(act_by_day[d]["merged"]) for d in active_days)
vel = {
    "touched": (touched_total / n_active, touched_total / n_active * WEEK_DAYS),
    "merged": (merged_total / n_active, merged_total / n_active * WEEK_DAYS),
}

def velocity_tile():
    num = lambda x: f"{x:.1f}"
    rows = "".join(
        f'<tr><td class="l">{label}</td><td>{num(vel[k][0])}</td><td>{num(vel[k][1])}</td></tr>'
        for k, label in (("touched", "PRs touched"), ("merged", "PRs merged"))
    )
    return (
        '<div class="card kpi velocity"><div class="label">Velocity</div>'
        '<table class="vel"><thead><tr><th></th><th>per day</th><th>per week</th></tr></thead>'
        f'<tbody>{rows}</tbody></table>'
        f'<div class="foot">Averaged over {len(active_days)} active day{"s" if len(active_days) != 1 else ""} '
        f'of {len(days)} ({touched_total} touched, {merged_total} merged); week = {WEEK_DAYS} active days. '
        'Touched = created, pushed or marked ready, or merged; once per PR per day.</div></div>'
    )

# --- hero state bar ------------------------------------------------------------
STATES = [("merged", "Merged", "o1"), ("approved", "Approved, awaiting merge", "o2"),
          ("review", "In review", "o3"), ("draft", "Draft", "o4"), ("closed", "Closed unmerged", "s0")]

def state_bar():
    total = len(mine)
    segs, keys = [], []
    for k, label, cls in STATES:
        v = st_counts[k]
        if not v:
            continue
        tip = f"{label}|{v} of {total} PRs"
        segs.append(f'<span class="{cls}" style="flex:{v}" tabindex="0" data-tip="{e(tip)}" aria-label="{e(label)}: {v}"></span>')
        keys.append(f'<span><i class="sw {cls}"></i><b>{v}</b> {e(label.split(",")[0].lower())}</span>')
    return (
        f'<div class="state-bar" role="img" aria-label="Authored PRs by state">{"".join(segs)}</div>'
        f'<div class="state-key">{"".join(keys)}</div>'
    )

# --- PR tables -----------------------------------------------------------------
CHIP = {"merged": ("✓", "merged"), "approved": ("★", "approved"), "review": ("○", "in review"),
        "draft": ("◌", "draft"), "closed": ("✕", "closed")}
ORDER = {"merged": 0, "approved": 1, "review": 2, "draft": 3, "closed": 4}

def pr_link(p):
    return f'<a class="pr" href="{p["url"]}">{e(ref_of(p))}</a>'

def pr_title(t):
    t = re.sub(r"^\[[A-Z]+-\d+\]\s*", "", t)
    t = re.sub(r"\s*\((?:[A-Z]+-\d+(?:, )?)+\)$", "", t)
    if ": " in t:
        t = t.split(": ", 1)[1]
    return e(t[:1].upper() + t[1:])

def pr_day(p):
    s = status(p)
    return first_day(p, "merged") if s == "merged" else (first_day(p, "closed") if s == "closed" else first_day(p, "opened"))

def pr_row(p):
    s = status(p)
    icon, label = CHIP[s]
    d = pr_day(p)
    tks = " ".join(tlink(c) for c in p.get("linear", [])[:3])
    return (
        f'<tr><td class="c-ref">{pr_link(p)}</td><td>{pr_title(p["title"])}</td>'
        f'<td class="c-tks">{tks}</td>'
        f'<td class="c-st"><span class="chip st-{s}">{icon} {label}</span></td>'
        f'<td class="c-when">{fmt_day(d) if d else ""}</td></tr>'
    )

def ws_cards():
    out = []
    for k, name, sub, cls in WS:
        ps = sorted((p for p in mine if ws_of(p) == k), key=lambda p: (ORDER[status(p)], pr_day(p) or START))
        if not ps:
            continue
        m = sum(1 for p in ps if status(p) == "merged")
        sub_html = f' <span class="sub">· {e(sub)}</span>' if sub else ""
        out.append(
            f'<section class="card ws"><header><span class="sw {cls}"></span><h3>{e(name)}{sub_html}</h3>'
            f'<span class="ws-count">{len(ps)} PRs · {m} merged</span></header>'
            f'<p>{md(WS_TEXT[k])}</p><table class="prs"><tbody>{"".join(pr_row(p) for p in ps)}</tbody></table></section>'
        )
    return "".join(out)

# --- standups --------------------------------------------------------------------
SC = C.get("standup_channel")

def standup_list():
    base = f'{SC["base"]}/archives/{SC["id"]}/p' if SC else ""
    return "".join(
        f'<li><span class="sd">{e(s["label"])}</span><span class="st">{md(s["summary"])}</span>'
        + (f'<a class="sl" href="{e(s.get("url") or base + s["ts"].replace(".", ""))}">post ↗</a>'
           if s.get("url") or (SC and s.get("ts")) else "<span></span>")
        + "</li>"
        for s in C.get("standups", [])
    )

# --- open now --------------------------------------------------------------------
def open_list(kind):
    notes = C.get("open_notes", {})
    rows = []
    for p in mine:
        s = status(p)
        if s != kind:
            continue
        ref = ref_of(p)
        text = md(notes[ref]) if ref in notes else pr_title(p["title"])
        if kind == "review" and ref not in notes:
            req = [r.replace("-team-write", "") for r in p.get("requested", [])]
            text += f". Requested: {e(', '.join(req))}." if req else ". No reviewer requested."
        rows.append(f'<li>{pr_link(p)} — {text}</li>')
    return "".join(rows) or "<li>None.</li>"

# --- assemble --------------------------------------------------------------------
teams = sorted({i["team"] for i in filed})
tiles = [
    ("Linear tickets → Done", len(done_mine), f"{len(in_review)} in review · {len(in_prog)} started"),
    ("Tickets filed", len(filed), ", ".join(teams)),
] + [(t["label"], t["value"], t.get("foot", "")) for t in C.get("tiles", [])]
tiles_html = "".join(
    f'<div class="card kpi"><div class="label">{e(l)}</div><div class="value">{e(str(v))}</div>'
    f'<div class="foot">{md(f)}</div></div>'
    for l, v, f in tiles
)

def done_table():
    rows = "".join(
        f'<tr><td class="c-ref">{tlink(i["id"])}</td><td>{e(i["title"])}</td>'
        f'<td class="c-proj">{e(short_project(i["project"]))}</td><td class="c-when">{fmt_day(d)}</td></tr>'
        for d, i in done_mine
    )
    return f'<table class="prs"><tbody>{rows}</tbody></table>'

def issue_rows(items, state=False):
    return "".join(
        f'<tr><td class="c-ref">{tlink(i["id"])}</td><td>{e(i["title"])}</td>'
        + (f'<td class="c-when">{e(i["state"])}</td>' if state else "")
        + "</tr>"
        for i in items
    )

def mini(title, items, state=False):
    if not items:
        return ""
    return f'<div class="mini"><h3>{title} · {len(items)}</h3><table class="prs"><tbody>{issue_rows(items, state)}</tbody></table></div>'

def ul(items):
    return "".join(f"<li>{md(x)}</li>" for x in items)

span = f"{START.strftime('%a %b')} {START.day} – {END.strftime('%a %b')} {END.day}, {END.year}"
short_span = f"{START.strftime('%b')} {START.day}–{END.day}, {END.year}" if START.month == END.month else span
channel_html = (
    f' and <a href="{SC["base"]}/archives/{SC["id"]}">#{e(SC["name"])}</a>' if SC else ""
)
on_filed = C.get("on_my_filed", [])
css = (HERE / "report.css").read_text()
js = (HERE / "report.js").read_text()

page = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Work report · {e(short_span)} · {e(AUTHOR["name"])}</title>
<style>
{css}</style>
</head>
<body>
<div class="viz-root"><div class="wrap">

<header class="top">
  <div>
    <h1>{e(C.get("title", "Work report"))}</h1>
    <p class="lede">{e(span)} · {e(AUTHOR["name"])} (@{e(AUTHOR["login"])}){" · " + e(AUTHOR["team"]) if AUTHOR.get("team") else ""}
    · from GitHub, Linear{channel_html}</p>
  </div>
  <button class="theme-btn" id="theme" type="button">Theme: auto</button>
</header>

<div class="grid kpis-top">
  <div class="card kpi hero">
    <div class="hero-pair">
      <div><div class="label">PRs authored</div><div class="value">{len(mine)}</div></div>
      <div><div class="label">PRs merged</div><div class="value">{len(merged)}</div></div>
    </div>
    {state_bar()}
    <div class="foot">across {len(repos)} repo{"s" if len(repos) != 1 else ""} · {len(opened_in)} opened in the window</div></div>
  {velocity_tile()}
</div>
<div class="grid kpis" style="--tiles: {len(tiles)}">
  {tiles_html}
</div>

<h2>Where the work went</h2>
<div class="grid charts">
  <section class="card chart-card">
    <h3>Authored PRs by workstream</h3>
    <p class="cap">{len(mine)} PRs with activity in the window, including drafts and closed.</p>
    <div class="pie-wrap">{pie_svg()}{pie_legend()}</div>
    <details><summary>Show data</summary>{pie_table()}</details>
  </section>
  <section class="card chart-card">
    <h3>Daily PR activity</h3>
    <p class="cap">Authored PRs touched each day, counted once by furthest step: merged, else created, else updated (new commits or marked ready). {e(C.get("tz_label", "Pacific time"))}; {DAYS.describe()}.</p>
    <div class="chart-legend">
      {"".join(f'<span><i class="sw {c}"></i>{l}</span>' for _, l, c in ACTS)}
    </div>
    {cols_svg()}
    <details><summary>Show data</summary>{cols_table()}</details>
  </section>
</div>

<h2>Highlights</h2>
<div class="card highlights"><ul>
  {ul(C.get("highlights", []))}
</ul></div>

<details class="more"{"" if args.collapsed else " open"}>
<summary class="more-toggle"><span class="if-open">Hide details</span><span class="if-closed">Show details</span>
  <small>Workstreams · Linear{" · standup log" if C.get("standups") else ""} · open &amp; next</small></summary>

<h2>Workstreams</h2>
<div class="grid ws-grid">
{ws_cards()}
</div>

<h2>Linear</h2>
<div class="grid split">
  <section class="card">
    <h3 style="margin:0;font-size:16px">Moved to Done · {len(done_mine)}</h3>
    <p class="by-proj">{" · ".join(f"<b>{v}</b> {e(k)}" for k, v in sorted(proj_done.items(), key=lambda x: -x[1]))}</p>
    {done_table()}
  </section>
  <section class="card">
    {mini("In review", in_review)}
    {mini("Started", in_prog)}
    {mini("Filed", filed, state=True)}
    {mini("Canceled", canceled)}
    {f'<div class="mini"><h3>{e(C.get("filed_label", "On tickets I filed"))}</h3><ul class="plain">{ul(on_filed)}</ul></div>' if on_filed else ""}
  </section>
</div>

{f'<h2>Standup log</h2><section class="card"><ul class="timeline">{standup_list()}</ul></section>' if C.get("standups") else ""}

<h2>Open now & next</h2>
<div class="grid next-grid">
  <section class="card"><h3>Needs review</h3><ul class="plain">{open_list("review")}</ul></section>
  <section class="card"><h3>Approved, awaiting merge</h3><ul class="plain">{open_list("approved")}</ul></section>
  <section class="card"><h3>Next</h3><ul class="plain">{ul(C.get("next", [])) or "<li>—</li>"}</ul></section>
</div>
</details>

<footer>Generated {datetime.now(TZ).strftime("%b %-d, %Y %-I:%M %p %Z")} from <code>gh-activity.sh</code>, <code>linear-activity.sh</code>{" and #" + e(SC["name"]) + " posts" if SC else ""}.
Counts are net state over the window; churn that cancelled out is excluded.</footer>

</div>
<div id="tip" role="tooltip"></div>
</div>
<script>
{js}</script>
</body>
</html>
"""
Path(args.out).write_text(page)
print(f"wrote {args.out}: {len(mine)} authored, {len(merged)} merged, {len(done_mine)} done, "
      f"{len(filed)} filed; workstreams {n_by_ws}")
