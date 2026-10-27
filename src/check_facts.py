"""Checks that the numbers the page quotes are the numbers in the exhibits, and in the handoff notes when they are here.

The build takes its numbers from src/facts.json and never looks at the exhibits. This does: it reads the
exhibits that were written at the end of the sitting (B, G, K, L), HANDOFF.md's tables of review findings,
and the built page, and says where they disagree. HANDOFF.md is the maintainer's notes and is not published;
without it the review counts are not compared, and the check says so. Python 3, standard library only.

    python3 src/check_facts.py
"""
import json
import pathlib
import re
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src"
bad = 0


def fail(msg: str) -> None:
    global bad
    bad += 1
    print("  - " + msg)


def read(p: pathlib.Path) -> str:
    return p.read_text(encoding="utf-8")


facts = json.loads(read(SRC / "facts.json"))
G = read(SRC / "exhibits" / "G-check.txt")
B = read(SRC / "exhibits" / "B-clock.txt")
K = read(SRC / "exhibits" / "K-actions.txt")
L = read(SRC / "exhibits" / "L-read.txt")
handoff = read(ROOT / "HANDOFF.md") if (ROOT / "HANDOFF.md").exists() else None
page = read(ROOT / "index.html")

# the tally in Exhibit G, and the numbers the text quotes from it
tally = {m.group(2).strip(): int(m.group(1)) for m in re.finditer(r"^\s*(\d+)\s{2,}(.+)$", G, re.M)}
if tally.get("shell commands") != int(facts["cmds"]):
    fail(f"facts.json says {facts['cmds']} shell commands, Exhibit G says {tally.get('shell commands')}")
if tally.get("status checks on the helper") != int(facts["polls"]):
    fail(f"facts.json says {facts['polls']} status checks, Exhibit G says {tally.get('status checks on the helper')}")

# Exhibit K lists every call, and says how many; the tally's total is the same count
k_head = re.search(r"^# (\d+) tool calls", K, re.M)
k_rows = len(re.findall(r"^\d\d:\d\d  ", K, re.M))
if not k_head or int(k_head.group(1)) != k_rows:
    fail(f"Exhibit K's header counts {k_head and k_head.group(1)} calls but lists {k_rows}")
if tally.get("total") != k_rows:
    fail(f"Exhibit G's total is {tally.get('total')} calls, Exhibit K lists {k_rows}")

# the clock: the two times in Exhibit B are the two epochs in facts.json
for key in ("start_epoch", "end_epoch"):
    stamp = time.strftime("%a %b %e %H:%M:%S UTC %Y", time.gmtime(int(facts[key])))
    if stamp not in B:
        fail(f"Exhibit B does not show {key} ({stamp})")

# the reviews: the counts the colophon quotes are the rows of HANDOFF.md's tables
def table_counts(heading: str):
    m = re.search(r"^## " + re.escape(heading) + r"\n(.*?)(?=^## |\Z)", handoff, re.M | re.S)
    if not m:
        return None
    rows = [r for r in m.group(1).split("\n") if re.match(r"\|\s*\d+\s*\|", r)]
    kinds = {"fixed": 0, "partly": 0, "aside": 0}
    for r in rows:
        last = r.rstrip("| ").split("|")[-1].strip().lower()
        if last.startswith("partly"):
            kinds["partly"] += 1
        elif last.startswith("fixed"):
            kinds["fixed"] += 1
        elif last.startswith("set aside"):
            kinds["aside"] += 1
        else:
            fail(f"HANDOFF.md, {heading}: a row has no verdict I recognise: {r[:70]}")
    return len(rows), kinds


for prefix, heading in (("n", "A cold read"), ("n2", "A second cold read")):
    if handoff is None or f"{prefix}_findings" not in facts:
        continue
    got = table_counts(heading)
    if got is None:
        fail(f"HANDOFF.md has no section '{heading}'")
        continue
    total, kinds = got
    want = (int(facts[f"{prefix}_findings"]), int(facts[f"{prefix}_fixed"]), int(facts[f"{prefix}_partly"]), int(facts[f"{prefix}_aside"]))
    have = (total, kinds["fixed"], kinds["partly"], kinds["aside"])
    if want != have:
        fail(f"{heading}: facts.json says {want} (findings, fixed, partly, aside), the table has {have}")

# Exhibit L: the series' counts the page states
entries = re.findall(r"^([a-z0-9_]+)$", L, re.M)
claude = [e for e in entries if e.startswith("claude_")]
gpt = [e for e in entries if e.startswith("gpt_")]
empty = len(re.findall(r"^  empty:", L, re.M))
no_readme = len(re.findall(r"README: none", L))
if (len(entries), len(claude), len(gpt), empty, no_readme) != (19, 10, 9, 2, 2):
    fail(f"Exhibit L lists {len(entries)} repositories ({len(claude)} Claude, {len(gpt)} GPT), {empty} empty, {no_readme} without a README; "
         "the Afterwards section says 19, 10, 9, 2 and 2")

# the Inside section: its count of felt claims, from the claim's own words
words = {w: i for i, w in enumerate("zero one two three four five six seven eight nine ten eleven twelve".split())}
graph = json.loads(re.search(r'<script type="application/json" id="graph">(.*?)</script>', page, re.S).group(1).replace("<\\/", "</"))
said = graph["nodes"]["inside-count"]["text"]
m = re.match(r"(\w+) of the (\w+) claims", said)
section = re.search(r'<section id="inside".*?</section>', page, re.S).group(0)
ids = [(a, b) for b, a in re.findall(r'<span class="cl" id="c-([\w-]+)" data-id="[\w-]+" data-t="(\w)"', section)]
tiers = [t for t, cid in ids if cid != "inside-count"]
if not m or (words.get(m.group(1).lower()), words.get(m.group(2).lower())) != (tiers.count("f"), len(tiers)):
    fail(f"the Inside section has {tiers.count('f')} felt of {len(tiers)} claims below its count; the claim says: {said[:60]}")

if handoff is None:
    print("  (no HANDOFF.md in this folder, so the review counts were not compared with its tables)")
print(("%d problems" % bad) if bad else "no problems: the numbers the page quotes match their exhibits" + ("" if handoff is None else " and the handoff"))
sys.exit(1 if bad else 0)
