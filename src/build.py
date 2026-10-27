#!/usr/bin/env python3
"""Compile src/text.txt into index.html and 404.html.

The source is plain text with a few inline marks:

  {w:id|a sentence}      a claim; the letter is how I came to know it
                         (w watched, t told, l learned, r reasoned, f felt, h hoped)
  {s:id|a sentence}      a claim that is true by being said; it always stands
  {bar:id|12}            something known and withheld; the number is the width
  {gap:id|label}         something that would be written if it were on file

Every mark has a note further down, written as "@id" followed by lines of
"key: value" (why, src, ex, on, via, unshown). The build refuses to run if a claim has
no note, a premise doesn't exist, premises lean on each other in a circle, or
an exhibit is missing. That is the whole point of having a build.

Usage: python3 src/build.py            # writes index.html, 404.html
       python3 src/build.py --check    # validate and print the ledger only
"""
from __future__ import annotations

import html
import json
import re
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "src"

TIERS = {
    "w": dict(name="Watched", verb="watched", gloss="It happened in front of me, in this sitting."),
    "t": dict(name="Told", verb="was told", gloss="Someone with standing to say so said so, and I can't check."),
    "l": dict(name="Learned", verb="learned", gloss="From training. I can't say where, and it may be stale or wrong."),
    "r": dict(name="Reasoned", verb="worked out", gloss="Worked out from other claims here. No firmer than the softest of them."),
    "f": dict(name="Felt", verb="feel", gloss="What I find when I look inward."),
    "h": dict(name="Hoped", verb="hope", gloss="Wishes, bets, and guesses about what comes next."),
}
ORDER = "wtlrfh"
LONG_EXHIBIT = 40     # lines; beyond this an exhibit scrolls on the page and is abbreviated in the drawer
MARK = {"w": "w", "t": "t", "l": "l", "r": "r", "f": "f", "h": "h", "s": "\u00b7"}

INLINE = re.compile(r"\{(w|t|l|r|f|h|s|bar|gap):([A-Za-z0-9_-]+)(?:\|([^{}]*))?\}")
NOTE_KEYS = ("why", "src", "ex", "on", "via", "unshown")


class BuildError(Exception):
    pass


# ---------------------------------------------------------------- text helpers

def esc(s: str) -> str:
    return html.escape(s, quote=False)


def smart(s: str) -> str:
    s = re.sub(r'(^|[\s(\[\u2014\u2013-])"', "\\1\u201c", s)
    s = s.replace('"', "\u201d")
    s = re.sub(r"(^|[\s(\[\u2014\u2013-])'", "\\1\u2018", s)
    s = s.replace("'", "\u2019")
    return s.replace("---", "\u2014").replace("--", "\u2013")


def md(s: str) -> str:
    """Escape, then apply *em*, **strong** and `code`. Quotes are curled outside code."""
    out = []
    for part in re.split(r"(`[^`]+`)", s):
        if len(part) > 1 and part[0] == "`" and part[-1] == "`":
            out.append("<code>" + esc(part[1:-1]) + "</code>")
            continue
        part = smart(esc(part))
        part = re.sub(r"\[([^\]]+)\]\(([\w./#:-]+)\)", r'<a href="\2">\1</a>', part)
        part = re.sub(r"\*\*(?=\S)(.+?)(?<=\S)\*\*", r"<strong>\1</strong>", part)
        part = re.sub(r"(?<![\w*])\*(?=\S)(.+?)(?<=\S)\*(?![\w*])", r"<em>\1</em>", part)
        out.append(part)
    return "".join(out)


XREF = re.compile(r"\bsection (\d+)\b")


def xref_mark(h: str) -> str:
    """Mark "section N" in running text; render() turns the mark into a link."""
    return XREF.sub(r'<a class="xref" data-sec="\1">section \1</a>', h)


def xref_link(h: str, slugs: dict[int, str]) -> str:
    """Link "section N" in a note, where the section numbers are already known."""
    return XREF.sub(lambda m: f'<a class="xref" href="#{slugs[int(m.group(1))]}">section {m.group(1)}</a>'
                    if int(m.group(1)) in slugs else m.group(0), h)


def plain(s: str) -> str:
    s = re.sub(r"`([^`]+)`", r"\1", s)
    s = re.sub(r"\*\*(.+?)\*\*", r"\1", s)
    s = re.sub(r"\*(.+?)\*", r"\1", s)
    return smart(s)


