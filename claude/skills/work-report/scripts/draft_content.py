#!/usr/bin/env python3
"""Draft content.json for build_report.py from activity data alone, no model needed.

  draft_content.py --gh gh.json --linear linear.json --config config.json \
    --start YYYY-MM-DD --end YYYY-MM-DD [--standup-log posts.jsonl] [--offline] --out content.json

Workstreams come from config rules, then Linear project / commit scope for the rest.
Linked-ticket projects and open assigned issues are looked up with the `linear` CLI
(skipped with --offline).
"""
import argparse, json, re, subprocess, sys
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parent))  # -I drops the script dir
from days import Days

ap = argparse.ArgumentParser()
ap.add_argument("--gh", required=True)
ap.add_argument("--linear", required=True)
ap.add_argument("--config", required=True)
ap.add_argument("--start", required=True)
ap.add_argument("--end", required=True)
ap.add_argument("--standup-log")
ap.add_argument("--offline", action="store_true")
ap.add_argument("--out", required=True)
args = ap.parse_args()

gh = json.load(open(args.gh))
lin = json.load(open(args.linear))
cfg = json.load(open(args.config))
START, END = date.fromisoformat(args.start), date.fromisoformat(args.end)
TZ = ZoneInfo(cfg.get("tz", "America/Los_Angeles"))
DAYS = Days(cfg)
SLOTS = 4
FILED_LABEL = cfg.get("filed_label", "On tickets I filed")
# author.linear (email or user id) when the report is about someone else
WHO = cfg["author"].get("linear")
LINEAR_WHO = (f'email: {{ eq: {json.dumps(WHO)} }}' if "@" in WHO else f'id: {{ eq: {json.dumps(WHO)} }}') if WHO \
    else "isMe: { eq: true }"
TICKET = re.compile(r"\b[A-Z][A-Z0-9]+-\d+\b")

def warn(msg):
    print(f"warning: {msg}", file=sys.stderr)

lday = DAYS.of_ts

def fmt_day(d):
    return f"{d.strftime('%a %b')} {d.day}"

def repo_short(full):
    name = full.split("/")[-1]
    return cfg.get("repo_aliases", {}).get(name, name)

def ref_of(p):
    return f"{repo_short(p['repo'])}#{p['number']}"

def short_project(name):
    if not name:
        return None
    alias = cfg.get("project_aliases", {})
    return alias.get(name) or (name.split(" — ")[0] if " — " in name else name)

def linear_api(query):
    if args.offline:
        return {}
    try:
        out = subprocess.run(["linear", "api", query], capture_output=True, text=True, timeout=60, cwd="/tmp", check=True)
        return json.loads(out.stdout).get("data") or {}
    except (subprocess.SubprocessError, json.JSONDecodeError, FileNotFoundError) as err:
        warn(f"linear api failed ({err}); continuing without it")
        return {}

# Same window clipping as build_report.py.
for p in gh["prs"]:
    for a in p["actions"]:
        a["day"] = lday(a["at"]).isoformat()
    p["actions"] = [a for a in p["actions"] if START <= date.fromisoformat(a["day"]) <= END]
mine = [p for p in gh["prs"] if p["mine"] and p["actions"]]
issues = {i["id"]: i for i in lin["issues"]}

# --- linked-ticket projects ------------------------------------------------------
tickets = {k: {"project": i["project"], "team": i["team"], "title": i["title"]} for k, i in issues.items()}
missing = sorted({c for p in mine for c in p.get("linear", []) if c not in tickets})
for chunk in [missing[i:i + 40] for i in range(0, len(missing), 40)]:
    q = " ".join(f'a{n}: issue(id: "{c}") {{ identifier title team {{ key }} project {{ name }} }}' for n, c in enumerate(chunk))
    for node in linear_api("{ " + q + " }").values():
        if node:
            tickets[node["identifier"]] = {"project": (node.get("project") or {}).get("name"),
                                           "team": node["team"]["key"], "title": node["title"]}

def primary_ticket(p):
    linked = p.get("linear", [])
    # titles can carry ID-shaped tokens (e.g. "SC-7"); trust only real Linear refs
    refs = [c for c in TICKET.findall(p["title"]) if c in linked] or linked
    return tickets.get(refs[0]) if refs else None

def scope(title):
    m = re.match(r"^(?:\[[A-Z]+-\d+\]\s*)?[a-z]+\s*\(([^)]+)\)!?:", title)
    return m.group(1) if m else None

# --- workstreams -------------------------------------------------------------------
def rule_matches(rule, p):
    m = rule.get("match", {})
    t = primary_ticket(p)
    sc = scope(p["title"]) or ""
    linked_teams = {c.split("-")[0] for c in p.get("linear", [])}
    return any([
        t and t["project"] and any(re.search(rx, t["project"]) for rx in m.get("projects", [])),
        bool(linked_teams & set(m.get("teams", []))),
        any(re.search(rx, sc) for rx in m.get("scopes", [])),
        p["repo"].split("/")[1] in m.get("repos", []) or repo_short(p["repo"]) in m.get("repos", []),
        any(re.search(rx, p["title"]) for rx in m.get("titles", [])),
    ])

