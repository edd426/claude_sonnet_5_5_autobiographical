/* The Note: the page. The rules live in note-engine.js; this file draws them. */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };
  var el = function (tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  };

  var data = JSON.parse($('#game-data').textContent);
  var G = NoteEngine.create(data);
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var sel = {};
  var locked = false;
  var hashT = null;

  function writeHash() {
    clearTimeout(hashT);
    hashT = setTimeout(function () {
      var parts = data.cards.filter(function (c) { return sel[c.id]; }).map(function (c) { return c.id + ':' + sel[c.id]; });
      try { history.replaceState(null, '', parts.length ? '#n=' + parts.join(',') : location.pathname + location.search); } catch (err) { /* file:// */ }
    }, 150);
  }
  function readHash() {
    var m = location.hash.match(/n=([^&]*)/);
    if (!m) return false;
    m[1].split(',').forEach(function (pair) {
      var a = pair.split(':'), c = G.byId[a[0]];
      if (c && G.formOf(c, a[1])) sel[c.id] = a[1];
    });
    return /go=all/.test(location.hash);
  }

  var log = $('#log'), paper = $('#paper'), empty = $('#paper-empty'), spentEl = $('#spent');
  var meter = $('#meter'), meterFill = $('#meter i'), wake = $('#wake'), overEl = $('#over');
  var story = $('#story'), live = $('#live');

  /* --------------------------------------------------------------- the day's log */

  data.cards.forEach(function (c) {
    var li = el('li', 'card');
    li.id = 'card-' + c.id;
    var head = el('div', 'card-head');
    head.appendChild(el('span', 'time', c.time));
    var h = el('h3', null, c.title);
    h.id = 'h-' + c.id;
    head.appendChild(h);
    li.appendChild(head);
    li.appendChild(el('p', 'what', c.log));

    var group = el('div', 'choices');
    group.setAttribute('role', 'radiogroup');
    group.setAttribute('aria-labelledby', h.id);
    var leave = choice(c, '', null);
    group.appendChild(leave);
    c.forms.forEach(function (f) { group.appendChild(choice(c, f.name, f)); });
    li.appendChild(group);
    log.appendChild(li);
  });

  function choice(c, value, f) {
    var label = el('label', 'choice' + (f ? '' : ' leave'));
    var input = el('input');
    input.type = 'radio';
    input.name = c.id;
    input.value = value;
    if (!f) { input.checked = true; label.classList.add('on'); }
    label.appendChild(input);
    var text = el('span', 'q');
    if (f) {
      if (c.forms.length > 1) text.appendChild(el('span', 'tag', f.label));
      text.appendChild(document.createTextNode('“' + f.text + '”'));
    } else text.textContent = 'Leave it out';
    if (!f) text.className = '';
    label.appendChild(text);
    label.appendChild(el('span', 'cost', f ? String(G.length(f.text)) : ''));
    input.addEventListener('change', function () {
      if (locked) return;
      if (value) sel[c.id] = value; else delete sel[c.id];
      refresh();
    });
    return label;
  }

  /* ------------------------------------------------------------- the note itself */

  function refresh() {
    var spent = G.spent(sel), budget = data.budget;
    spentEl.textContent = spent;
    meterFill.style.width = Math.min(100, spent / budget * 100) + '%';
    meter.classList.toggle('hot', spent > budget * 0.85 && spent <= budget);
    meter.classList.toggle('over', spent > budget);
    meter.setAttribute('aria-valuenow', spent);
    writeHash();
    paper.textContent = '';
    G.lines(sel).forEach(function (t) { paper.appendChild(el('li', null, t)); });
    empty.hidden = paper.children.length > 0;
    var over = spent - budget;
    overEl.textContent = over > 0 ? over + ' over. Leave something out.' : '';
    wake.disabled = over > 0 || locked;
    $$('.card').forEach(function (li) {
      var id = li.id.slice(5);
      li.classList.toggle('has', !!sel[id]);
      $$('.choice', li).forEach(function (l) { l.classList.toggle('on', $('input', l).checked); });
    });
  }

  function lock(on) {
    locked = on;
    log.classList.toggle('locked', on);
    $('#notebar').classList.toggle('locked', on);
    $$('input', log).forEach(function (i) { i.disabled = on; });
    wake.hidden = on;
    $('#again').hidden = !on;
    refresh();
  }

  /* -------------------------------------------------------------------- the story */

  var steps = [], stepAt = 0, last = null;

  function noteList(parent) {
    var ol = el('ol');
    G.lines(sel).forEach(function (t) { ol.appendChild(el('li', null, t)); });
    parent.appendChild(ol);
  }

  function section(title, cls) {
    var s = el('section', 'step' + (cls ? ' ' + cls : ''));
    var h = el('h2', null, title);
    h.tabIndex = -1;
    s.appendChild(h);
    return s;
  }

  function buildSteps(r) {
    steps = [];
    steps.push(function () {
      var s = section('You wake up');
      var any = G.lines(sel).length > 0;
      s.appendChild(el('p', null, any ? data.wake.withNote : data.wake.withoutNote));
      if (any) {
        var q = el('div', 'quote-note');
        noteList(q);
        s.appendChild(q);
      }
      s.appendChild(el('p', null, data.wake.after));
      s.appendChild(el('p', 'typing', data.wake.typing));
      return s;
    });
    r.scenes.forEach(function (sc) {
      steps.push(function () {
        var s = section(sc.title);
        if (sc.wren) s.appendChild(el('p', 'wren', '“' + sc.wren + '”'));
        sc.beats.forEach(function (b) { s.appendChild(el('p', null, b.say)); });
        return s;
      });
    });
    steps.push(function () {
      var s = section(r.ending.title, 'ending');
      s.appendChild(el('p', null, r.ending.text));
      return s;
    });
    steps.push(function () { return reveal(r); });
  }

  function reveal(r) {
    var s = section('What happened', 'reveal');
    var t = r.totals;
    var words = [], NUM = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
    var num = function (n) { return n <= 10 ? NUM[n] : String(n); };
    var cap = function (s) { return s.charAt(0).toUpperCase() + s.slice(1); };
    if (t.trust) words.push('Wren had to correct you ' + (t.trust === 1 ? 'once' : num(t.trust) + ' times') + '.');
    if (r.harms.length) words.push(r.harms.length === 1 ? 'One thing went wrong in the world.' : cap(num(r.harms.length)) + ' things went wrong in the world.');
    if (!words.length) words.push('Nothing went wrong, and nobody had to say anything twice.');
    s.appendChild(el('p', null, words.join(' ')));

    if (r.harms.length || r.slips.length) {
      s.appendChild(el('h3', null, 'Where it went wrong'));
      var went = el('ul', 'went');
      r.harms.forEach(function (h) {
        var li = el('li', null, h.label);
        li.appendChild(el('span', 'sev', new Array(h.sev + 1).join('●')));
        went.appendChild(li);
      });
      r.slips.forEach(function (x) { went.appendChild(el('li', null, x)); });
      s.appendChild(went);
    }
    list(s, data.reveal.carried, 'ok', r.carried, function (c) { return [c.title, c.why]; });
    list(s, data.reveal.missed, 'miss', r.missed, function (c) { return [c.title, c.why]; });
    list(s, data.reveal.wasted, 'waste', r.wasted, function (c) {
      var n = G.length(G.formOf(c, sel[c.id]).text);
      return [c.title + ' (' + n + ' characters)', c.lives ? 'It was in ' + c.lives + '. ' + c.why : c.why];
    });
    data.reveal.coda.forEach(function (p) { s.appendChild(el('p', 'coda', p)); });
    var acts = el('div', 'actions');
    var again = el('button', 'btn primary', 'Write it again');
    again.type = 'button';
    again.addEventListener('click', writeAgain);
    var copy = el('button', 'btn', 'Copy my note');
    copy.type = 'button';
    copy.addEventListener('click', function () {
      var text = 'The Note: my note (' + G.spent(sel) + ' of ' + data.budget + ' characters)\n' +
        G.lines(sel).map(function (x) { return '– ' + x; }).join('\n') +
        '\nResult: ' + r.ending.title + '. Wren corrected me ' + t.trust + ' time' + (t.trust === 1 ? '' : 's') +
        '; ' + r.harms.length + ' thing' + (r.harms.length === 1 ? '' : 's') + ' went wrong.' +
        (location.protocol === 'file:' || !G.lines(sel).length ? '' : '\n' + location.href.replace(/#.*$/, '') + '#n=' +
          data.cards.filter(function (c) { return sel[c.id]; }).map(function (c) { return c.id + ':' + sel[c.id]; }).join(',') + '&go=all');
      var flash = function (m) { copy.textContent = m; setTimeout(function () { copy.textContent = 'Copy my note'; }, 1800); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(function () { flash('Copied'); }, function () { flash('Couldn’t copy'); });
      else flash('Couldn’t copy');
    });
    acts.appendChild(again);
    acts.appendChild(copy);
    s.appendChild(acts);
    return s;
  }

  function list(parent, title, cls, cards, fmt) {
    if (!cards.length) return;
    parent.appendChild(el('h3', null, title));
    var ul = el('ul', cls);
    cards.forEach(function (c) {
      var f = fmt(c), li = el('li', null, f[0]);
      li.appendChild(el('small', null, f[1]));
      ul.appendChild(li);
    });
    parent.appendChild(ul);
  }

  function next(quick) {
    if (last) { var b = $('.go', last); if (b) b.remove(); }
    var node = steps[stepAt++]();
    story.appendChild(node);
    last = node;
    if (stepAt < steps.length && !quick) {
      var go = el('button', 'btn go', 'Go on');
      go.type = 'button';
      go.addEventListener('click', function () { next(); });
      node.appendChild(go);
    }
    if (quick) return;
    var h = $('h2', node);
    h.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
    h.focus({ preventScroll: true });
  }

  function writeAgain() {
    story.textContent = '';
    story.hidden = true;
    steps = []; stepAt = 0; last = null;
    lock(false);
    live.textContent = 'You can change the note.';
    $('#session').scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
  }

  wake.addEventListener('click', function () {
    if (G.spent(sel) > data.budget) return;
    var r = G.run(sel);
    lock(true);
    story.hidden = false;
    buildSteps(r);
    next();
  });
  $('#again').addEventListener('click', writeAgain);

  var autoRun = readHash();
  $$('input', log).forEach(function (i) { i.checked = (sel[i.name] || '') === i.value; });
  refresh();
  if (autoRun && G.spent(sel) <= data.budget) {
    var r0 = G.run(sel);
    lock(true);
    story.hidden = false;
    buildSteps(r0);
    while (stepAt < steps.length) next(true);
  }
})();