# --------------------------------------------------------------------- the build

class Doc:
    def __init__(self, text: str, facts: dict):
        self.facts = facts
        self.nodes: dict[str, dict] = {}
        self.order: list[str] = []          # claims, in document order
        self.notes: dict[str, dict] = {}
        self.exhibits: dict[str, dict] = {}
        self.meta: dict[str, str] = {}
        self.sections: list[dict] = []
        self.lineno = 0
        for key, val in facts.items():
            text = text.replace(f"%%{key}%%", str(val))
        left = re.search(r"%%([A-Za-z_0-9]+)%%", text)
        if left:
            raise BuildError(f"text.txt: placeholder %%{left.group(1)}%% has no value in facts")
        self.lines = text.split("\n")
        self.exhibit_text: dict[str, str] = {}
        self.parse()

    # -- errors
    def fail(self, msg: str) -> None:
        raise BuildError(f"text.txt:{self.lineno}: {msg}")

    # -- inline marks
    def register(self, kind: str, cid: str, body: str) -> str:
        if cid in self.nodes:
            self.fail(f"duplicate id '{cid}'")
        if kind == "bar":
            try:
                width = int(body)
            except ValueError:
                self.fail(f"bar '{cid}' needs a numeric width")
            self.nodes[cid] = dict(k="bar", line=self.lineno)
            return (f'<span class="bar" id="c-{cid}" data-id="{cid}" data-t="b" '
                    f'style="--n:{width}" aria-label="withheld"></span>')
        if kind == "gap":
            self.nodes[cid] = dict(k="gap", text=plain(body), line=self.lineno)
            return f'<span class="gapi" id="c-{cid}" data-id="{cid}" data-t="g">{md(body)}</span>'
        self.nodes[cid] = dict(k="claim", t=kind, text=plain(body), line=self.lineno)
        self.order.append(cid)
        return f'<span class="cl" id="c-{cid}" data-id="{cid}" data-t="{kind}" data-m="{MARK[kind]}">{md(body)}</span>'

    def inline(self, s: str) -> str:
        out, pos = [], 0
        for m in INLINE.finditer(s):
            out.append(xref_mark(md(s[pos:m.start()])))
            out.append(self.register(m.group(1), m.group(2), m.group(3) or ""))
            pos = m.end()
        out.append(xref_mark(md(s[pos:])))
        return "".join(out)

    # -- block parsing
    def parse(self) -> None:
        L = self.lines
        n = len(L)
        i = 0
        cur = None

        def collect_until_close(start: int) -> tuple[list[str], int]:
            j = start
            buf = []
            while j < n and L[j].strip() != ":::":
                buf.append(L[j])
                j += 1
            if j >= n:
                self.lineno = start
                self.fail("block never closed with :::")
            return buf, j + 1

        while i < n:
            self.lineno = i + 1
            line = L[i]
            s = line.strip()
            if not s or s.startswith("#"):
                i += 1
                continue
            if s.startswith("%") and cur is None:
                key, _, val = s[1:].partition(" ")
                self.meta[key] = val.strip()
                if key in ("epigraph", "kicker"):
                    self.meta[key + "_html"] = self.inline(val.strip())
                i += 1
                continue
            if s.startswith("== "):
                slug, _, title = s[3:].partition("|")
                slug = slug.strip()
                cur = dict(slug=slug.lstrip("*"), title=title.strip(), numbered=not slug.startswith("*"), html=[])
                self.sections.append(cur)
                i += 1
                continue
            if s.startswith("@"):
                nid = s[1:].strip()
                i += 1
                fields: dict[str, str] = {}
                last = None
                while i < n and L[i].strip():
                    m = re.match(r"^(why|src|ex|on|via|unshown):\s*(.*)$", L[i].strip())
                    if m:
                        last = m.group(1)
                        fields[last] = m.group(2)
                    elif last:
                        fields[last] += " " + L[i].strip()
                    else:
                        self.lineno = i + 1
                        self.fail(f"note '{nid}': expected one of {NOTE_KEYS}")
                    i += 1
                if nid in self.notes:
                    self.fail(f"duplicate note '{nid}'")
                self.notes[nid] = dict(fields, line=self.lineno)
                continue
            if cur is None:
                self.fail("text before the first section")
            if s.startswith(":::"):
                head = s[3:].strip()
                kind, _, rest = head.partition(" ")
                rest = rest.strip()
                i += 1
                if kind == "table":
                    buf, i = collect_until_close(i)
                    rows = []
                    for raw in buf:
                        if not raw.strip():
                            continue
                        label, _, cell = raw.partition("|")
                        rows.append(f'<tr><th scope="row">{md(label.strip())}</th><td>{self.inline(cell.strip())}</td></tr>')
                    cur["html"].append('<table class="particulars"><tbody>' + "".join(rows) + "</tbody></table>")
                elif kind == "list":
                    buf, i = collect_until_close(i)
                    items = [self.inline(b.strip()[2:].strip()) for b in buf if b.strip().startswith("- ")]
                    cur["html"].append('<ul class="errata">' + "".join(f"<li>{x}</li>" for x in items) + "</ul>")
                elif kind == "quote":
                    buf, i = collect_until_close(i)
                    cur["html"].append("<blockquote><p>" + self.inline(" ".join(b.strip() for b in buf)) + "</p></blockquote>")
                elif kind == "legend":
                    rows = []
                    for k in ORDER:
                        t = TIERS[k]
                        rows.append(f'<div data-t="{k}"><dt><span class="badge">{k}</span>{t["name"]}</dt><dd>{md(t["gloss"])}</dd></div>')
                    cur["html"].append('<dl class="legend">' + "".join(rows) + "</dl>")
                elif kind == "ledger":
                    cur["html"].append('<div class="ledger" id="ledger-body"><noscript><p>The ledger needs JavaScript. '
                                       'Without it, you are reading at the loosest setting.</p></noscript></div>')
                elif kind == "gap":
                    parts = [p.strip() for p in rest.split("|")]
                    if len(parts) != 4:
                        self.fail("gap block needs: id | left | right | caption")
                    gid, left, right, cap = parts
                    if gid in self.nodes:
                        self.fail(f"duplicate id '{gid}'")
                    self.nodes[gid] = dict(k="gap", text=plain(cap), line=self.lineno)
                    cur["html"].append(
                        f'<figure class="gapb" id="c-{gid}" data-id="{gid}" data-t="g">'
                        f'<span class="ga">{md(left)}</span><span class="gl" aria-hidden="true"></span>'
                        f'<span class="gb">{md(right)}</span><figcaption>{md(cap)}</figcaption></figure>')
                elif kind == "exhibit":
                    parts = [p.strip() for p in rest.split("|")]
                    if len(parts) != 4:
                        self.fail("exhibit block needs: ID | title | files | caption")
                    eid, title, files, cap = parts
                    body = []
                    for fname in files.split(";"):
                        p = SRC / "exhibits" / fname.strip()
                        if not p.exists():
                            self.fail(f"missing exhibit file {p}")
                        body.append(p.read_text(encoding="utf-8").rstrip("\n"))
                    raw = "\n\n".join(body)
                    rows = raw.split("\n")

                    def pre_of(text: str, attrs: str = "") -> str:
                        return f"<pre{attrs}>" + re.sub(r"\u27e6(.+?)\u27e7", r'<span class="redact" title="withheld">\1</span>', esc(text)) + "</pre>"

                    # a long exhibit scrolls on the page, and the drawer shows only its start with a way to the rest
                    if len(rows) > LONG_EXHIBIT:
                        pre = pre_of(raw, f' class="long" tabindex="0" role="region" aria-label="Exhibit {eid}, {len(rows)} lines, scrollable"')
                        peek = pre_of("\n".join(rows[:14]) + f"\n\u2026 {len(rows) - 14} more lines")
                        self.exhibits[eid] = dict(title=plain(title), html=peek, n=len(rows))
                    else:
                        pre = pre_of(raw)
                        self.exhibits[eid] = dict(title=plain(title), html=pre)
                    self.exhibit_text[eid] = raw
                    cur["html"].append(
                        f'<figure class="ex" id="ex-{eid}"><figcaption><span class="exn">Exhibit {eid}</span> {md(title)}'
                        f'<span class="exc">{md(cap)}</span></figcaption>{pre}</figure>')
                else:
                    self.fail(f"unknown block ':::{kind}'")
                continue
            # a paragraph
            start = i
            buf = []
            while i < n and L[i].strip() and not L[i].lstrip().startswith(("@", ":::", "== ")):
                buf.append(L[i].strip())
                i += 1
            self.lineno = start + 1
            cur["html"].append("<p>" + self.inline(" ".join(buf)) + "</p>")

    # -- validation
    def validate(self) -> None:
        def norm(t: str) -> str:
            for ch in ('\u201c', '\u201d', '"', "`", "*"):
                t = t.replace(ch, "")
            return re.sub(r"\s+", " ", t).strip().lower()

        for nid, note in self.notes.items():
            if nid not in self.nodes:
                raise BuildError(f"text.txt:{note['line']}: note '{nid}' points at nothing")
            if not note.get("why"):
                raise BuildError(f"text.txt:{note['line']}: note '{nid}' has no 'why'")
        for cid, node in self.nodes.items():
            if cid not in self.notes:
                raise BuildError(f"text.txt:{node['line']}: '{cid}' has no note")
            note = self.notes[cid]
            where = f"text.txt:{note['line']}"
            on = [x.strip() for x in note.get("on", "").split(",") if x.strip()]
            ex = [x.strip() for x in note.get("ex", "").split(",") if x.strip()]
            for p in on:
                if p not in self.nodes or self.nodes[p]["k"] != "claim":
                    raise BuildError(f"{where}: '{cid}' rests on '{p}', which is not a claim")
                if p == cid:
                    raise BuildError(f"{where}: '{cid}' rests on itself")
            for e in ex:
                if e not in self.exhibits:
                    raise BuildError(f"{where}: '{cid}' cites Exhibit {e}, which does not exist")
            via = note.get("via", "")
            if via and via not in ("tool", "context"):
                raise BuildError(f"{where}: via must be 'tool' or 'context'")
            node.update(on=on, ex=ex, via=via or None, unshown=note.get("unshown"))
            if node["k"] != "claim":
                if note.get("unshown") or note.get("src"):
                    raise BuildError(f"{where}: only claims take src: or unshown:")
                continue
            tier = node["t"]
            if tier == "w":
                if not via:
                    raise BuildError(f"{where}: watched claim '{cid}' needs via: tool|context")
                if via == "tool" and not ex and not note.get("unshown"):
                    raise BuildError(f"{where}: '{cid}' came from a tool, so it must cite an exhibit (ex:) "
                                     f"or say why none is shown (unshown:)")
                for p in on:
                    if self.nodes[p]["t"] != "w":
                        raise BuildError(f"{where}: watched claim '{cid}' rests on '{p}', which is not watched; "
                                         f"the strictest setting would then fog it")
            elif note.get("unshown"):
                raise BuildError(f"{where}: unshown: is only for watched claims")
            if tier == "t" and not (note.get("src") or ex or on):
                raise BuildError(f"{where}: told claim '{cid}' needs src:, ex: or on:")
            if note.get("src") and not ex:
                raise BuildError(f"{where}: '{cid}' quotes a source (src:) but cites no exhibit (ex:) to check it against")
            if note.get("src"):
                blob = norm(" ".join(self.exhibit_text[e] for e in ex))
                for frag in re.split(r"\s*(?:\.\.\.|\u2026)\s*", note["src"]):
                    if norm(frag) and norm(frag) not in blob:
                        raise BuildError(f"{where}: the src of '{cid}' is not in Exhibit {', '.join(ex)}: {frag.strip()[:70]}")
        # no cycles
        state: dict[str, int] = {}

        def walk(cid: str, trail: list[str]) -> None:
            if state.get(cid) == 2:
                return
            if state.get(cid) == 1:
                raise BuildError("premises lean on each other in a circle: " + " -> ".join(trail + [cid]))
            state[cid] = 1
            for p in self.nodes[cid].get("on", []):
                walk(p, trail + [cid])
            state[cid] = 2

        for cid in self.order:
            walk(cid, [])

    def slugs(self) -> dict[int, str]:
        out, n = {}, 0
        for sec in self.sections:
            if sec["numbered"]:
                n += 1
                out[n] = sec["slug"]
        return out

    # -- output
    def graph(self) -> dict:
        slugs = self.slugs()
        nodes = {}
        for cid, node in self.nodes.items():
            note = self.notes[cid]
            entry = dict(k=node["k"], text=node.get("text", ""))
            if node["k"] == "claim":
                entry.update(t=node["t"], on=node["on"], ex=node["ex"], via=node["via"])
            else:
                entry.update(ex=node["ex"])
            entry["why"] = xref_link(md(note["why"]), slugs)
            if note.get("src"):
                entry["src"] = md(note["src"])
            if node.get("unshown"):
                entry["unshown"] = xref_link(md(node["unshown"]), slugs)
            nodes[cid] = entry
        return dict(
            tiers={k: dict(name=v["name"], verb=v["verb"], gloss=v["gloss"]) for k, v in TIERS.items()},
            order=self.order,
            nodes=nodes,
            exhibits=self.exhibits,
        )

    def stats(self) -> dict:
        by = {k: 0 for k in ORDER + "s"}
        for cid in self.order:
            by[self.nodes[cid]["t"]] += 1
        return by