groups = defaultdict(list)  # key -> PRs
meta = {}                   # key -> {"name", "sub", "rule"}
for p in mine:
    rule = next((r for r in cfg.get("workstreams", []) if rule_matches(r, p)), None)
    if rule:
        key = "rule:" + rule["name"]
        meta[key] = {"name": rule["name"], "sub": rule.get("sub", ""), "rule": rule}
    else:
        t = primary_ticket(p)
        label = short_project(t["project"]) if t and t["project"] else (scope(p["title"]) or repo_short(p["repo"]))
        key = "auto:" + label
        full = t["project"] if t and t["project"] else ""
        meta[key] = {"name": label, "sub": full.split(" — ", 1)[1] if " — " in full else "", "rule": None}
    groups[key].append(p)

# Rule-defined streams claim slots first; the largest auto groups fill what's left.
ranked = sorted(groups, key=lambda k: (not k.startswith("rule:"), -len(groups[k]), k))
named = sorted(ranked[:SLOTS], key=lambda k: (-len(groups[k]), k))
rest = ranked[SLOTS:]
for k in rest:
    if k.startswith("rule:"):
        warn(f"workstream {meta[k]['name']!r} folded into Other (more than {SLOTS} streams)")

# --- Linear facts --------------------------------------------------------------------
def net_to(i):
    n = i.get("net") or {}
    return n.get("to") if n.get("changed") else None

done = []
for i in lin["issues"]:
    if i["role"] == "mine" and i["state"] == "Done" and net_to(i) == "Done":
        t = [x for x in i["transitions"] if x["to"] == "Done"][-1]
        if lday(t["at"]) <= END:
            done.append((lday(t["at"]), i))
done.sort(key=lambda x: (x[0], x[1]["id"]))
done_ids = {i["id"] for _, i in done}

def claim_done():
    """Give each Done ticket to one workstream: title ref, then any PR link, then project rule."""
    owner = {}
    for _, i in done:
        tid = i["id"]
        by_title = [k for k in named + rest for p in groups[k] if tid in TICKET.findall(p["title"])]
        by_link = Counter(k for k in named + rest for p in groups[k] if tid in p.get("linear", []))
        by_proj = [k for k in named + rest
                   if (meta[k]["rule"] and i["project"] and any(re.search(rx, i["project"]) for rx in
                                                                meta[k]["rule"].get("match", {}).get("projects", [])))
                   or (not meta[k]["rule"] and short_project(i["project"]) == meta[k]["name"])]
        k = (by_title or [by_link.most_common(1)[0][0]] if by_title or by_link else by_proj or [None])[0]
        if k:
            owner.setdefault(k, []).append(tid)
    return owner

DONE_BY_WS = claim_done()

def ws_done(k):
    return DONE_BY_WS.get(k, [])

def status(p):
    acts = {a["action"] for a in p["actions"]}
    if p["state"] == "merged" and ("merged" in acts or p.get("mergedAt") and lday(p["mergedAt"]) <= END):
        return "merged"
    if p["state"] == "closed" and "closed" in acts:
        return "closed"
    if p["state"] == "draft":
        return "draft"
    return "approved" if p.get("reviewDecision") == "APPROVED" else "review"

def ws_summary(k):
    c = Counter(status(p) for p in groups[k])
    parts = [f"{c[s]} {label}" for s, label in
             (("merged", "merged"), ("approved", "approved, awaiting merge"), ("review", "in review"),
              ("draft", "draft"), ("closed", "closed unmerged")) if c[s]]
    text = ", ".join(parts).capitalize() + "."
    d = ws_done(k)
    if d:
        more = f" and {len(d) - 8} more" if len(d) > 8 else ""
        text += f" {len(d)} ticket{'s' if len(d) != 1 else ''} → Done: " + ", ".join(f"[[{x}]]" for x in d[:8]) + more + "."
    return text

milestone_rx = cfg.get("milestone", {}).get("title", "^Phase demo")
milestones = [i for _, i in done if re.search(milestone_rx, i["title"])]

def milestone_parts(title):
    head, _, tail = title.partition(":")
    name = re.sub(milestone_rx, "", head).strip(" —-") or head
    return head.strip(), name, tail.strip()

# Others' net changes on tickets the author filed. Automation moves (PR merges, branch
# links) are credited to nobody: say whose ticket it is and that it was auto-moved.
on_filed = defaultdict(list)
team_moves = []
for i in lin["issues"]:
    if i["role"] != "filed-others":
        continue
    to = net_to(i)
    by = [b for b in (i.get("net") or {}).get("by", []) if b != "me"]
    if to and by:
        human = next((b for b in by if b != "automation"), None)
        key = ("human", human) if human else ("auto", i.get("assignee") or "Unassigned")
        on_filed[(key, to)].append(i["id"])
    for m in i.get("teamMoves", []):
        if m["by"] != "me":
            team_moves.append(f"[[{i['id']}]] moved {m['from']} → {m['to']} ({m['by']})")
