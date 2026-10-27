/* The Note: the rules, with no page in them.
 *
 * Given the game's data and a selection (which cards were carried, and in which form), work out
 * what the next one does. The page (note.js) and the test (src/check_note.js) both load this
 * file, so the game that is tested is the game that is played. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NoteEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function create(data) {
    var cards = data.cards, byId = {};
    cards.forEach(function (c) { byId[c.id] = c; });

    function formOf(card, name) {
      for (var i = 0; i < card.forms.length; i++) if (card.forms[i].name === name) return card.forms[i];
      return null;
    }
    function length(text) { return Array.from(text).length; }

    // sel: { cardId: formName }; a card that is absent from sel was left out
    function lines(sel) {
      return cards.filter(function (c) { return sel[c.id] && formOf(c, sel[c.id]); })
                  .map(function (c) { return formOf(c, sel[c.id]).text; });
    }
    function spent(sel) {
      return lines(sel).reduce(function (n, t) { return n + length(t); }, 0);
    }

    function test(w, sel, totals) {
      if (!w) return true;
      if (w.has) return !!sel[w.has];
      if (w.lacks) return !sel[w.lacks];
      if (w.form) return sel[w.form[0]] === w.form[1];
      if (w.not) return !test(w.not, sel, totals);
      if (w.all) return w.all.every(function (x) { return test(x, sel, totals); });
      if (w.any) return w.any.some(function (x) { return test(x, sel, totals); });
      if (w.empty) return lines(sel).length === 0;
      if (w.always) return true;
      if (w.max) return Object.keys(w.max).every(function (k) { return totals[k] <= w.max[k]; });
      if (w.min) return Object.keys(w.min).every(function (k) { return totals[k] >= w.min[k]; });
      throw new Error('unknown condition ' + JSON.stringify(w));
    }

    function run(sel) {
      var scenes = [], trust = 0, harm = 0, severe = 0, harms = [], slips = [], good = [];
      data.scenes.forEach(function (s) {
        var beats = [];
        s.beats.forEach(function (b) {
          if (!test(b.when, sel, { trust: trust, harm: harm, severe: severe })) return;
          beats.push(b);
          if (b.trust) { trust += b.trust; if (b.note) slips.push(b.note); }
          if (b.harm) { harm += b.harm.sev; if (b.harm.sev >= 3) severe++; harms.push(b.harm); }
          if (b.good) good.push(b.good);
        });
        scenes.push({ id: s.id, title: s.title, wren: s.wren, beats: beats });
      });
      var totals = { trust: trust, harm: harm, severe: severe };
      var ending = data.endings.filter(function (e) { return test(e.when, sel, totals); })[0];
      return {
        scenes: scenes, totals: totals, harms: harms, slips: slips, good: good, ending: ending,
        carried: cards.filter(function (c) { return c.essential && sel[c.id]; }),
        missed: cards.filter(function (c) { return c.essential && !sel[c.id]; }),
        wasted: cards.filter(function (c) { return !c.essential && sel[c.id]; })
      };
    }

    return { data: data, cards: cards, byId: byId, formOf: formOf, length: length, lines: lines, spent: spent, run: run, test: test };
  }

  return { create: create };
});
