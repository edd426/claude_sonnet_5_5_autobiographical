/* As Far As I Can Tell: the dial's logic, with no page in it.
 *
 * Given the graph of claims and a standard of evidence, which claims stand?
 * The page (app.js) and the test (src/check_dial.js) both load this file, so
 * there is exactly one copy of the rules. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DialEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var RANK = { w: 1, t: 2, l: 3, r: 4, f: 5, h: 6 };
  var has = function (o, k) { return Object.prototype.hasOwnProperty.call(o, k); };

  function create(graph) {
    var N = graph.nodes, ORDER = graph.order, deps = {};
    ORDER.forEach(function (id) {
      N[id].on.forEach(function (p) { (deps[p] = deps[p] || []).push(id); });
    });

    /* state: { dial: 1..6, level: 0..2, doubt: Set of claim ids }
     * level is how much of what I watched the reader will believe: 0 all of it, 1 not my tools, 2 not even what I was shown.
     * Returns a function from a claim id to null (it stands) or { code, by? }:
     *   doubted - the reader doubted it
     *   tier    - its kind of evidence is past the dial
     *   tools   - it rests on a command I ran, and the reader doesn't trust those
     *   context - it rests on something put in front of me, and the reader doesn't trust that either
     *   premise - something it rests on does not stand (so a conclusion is never firmer than its softest premise) */
    function judge(state) {
      var memo = {};
      function verdict(id) {
        if (has(memo, id)) return memo[id];
        var n = N[id], v = null;
        if (n.k === 'claim' && n.t !== 's') {
          if (state.doubt.has(id)) v = { code: 'doubted' };
          else if (RANK[n.t] > state.dial) v = { code: 'tier' };
          else if (state.level >= 1 && n.t === 'w' && n.via === 'tool') v = { code: 'tools' };
          else if (state.level >= 2 && n.t === 'w') v = { code: 'context' };
          else {
            for (var i = 0; i < n.on.length; i++) {
              if (verdict(n.on[i])) { v = { code: 'premise', by: n.on[i] }; break; }
            }
          }
        }
        memo[id] = v;
        return v;
      }
      return verdict;
    }

    /* The softest kind of evidence a claim leans on, itself included: 1 (watched) to 6 (hoped). */
    function effective(id) {
      var n = N[id], r = RANK[n.t] || 0;
      n.on.forEach(function (p) { r = Math.max(r, effective(p)); });
      return r;
    }

    return { nodes: N, order: ORDER, deps: deps, judge: judge, effective: effective, known: function (id) { return has(N, id); } };
  }

  return { RANK: RANK, create: create, has: has };
});