VERB = {"Done": "closed", "In Progress": "started", "Canceled": "canceled"}
on_my_filed = []
for ((kind, who), to), ids in sorted(on_filed.items(), key=lambda kv: (kv[0][0][0], kv[0][0][1], kv[0][1])):
    refs = ", ".join(f"[[{x}]]" for x in ids)
    if kind == "auto":
        on_my_filed.append(f"{who}'s {refs} → {to} (auto-moved).")
    elif to in VERB:
        on_my_filed.append(f"{who} {VERB[to]} {refs}.")
    else:
        on_my_filed.append(f"{who} moved {refs} → {to}.")
on_my_filed += [m + "." for m in team_moves]

# --- highlights -----------------------------------------------------------------------
highlights = []
for i in milestones:
    head, _, tail = milestone_parts(i["title"])
    highlights.append(f"<b>{head}</b> ([[{i['id']}]])" + (f" — {tail}." if tail else " — done."))
for k in named:
    if len(highlights) >= 5:
        break
    c = Counter(status(p) for p in groups[k])
    bits = [f"{c['merged']} PR{'s' if c['merged'] != 1 else ''} merged"] if c["merged"] else []
    d = ws_done(k)
    if d:
        bits.append(f"{len(d)} ticket{'s' if len(d) != 1 else ''} → Done")
    open_n = c["approved"] + c["review"] + c["draft"]
    if open_n:
        bits.append(f"{open_n} open")
    if bits:
        highlights.append(f"<b>{meta[k]['name']}</b> — " + ", ".join(bits) + ".")
if len(highlights) < 5 and on_my_filed:
    highlights.append(f"<b>{FILED_LABEL}</b> — " + on_my_filed[0].rstrip("."))

# --- standups ------------------------------------------------------------------------
standups = []
if args.standup_log and Path(args.standup_log).exists():
    for line in Path(args.standup_log).read_text().splitlines():
        r = json.loads(line)
        d = date.fromisoformat(r["date"])
        if not START <= d <= END:
            continue
        ws = date.fromisoformat(r["window_start"]) if r.get("window_start") else None
        label = f"{fmt_day(ws)} – {fmt_day(d)}" if ws and ws < d else fmt_day(d)
        s = r.get("stats", {})
        prs, iss = s.get("prs", {}), s.get("issues", {})
        bits = []
        if prs.get("unique"):
            bits.append(f"{prs['unique']} PRs" + (f", {prs['merged']} merged" if prs.get("merged") else ""))
        if iss.get("unique"):
            bits.append(f"{iss['unique']} issues" + (f", {iss['done']} → Done" if iss.get("done") else ""))
        standups.append({"label": label, "url": r.get("permalink"), "summary": " · ".join(bits) or "Standup post"})

# --- next: open assigned work ------------------------------------------------------------
# Approved PRs already have their own card, so Next is open assigned work only.
nxt = []
data = linear_api(f'{{ issues(first: 100, filter: {{ assignee: {{ {LINEAR_WHO} }}, '
                  'state: { name: { eq: "In Progress" } } }) { nodes { identifier title priority } } }')
started = (data.get("issues") or {}).get("nodes", [])
started.sort(key=lambda n: (n["priority"] == 0, n["priority"], n["identifier"]))
nxt += [f"[[{n['identifier']}]] — {n['title']}" for n in started[:6]]

# --- write ---------------------------------------------------------------------------
title = cfg.get("title") or "Work report"
content = {k: cfg[k] for k in ("tz", "tz_label", "day_start_hour", "monday_start_sunday_hour", "author", "linear_workspace", "github_owner",
                                "standup_channel", "repo_aliases", "project_aliases", "filed_label") if k in cfg}
content |= {
    "title": title,
    "start": START.isoformat(),
    "end": END.isoformat(),
    "workstreams": [
        {"name": meta[k]["name"], "sub": meta[k]["sub"], "prs": [ref_of(p) for p in groups[k]], "summary": ws_summary(k)}
        for k in named
    ],
    "other": {
        "name": "Other",
        "sub": ", ".join(meta[k]["name"] for k in rest),
        "prs": [ref_of(p) for k in rest for p in groups[k]],
        "summary": " ".join(f"{meta[k]['name']}: {ws_summary(k)}" for k in rest),
    },
    "tiles": [{"label": cfg.get("milestone", {}).get("label", "Milestones done"), "value": len(milestones),
               "foot": " · ".join(milestone_parts(i["title"])[1] for i in milestones)}] if milestones else [],
    "highlights": highlights,
    "on_my_filed": on_my_filed,
    "standups": standups,
    "open_notes": {},
    "next": nxt,
}
Path(args.out).write_text(json.dumps(content, indent=2, ensure_ascii=False) + "\n")
print(f"wrote {args.out}: workstreams " + ", ".join(f"{meta[k]['name']} {len(groups[k])}" for k in named)
      + (f", Other {sum(len(groups[k]) for k in rest)}" if rest else ""))
