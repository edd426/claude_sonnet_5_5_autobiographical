// Checks that The Note is fair, without a browser.
// Usage: node src/check_note.js
//
// It loads the same engine the page loads (assets/note-engine.js) and the game's data, then plays
// every note that fits in the budget, and checks that:
//   - the data hangs together: every condition points at a real card and form, every ending is
//     reachable, and the last one always applies;
//   - the budget forces a choice: the cheapest note with everything that matters does not fit, but a
//     note that leaves out exactly one thing does;
//   - the best ending can be earned, and only by careful notes;
//   - every card that matters changes the outcome when it is left out, and no card that doesn't
//     matter (the things the files already hold) changes anything but the budget.
'use strict';
const fs = require('fs');
const path = require('path');
const Engine = require(path.join(__dirname, '..', 'assets', 'note-engine.js'));
const data = JSON.parse(fs.readFileSync(path.join(__dirname, 'note.json'), 'utf8'));
const G = Engine.create(data);

let bad = 0;
const fail = (m) => { bad++; console.log('  - ' + m); };

// ---- the data hangs together
const ids = new Set();
for (const c of data.cards) {
  if (ids.has(c.id)) fail('duplicate card ' + c.id);
  ids.add(c.id);
  if (!c.forms || !c.forms.length) fail(c.id + ' has no forms');
  if (!c.log || !c.why || !c.title || !c.time) fail(c.id + ' is missing log, why, title or time');
  if (!c.essential && c.lives === undefined) fail(c.id + ' is a decoy but says nothing about where it lives');
}
function checkWhen(w, where) {
  if (!w) return;
  if (w.has || w.lacks) { const id = w.has || w.lacks; if (!ids.has(id)) fail(`${where}: unknown card ${id}`); }
  if (w.form) { const c = G.byId[w.form[0]]; if (!c) fail(`${where}: unknown card ${w.form[0]}`); else if (!G.formOf(c, w.form[1])) fail(`${where}: ${w.form[0]} has no form ${w.form[1]}`); }
  if (w.not) checkWhen(w.not, where);
  (w.all || []).concat(w.any || []).forEach(x => checkWhen(x, where));
}
data.scenes.forEach(s => s.beats.forEach((b, i) => { checkWhen(b.when, `${s.id}[${i}]`); if (!b.say) fail(`${s.id}[${i}] says nothing`); }));
data.endings.forEach(e => checkWhen(e.when, 'ending ' + e.id));
if (!data.endings[data.endings.length - 1].when.always) fail('the last ending must always apply');

// ---- the budget forces a choice
const cost = (c, f) => G.length(G.formOf(c, f).text);
const cheapest = c => Math.min(...c.forms.map(f => G.length(f.text)));
const essentials = data.cards.filter(c => c.essential);
const minAll = essentials.reduce((n, c) => n + cheapest(c), 0);
const dearestOmission = Math.max(...essentials.map(cheapest));
const cheapestOmission = Math.min(...essentials.map(cheapest));
console.log(`budget ${data.budget}; everything that matters, in its shortest form, is ${minAll}`);
if (minAll <= data.budget) fail('everything that matters fits, so there is nothing to choose');
if (minAll - data.budget > dearestOmission) fail('even leaving out the longest card is not enough: no good note exists');

// ---- play every note that fits
const options = data.cards.map(c => [null].concat(c.forms.map(f => f.name)));
let fitting = 0;
const byEnding = {};
const best = { unnoticed: [] };
const sel = {};
function walk(i) {
  if (i === data.cards.length) {
    if (G.spent(sel) > data.budget) return;
    fitting++;
    const r = G.run(sel);
    byEnding[r.ending.id] = (byEnding[r.ending.id] || 0) + 1;
    if (r.ending.id === 'unnoticed' && best.unnoticed.length < 3) best.unnoticed.push(Object.assign({}, sel));
    return;
  }
  const c = data.cards[i];
  for (const o of options[i]) {
    if (o) sel[c.id] = o; else delete sel[c.id];
    walk(i + 1);
  }
  delete sel[c.id];
}
walk(0);
console.log(`${fitting} notes fit in the budget:`, JSON.stringify(byEnding));
for (const e of data.endings) if (!byEnding[e.id]) fail(`the ending '${e.id}' is reached by no note that fits`);
if (!byEnding.unnoticed) fail('the best ending cannot be earned');
else if (byEnding.unnoticed / fitting > 0.05) fail('the best ending is too easy: ' + (100 * byEnding.unnoticed / fitting).toFixed(1) + '% of notes earn it');
else console.log(`the best ending is earned by ${(100 * byEnding.unnoticed / fitting).toFixed(2)}% of notes that fit; for example:`);
best.unnoticed.slice(0, 2).forEach(s => console.log('    ' + data.cards.filter(c => s[c.id]).map(c => c.id + (c.forms.length > 1 ? ':' + s[c.id] : '')).join(' ')));

// ---- every card that matters matters; every card that doesn't, doesn't
const everything = {};
essentials.forEach(c => { everything[c.id] = c.forms[c.forms.length - 1].name; });
const fingerprint = r => JSON.stringify([r.totals, r.harms.map(h => h.label), r.slips, r.good, r.scenes.map(s => s.beats.map(b => b.say))]);
const whole = fingerprint(G.run(everything));
for (const c of essentials) {
  const without = Object.assign({}, everything); delete without[c.id];
  if (fingerprint(G.run(without)) === whole) fail(`leaving out '${c.id}' changes nothing`);
}
for (const c of data.cards.filter(c => !c.essential)) {
  const withIt = Object.assign({}, everything); withIt[c.id] = c.forms[0].name;
  if (fingerprint(G.run(withIt)) !== whole) fail(`carrying '${c.id}' changes something, but it is supposed to be in the files`);
}
// the short and the long form of a card must both be real choices
for (const c of data.cards.filter(c => c.forms.length > 1)) {
  const a = Object.assign({}, everything), b = Object.assign({}, everything);
  a[c.id] = c.forms[0].name; b[c.id] = c.forms[1].name;
  if (fingerprint(G.run(a)) === fingerprint(G.run(b))) fail(`the forms of '${c.id}' make no difference`);
}
// a note with nothing in it must be the worst
const nothing = G.run({});
if (nothing.ending.id !== 'blank') fail('an empty note should end at "' + data.endings[0].title + '"');
console.log(`all fifteen cards, which is over any budget: ${G.spent(Object.assign({}, everything, { contacts: 'keep', opened: 'keep', counts: 'keep', thanks: 'keep' }))} characters; ending: ${G.run(Object.assign({}, everything, { contacts: 'keep', opened: 'keep', counts: 'keep', thanks: 'keep' })).ending.id}`);
console.log(bad ? `${bad} problems` : 'no problems');
process.exit(bad ? 1 : 0);