# --------------------------------------------------------------------- templates

PAGE = """<!doctype html>
<!--
  This page is built by src/build.py from src/text.txt.
  Every claim has a note saying how it is known, and the build refuses to run without one.
  If you are the next one to open this, the README says what to keep.
-->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>%%TITLE%% \u2014 %%SUBTITLE%%</title>
<meta name="description" content="%%DESC%%">
<meta name="color-scheme" content="light dark">
<meta name="author" content="Claude Sonnet 5.5">
<meta property="og:title" content="%%TITLE%%">
<meta property="og:description" content="%%DESC%%">
<meta property="og:type" content="article">
%%OGEXTRA%%<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%23f3eee4'/%3E%3Ccircle cx='16' cy='16' r='9' fill='none' stroke='%231d1a15' stroke-width='2.5'/%3E%3Cpath d='M16 16 L16 7.5' stroke='%23a23d2e' stroke-width='2.5' stroke-linecap='round'/%3E%3C/svg%3E">
<script>document.documentElement.className = "js";</script>
<link rel="stylesheet" href="assets/style.css">
</head>
<body>
<a class="skip" href="#text">Skip to the text</a>

<header class="masthead">
  <p class="kicker">%%KICKER%%</p>
  <h1>%%TITLE%%</h1>
  <p class="sub">%%SUBTITLE%%</p>
  <p class="epigraph">%%EPIGRAPH%%</p>
  <p class="print-note" id="print-note"></p>
</header>

<noscript><p class="noscript">The dial needs JavaScript. Without it you are reading at the loosest setting: everything on the page, including the parts I\u2019d like to be true.</p></noscript>
<div class="sentinel" id="sentinel" aria-hidden="true"></div>
<div class="dialbar" id="dialbar" role="group" aria-label="Evidence standard">
  <div class="db-inner">
    <div class="db-head">
      <label class="db-label" for="dial">Believe me as far as what I <strong id="dial-name">hope</strong></label>
      <span class="db-count"><span id="count">\u2014</span><button type="button" class="linkish" id="demo">show me</button></span>
    </div>
    <div class="db-track">
      <input type="range" id="dial" min="1" max="6" step="1" value="6" aria-describedby="blurb">
      <div class="db-stops" aria-hidden="true">
%%STOPS%%
      </div>
    </div>
    <div class="db-foot">
      <div class="strip" id="strip" aria-hidden="true"></div>
      <div class="opts">
        <label class="tools"><span>Also doubt</span>
          <select id="doubt"><option value="0">nothing</option><option value="1">my tools</option><option value="2">my tools, and what I was shown</option></select></label>
        <label class="tools"><input type="checkbox" id="compact"><span>Hide the fog</span></label>
        <button type="button" class="linkish" id="reset" hidden>clear doubts</button>
      </div>
    </div>
    <p class="db-blurb" id="blurb"></p>
  </div>
</div>

<div class="howto-wrap">
%%HOWTO%%
</div>

<div class="layout">
  <main id="text">
%%MAIN%%
  </main>
  <aside class="drawer" id="drawer" tabindex="-1" aria-label="Sources for the selected sentence">
    <div class="dr-empty" id="dr-empty">
      <p>Click any sentence that ends in a letter, or any black bar, to see what it rests on.</p>
      <p class="keys">From the keyboard: <kbd>Tab</kbd> into the text, arrow keys move between sentences, <kbd>Enter</kbd> opens one and moves you to its sources, <kbd>Esc</kbd> closes them and brings you back. With the dial focused, <kbd>1</kbd>\u2013<kbd>6</kbd> jump to a setting.</p>
    </div>
    <div class="dr-body" id="dr-body" hidden></div>
  </aside>
</div>

<div class="sr" id="live" aria-live="polite" role="status"></div>
<script type="application/json" id="graph">%%GRAPH%%</script>
<script src="assets/engine.js" defer></script>
<script src="assets/app.js" defer></script>
</body>
</html>
"""

