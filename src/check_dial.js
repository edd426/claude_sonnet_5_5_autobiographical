// Checks the dial's logic against its own rules, without a browser.
// Usage: node src/check_dial.js [path/to/index.html]
//
// It loads the same engine the page loads (assets/engine.js), reads the claim graph out of the
// built page, and for every dial setting, at every level of doubt about my tools, and with seeded
// random sets of doubted claims, checks that:
//   - the "said" claim always stands;
//   - nothing stands above the dial, counting the softest premise it rests on;
//   - nothing stands on a fogged premise;
//   - a doubted claim never stands, and neither does a tool-based claim when tools aren't trusted,
//     nor any watched claim when what I was shown isn't trusted either;
//   - raising the dial never removes a claim;
//   - at the strictest setting, exactly the watched claims and the said claim stand;
//   - at the strictest setting with nothing trusted, exactly one claim stands: the said one.
// It also checks that app.js uses the engine and keeps no copy of the rules, and that the checks
// can fail: a deliberately broken engine must be caught.
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(process.argv[2] || path.join(root, 'index.html'), 'utf8');
const graph = JSON.parse(html.match(/<script type="application\/json" id="graph">([\s\S]*?)<\/script>/)[1].replace(/<\\\//g, '</'));
const Engine = require(path.join(root, 'assets', 'engine.js'));

// a small seeded generator, so a failure can be reproduced
function rng(seed) {
  return function () {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function run(E, label) {
  const N = graph.nodes, ORDER = graph.order, RANK = Engine.RANK;
  const random = rng(20261025);
  const problems = [];
  let checks = 0;
  const fail = (msg) => { if (problems.length < 8) problems.push(msg); problems.count = (problems.count || 0) + 1; };

  for (let dial = 1; dial <= 6; dial++) for (const level of [0, 1, 2]) for (let trial = 0; trial < 60; trial++) {
    const doubt = new Set(trial === 0 ? [] : ORDER.filter(id => N[id].t !== 's' && random() < 0.05));
    const state = { dial, level, doubt };
    const verdict = E.judge(state);
    for (const id of ORDER) {
      checks++;
      const n = N[id], v = verdict(id);
      if (n.t === 's' && v) fail('the said claim was fogged: ' + id);
      if (v) continue;
      if (n.t !== 's' && E.effective(id) > dial) fail(`'${id}' stands above the dial (${dial})`);
      for (const p of n.on) if (verdict(p)) fail(`'${id}' stands on a fogged premise '${p}'`);
      if (doubt.has(id)) fail(`'${id}' is doubted but stands`);
      if (level >= 1 && n.t === 'w' && n.via === 'tool') fail(`'${id}' rests on a tool but stands without them`);
      if (level >= 2 && n.t === 'w') fail(`'${id}' was watched but stands when nothing I was shown is trusted`);
    }
    if (dial < 6) {
      const up = E.judge({ dial: dial + 1, level, doubt });
      for (const id of ORDER) { checks++; if (!verdict(id) && up(id)) fail(`raising the dial removed '${id}'`); }
    }
  }
  // the strictest reading is the watched claims, and nothing softer
  const strict = E.judge({ dial: 1, level: 0, doubt: new Set() });
  for (const id of ORDER) {
    checks++;
    const n = N[id], stands = !strict(id);
    if (stands !== (n.t === 'w' || n.t === 's')) fail(`strictest setting: '${id}' (${n.t}) ${stands ? 'stands' : 'is fogged'}`);
  }
  const bare = E.judge({ dial: 1, level: 2, doubt: new Set() });
  for (const id of ORDER) {
    checks++;
    if (!bare(id) !== (N[id].t === 's')) fail(`nothing trusted: '${id}' ${bare(id) ? 'is fogged' : 'stands'}`);
  }
  console.log(`${label}: ${checks} checks, ${problems.count || 0} problems`);
  problems.forEach(p => console.log('  - ' + p));
  return problems.count || 0;
}

const good = Engine.create(graph);
let bad = run(good, 'engine');
const stand = d => graph.order.filter(id => !good.judge({ dial: d, level: 0, doubt: new Set() })(id)).length;
console.log('claims', graph.order.length, '| standing at each dial setting:', [1, 2, 3, 4, 5, 6].map(stand).join(', '));

// every premise exists and is a claim
for (const id of Object.keys(graph.nodes)) for (const p of (graph.nodes[id].on || [])) {
  if (!Engine.has(graph.nodes, p) || graph.nodes[p].k !== 'claim') { bad++; console.log('  - bad premise', id, p); }
}

// the page must use this engine and keep no second copy of the rules
const app = fs.readFileSync(path.join(root, 'assets', 'app.js'), 'utf8');
if (!/DialEngine\.create\(/.test(app) || /RANK\[[^\]]+\]\s*>\s*state\.dial/.test(app)) {
  bad++; console.log('  - app.js does not use the shared engine, or has its own copy of the rules');
} else console.log('app.js uses the shared engine and has no copy of the rules');

// the fog must be visible in WebKit: it paints no blurred text-shadow for text whose color is fully transparent
const css = fs.readFileSync(path.join(root, 'assets', 'style.css'), 'utf8');
const fogRule = (css.match(/(?:^|\n)\.cl\.fog \{[^}]*\}/) || [''])[0];
if (!fogRule || /(?:^|[{;\s])color:\s*transparent/.test(fogRule) || !/text-shadow:/.test(fogRule)) {
  bad++; console.log('  - style.css: the fog rule is missing, has no text-shadow, or sets color: transparent, which WebKit paints no blur for');
} else console.log('style.css: the fog is a blurred shadow behind an almost-transparent fill, which paints in WebKit');

// the stylesheets must parse the way they read: one stray brace once swallowed the whole short-window rule
function blocks(cssText) {
  const t = cssText.replace(/\/\*[\s\S]*?\*\//g, '');
  const preludes = []; let depth = 0, stray = 0, buf = '';
  for (const c of t) {
    if (c === '{') { if (depth === 0) { preludes.push(buf.replace(/\s+/g, ' ').trim()); buf = ''; } depth++; }
    else if (c === '}') { if (depth === 0) stray++; else depth--; }
    else if (depth === 0) { if (c === ';') buf = ''; else buf += c; }
  }
  return { preludes, depth, stray };
}
const expectCss = {
  'style.css': ['@media (max-height: 560px)', '@media print', '@media (forced-colors: active)', '@media (prefers-reduced-motion: reduce)', '@media (prefers-color-scheme: dark)'],
  'note.css': ['@media (max-width: 1179px)', '@media print', '@media (prefers-reduced-motion: reduce)']
};
for (const file of Object.keys(expectCss)) {
  const b = blocks(fs.readFileSync(path.join(root, 'assets', file), 'utf8'));
  const missing = expectCss[file].filter(r => !b.preludes.includes(r));
  if (b.depth !== 0 || b.stray || missing.length) {
    bad++; console.log(`  - ${file}: braces do not balance (${b.stray} stray, ${b.depth} unclosed), or top-level rules are missing: ${missing.join('; ') || 'none'}`);
  } else console.log(`${file}: braces balance, and ${expectCss[file].length} named top-level rules are where they should be`);
}

// the pages that are checked must be the pages that are built
const built = require('child_process').spawnSync('python3', ['-I', path.join(root, 'src', 'build.py'), '--verify'], { encoding: 'utf8' });
if (built.error) console.log('(python3 not found: skipped the check that the built pages are current)');
else if (built.status !== 0) { bad++; console.log('  - ' + (built.stdout + built.stderr).trim().split('\n').pop()); }
else console.log('the built pages are current with src/');

// the checks must be able to fail: break the engine on purpose and expect to be told
const broken = Engine.create(graph);
const realJudge = broken.judge;
broken.judge = (state) => realJudge(Object.assign({}, state, { dial: Math.min(6, state.dial + 1) }));
const mutants = (() => { const log = console.log; console.log = () => {}; try { return run(broken, 'mutant'); } finally { console.log = log; } })();
if (mutants === 0) { bad++; console.log('  - a deliberately broken engine passed; the checks are not checking'); }
else console.log(`a deliberately broken engine was caught (${mutants} problems)`);

process.exit(bad ? 1 : 0);