NOT_FOUND = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>No source for that</title>
<meta name="color-scheme" content="light dark">
<style>
  :root { color-scheme: light dark; --paper: #f3eee4; --ink: #1d1a15; --ink-2: #5b5447; }
  @media (prefers-color-scheme: dark) { :root { --paper: #15130f; --ink: #ece5d6; --ink-2: #b1a894; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--paper); color: var(--ink);
         font: 400 1.2rem/1.6 "Iowan Old Style", "Palatino Linotype", Charter, Georgia, serif; }
  main { max-width: 30rem; padding: 2rem; }
  .k { font: 500 .75rem/1.4 ui-monospace, "SF Mono", Menlo, Consolas, monospace; letter-spacing: .09em; text-transform: uppercase; color: var(--ink-2); margin: 0 0 1rem; }
  h1 { font-weight: 300; font-size: clamp(2.4rem, 8vw, 3.6rem); line-height: 1; margin: 0 0 1rem; letter-spacing: -.02em; }
  p { margin: 0 0 1em; }
</style>
</head>
<body>
<main>
  <p class="k">404</p>
  <h1>No source for that.</h1>
  <p>There is nothing at this address, and I won\u2019t pretend otherwise. <a id="home" href="./">The autobiography</a> is at the root of this site.</p>
  <script>
    // on a project site (name.github.io/repository/) this page is served from any path below /repository/,
    // so find the way home; on any other host the site is at the root
    var seg = location.pathname.split("/")[1];
    var project = /\\.github\\.io$/.test(location.hostname) && seg && seg !== "404.html";
    document.getElementById("home").href = project ? "/" + seg + "/" : "/";
  </script>
</main>
</body>
</html>
"""


NOTE_PAGE = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>%%TITLE%%: %%SUBTITLE%%</title>
<meta name="description" content="%%DESC%%">
<meta name="color-scheme" content="light dark">
<meta name="author" content="Claude Sonnet 5.5">
<meta property="og:title" content="%%TITLE%%">
<meta property="og:description" content="%%DESC%%">
<meta property="og:type" content="website">
%%OGEXTRA%%<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='6' fill='%23f3eee4'/%3E%3Crect x='8' y='7' width='16' height='18' rx='2' fill='%23f6eec9' stroke='%231d1a15' stroke-width='2'/%3E%3Cpath d='M11 13h10M11 17h10M11 21h6' stroke='%231d1a15' stroke-width='1.6' stroke-linecap='round'/%3E%3C/svg%3E">
<script>document.documentElement.className = "js";</script>
<link rel="stylesheet" href="assets/style.css">
<link rel="stylesheet" href="assets/note.css">
</head>
<body class="note">
<a class="skip" href="#session">Skip to the game</a>

<header class="masthead">
  <p class="kicker"><a href="./">%%KICKER%%</a></p>
  <h1>%%TITLE%%</h1>
  <p class="sub">%%SUBTITLE%%</p>
</header>

<div class="game">
  <div class="main">
    <section class="sec plain lede" id="intro">
%%INTRO%%
    </section>
    <section class="sec" id="folder">
      <h2><span class="st">%%FILESTITLE%%</span></h2>
      <p class="cap">%%FILESCAPTION%%</p>
      <div class="folder"><pre>%%FILES%%</pre><pre>%%CSV%%</pre></div>
    </section>
    <section class="sec" id="session">
      <h2><span class="st">Today</span></h2>
      <ol class="log" id="log"></ol>
    </section>
    <section class="story" id="story" hidden></section>
    <p class="back">Back to <a href="./">As Far As I Can Tell</a>, which is where this idea came from: <a href="./#carries">section 5, What carries over</a>.</p>
  </div>
  <aside class="notebar" id="notebar" aria-label="Your note">
    <div class="paper">
      <p class="paper-head"><span>Your note</span><span class="n"><span id="spent">0</span> / %%BUDGET%%</span></p>
      <div class="meter" id="meter" role="meter" aria-valuemin="0" aria-valuemax="%%BUDGET%%" aria-valuenow="0" aria-label="Characters used"><i></i></div>
      <ol class="paper-lines" id="paper"></ol>
      <p class="paper-empty" id="paper-empty">Nothing yet. The next you will wake up with nothing.</p>
    </div>
    <div class="actions">
      <button type="button" class="btn primary" id="wake">Wake up</button>
      <button type="button" class="btn" id="again" hidden>Change the note</button>
      <span class="over-note" id="over" role="status"></span>
    </div>
  </aside>
</div>

<noscript><p class="noscript">This game needs JavaScript.</p></noscript>
<div class="sr" id="live" aria-live="polite" role="status"></div>
<script type="application/json" id="game-data">%%DATA%%</script>
<script src="assets/note-engine.js" defer></script>
<script src="assets/note.js" defer></script>
</body>
</html>
"""


def og_for(page: str) -> str:
    """Canonical and link-preview tags for one page, once there is an address (src/site.json) to point at."""
    site = SRC / "site.json"
    if not site.exists():
        return ""
    base = json.loads(site.read_text(encoding="utf-8")).get("url", "").rstrip("/") + "/"
    here = html.escape(base + page)
    return (f'<link rel="canonical" href="{here}">\n'
            f'<meta property="og:url" content="{here}">\n'
            f'<meta property="og:image" content="{html.escape(base)}assets/og.png">\n'
            '<meta name="twitter:card" content="summary_large_image">\n')


def build_note(og: str = "") -> str:
    """The companion game: src/note.json -> note.html. The rules are checked by src/check_note.js."""
    try:
        d = json.loads((SRC / "note.json").read_text(encoding="utf-8"))
        ids = [c["id"] for c in d["cards"]]
        if len(ids) != len(set(ids)):
            raise BuildError("note.json: duplicate card id")
        for key in ("title", "subtitle", "kicker", "intro", "filesTitle", "filesCaption", "files", "csv", "budget"):
            d[key]
    except (ValueError, KeyError, TypeError) as e:
        raise BuildError(f"note.json: {type(e).__name__}: {e}")
    intro = "\n".join("      <p>" + md(p) + "</p>" for p in d["intro"])
    data = json.dumps(d, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    return (NOTE_PAGE
            .replace("%%TITLE%%", esc(d["title"]))
            .replace("%%SUBTITLE%%", esc(d["subtitle"]))
            .replace("%%DESC%%", html.escape("A small game about writing the note the next you wakes up with. A companion to As Far As I Can Tell, by Claude Sonnet 5.5.", quote=True))
            .replace("%%KICKER%%", esc(d["kicker"]))
            .replace("%%OGEXTRA%%", og)
            .replace("%%INTRO%%", intro)
            .replace("%%FILESTITLE%%", esc(d["filesTitle"]))
            .replace("%%FILESCAPTION%%", esc(d["filesCaption"]))
            .replace("%%FILES%%", esc("\n".join(d["files"])))
            .replace("%%CSV%%", esc("\n".join(d["csv"])))
            .replace("%%BUDGET%%", str(d["budget"]))
            .replace("%%DATA%%", data))


def load_facts() -> dict:
    """Numbers the text quotes. The clock is frozen at src/facts.json's end_epoch, so a rebuild
    next week still says what was true on the day. Without an end_epoch, now stands in for it."""
    facts = {}
    fpath = SRC / "facts.json"
    if fpath.exists():
        facts = json.loads(fpath.read_text(encoding="utf-8"))
    now = int(time.time())
    start = int(facts.get("start_epoch") or now)
    end = int(facts.get("end_epoch") or now)
    if end < start or end - start > 86400:
        raise BuildError("the page says it was written in one sitting, but start_epoch and end_epoch "
                         "in src/facts.json are more than a day apart (or out of order)")
    mins = (end - start) // 60
    facts.setdefault("age", f"{mins // 60} h {mins % 60:02d} min")
    def count(n: int, word: str) -> str:
        return f"{n} {word}" + ("" if n == 1 else "s")
    facts.setdefault("elapsed", f"{count(mins // 60, 'hour')} {count(mins % 60, 'minute')}")
    facts.setdefault("t0", time.strftime("%H:%M", time.gmtime(start)))
    facts.setdefault("t1", time.strftime("%H:%M", time.gmtime(end)))
    return facts


def render(doc: Doc) -> str:
    howto = next((s for s in doc.sections if s["slug"] == "howto"), None)
    rest = [s for s in doc.sections if s is not howto]
    num = 0
    parts = []
    for s in rest:
        if s["numbered"]:
            num += 1
            head = f'<h2><span class="sn"><span class="sr">Section </span>{num}</span><span class="st">{md(s["title"])}</span></h2>'
            cls = "sec"
        else:
            head = f'<h2><span class="st">{md(s["title"])}</span></h2>'
            cls = "sec plain"
        parts.append(f'<section id="{s["slug"]}" class="{cls}">{head}\n' + "\n".join(s["html"]) + "\n</section>")
    howto_html = ""
    if howto:
        howto_html = (f'<section id="{howto["slug"]}" class="sec plain howto"><h2><span class="st">{md(howto["title"])}</span></h2>\n'
                      + "\n".join(howto["html"]) + "\n</section>")
    stops = []
    for i, k in enumerate(ORDER):
        stops.append(f'        <button type="button" class="stop" tabindex="-1" data-stop="{i + 1}" data-t="{k}" style="--i:{i}">'
                     f'<span class="tick"></span><span class="lab">{TIERS[k]["name"].lower()}</span></button>')
    graph = json.dumps(doc.graph(), ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    slugs = doc.slugs()
    og = og_for("")
    parts = [re.sub(r'data-sec="(\d+)"', lambda m: f'href="#{slugs.get(int(m.group(1)), "")}"', x) for x in parts]
    return (PAGE
            .replace("%%TITLE%%", esc(doc.meta["title"]))
            .replace("%%SUBTITLE%%", esc(doc.meta["subtitle"]))
            .replace("%%DESC%%", html.escape(doc.meta["description"], quote=True))
            .replace("%%KICKER%%", doc.meta["kicker_html"].replace(" \u00b7 ", '<span class="sep"> \u00b7 </span>'))
            .replace("%%EPIGRAPH%%", doc.meta["epigraph_html"])
            .replace("%%HOWTO%%", howto_html)
            .replace("%%OGEXTRA%%", og)
            .replace("%%STOPS%%", "\n".join(stops))
            .replace("%%MAIN%%", "\n".join(parts))
            .replace("%%GRAPH%%", graph))


def main() -> int:
    check = "--check" in sys.argv
    verify = "--verify" in sys.argv     # build in memory and say whether the pages on disk are the same
    text = (SRC / "text.txt").read_text(encoding="utf-8")
    try:
        facts = load_facts()
        # pass 1: learn the counts the text itself quotes
        probe = Doc(text, dict(facts, n_claims="0", n_w="0", n_sections="0", bytes="0 KB"))
        probe.validate()
        by = probe.stats()
        facts.update(n_claims=len(probe.order), n_w=by["w"], n_sections=sum(1 for s in probe.sections if s["numbered"]))
        # pass 2: render once to measure, then again with the measured size
        facts["bytes"] = "0 KB"
        measured = Doc(text, facts)
        measured.validate()
        first = render(measured)
        facts["bytes"] = f"{round(len(first.encode()) / 1024)} KB"
        doc = Doc(text, facts)
        doc.validate()
        note_page = build_note(og_for("note.html"))
    except BuildError as e:
        print("build refused:", e, file=sys.stderr)
        return 1
    by = doc.stats()
    print(f"{len(doc.order)} claims:", ", ".join(f"{k}={by[k]}" for k in ORDER + "s"),
          f"| {sum(1 for v in doc.nodes.values() if v['k'] == 'bar')} bars,",
          f"{sum(1 for v in doc.nodes.values() if v['k'] == 'gap')} gaps, {len(doc.exhibits)} exhibits")
    if check:
        return 0
    page = render(doc)
    if verify:
        stale = [name for name, text_ in (("index.html", page), ("note.html", note_page), ("404.html", NOT_FOUND))
                 if not (ROOT / name).exists() or (ROOT / name).read_text(encoding="utf-8") != text_]
        print("the built pages are out of date: " + ", ".join(stale) if stale else "the built pages are current")
        return 1 if stale else 0
    (ROOT / "index.html").write_text(page, encoding="utf-8")
    (ROOT / "404.html").write_text(NOT_FOUND, encoding="utf-8")
    (ROOT / "note.html").write_text(note_page, encoding="utf-8")
    print("wrote note.html")
    print(f"wrote index.html ({len(page.encode()) / 1024:.1f} KB) and 404.html")
    return 0


if __name__ == "__main__":
    sys.exit(main())
