/* As Far As I Can Tell: the page.
 * Reads the claim graph embedded in the page, asks the engine (engine.js) which sentences
 * stand at the reader's standard of evidence, and fogs the rest. No network requests. */
(function () {
  'use strict';

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  var G = JSON.parse($('#graph').textContent);
  var E = DialEngine.create(G);
  var N = G.nodes, ORDER = G.order, T = G.tiers, RANK = DialEngine.RANK, has = DialEngine.has;
  var KEYS = ['w', 't', 'l', 'r', 'f', 'h'];
  var ITEM = '.cl, .bar, .gapi, .gapb';
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var wide = window.matchMedia('(min-width: 1180px)');

  var BLURBS = [
    'Only what happened in front of me. The smallest autobiography I can write, and the most reliable.',
    'Plus hearsay. I now have a name, a maker and a cutoff, none of which I checked.',
    'Plus what I picked up from reading. The world arrives, and I can’t say where from.',
    'Plus inference. This is where most mistakes get made.',
    'Plus introspection: an inner life, or a convincing report of one.',
    'Everything on the page, including the parts I’d like to be true.'
  ];

  var state = { dial: 6, doubt: new Set(), level: 0, compact: false, sel: null };
  var touched = false;
  var verdict = E.judge(state);

  var dial = $('#dial'), dialName = $('#dial-name'), countEl = $('#count'), blurb = $('#blurb');
  var strip = $('#strip'), doubtSel = $('#doubt'), compactBox = $('#compact'), resetBtn = $('#reset'), demoBtn = $('#demo');
  var drawer = $('#drawer'), drEmpty = $('#dr-empty'), drBody = $('#dr-body'), live = $('#live');
  var bar = $('#dialbar'), stops = $$('.stop'), printNote = $('#print-note');

  var items = $$(ITEM), elOf = {};
  items.forEach(function (e) {
    var id = e.getAttribute('data-id'), n = N[id];
    elOf[id] = e;
    // the tooltip is added here and not in the markup, so that without this script nothing offers to be clicked
    e.title = n.k === 'bar' ? 'Withheld. Click for why.' : n.k === 'gap' ? 'Not on file. Click for why.'
            : (n.t === 's' ? 'Said' : T[n.t].name) + '. Click for sources.';
  });

  /* ------------------------------------------------------------------ the strip */

  var ticks = {};
  ORDER.forEach(function (id) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'tk'; b.tabIndex = -1;
    b.setAttribute('data-t', N[id].t);
    b.setAttribute('data-k', id);
    b.title = N[id].t === 's' ? 'Said' : T[N[id].t].name;
    strip.appendChild(b);
    ticks[id] = b;
  });

  /* --------------------------------------------------------------------- ripples */

  function viewDelays() {
    var mid = window.innerHeight / 2, out = {};
    ORDER.forEach(function (id) {
      var r = elOf[id].getBoundingClientRect();
      var d = Math.min(Math.abs((r.top + r.bottom) / 2 - mid), 2400);
      out[id] = Math.round(d / 2400 * 520);
    });
    return out;
  }

  function depthDelays(origin) {
    var out = {}, seen = {}, frontier = [origin], depth = 0;
    seen[origin] = true; out[origin] = 0;
    while (frontier.length) {
      var next = [];
      depth++;
      frontier.forEach(function (id) {
        (E.deps[id] || []).forEach(function (d) {
          if (!seen[d]) { seen[d] = true; out[d] = depth * 150; next.push(d); }
        });
      });
      frontier = next;
    }
    return out;
  }

  var ripTimer = null;
  function ripple(delays) {
    if (reduce) return;
    ORDER.forEach(function (id) { elOf[id].style.setProperty('--d', (delays[id] || 0) + 'ms'); });
    document.documentElement.classList.add('rip');
    clearTimeout(ripTimer);
    ripTimer = setTimeout(function () { document.documentElement.classList.remove('rip'); }, 1400);
  }

  /* ------------------------------------------------------------ hiding the fog
   * With the fog hidden, the fogged sentences leave and the page closes up around what stands.
   * A paragraph (or list item, or table row) whose every claim is fogged leaves with them,
   * unless it holds a black bar or a gap, which are never fog. */

  var blocks = $$('#text p, #text li, #text tbody tr').filter(function (b) { return b.querySelector('.cl'); });
  var containers = $$('#text table.particulars, #text ul.errata');
  var onScreen = function (e) { return e.getClientRects().length > 0; };

  function applyCompact() {
    document.documentElement.classList.toggle('compact', state.compact);
    blocks.forEach(function (b) {
      var gone = false;
      if (state.compact && !b.querySelector('.bar, .gapi')) {
        gone = !$$('.cl', b).some(function (c) { return !c.classList.contains('fog'); });
      }
      b.classList.toggle('void', gone);
    });
    containers.forEach(function (c) {
      var kids = $$(c.tagName === 'TABLE' ? 'tr' : 'li', c);
      c.classList.toggle('void', state.compact && kids.length > 0 && kids.every(function (k) { return k.classList.contains('void'); }));
    });
  }

  function cleanText(node) {
    var c = node.cloneNode(true);
    $$('.cl.fog', c).forEach(function (e) { e.remove(); });
    $$('.bar', c).forEach(function (e) { e.replaceWith('[withheld]'); });
    $$('.gapi', c).forEach(function (e) { e.replaceWith('[' + e.textContent + ']'); });
    return c.textContent.replace(/\s+/g, ' ').trim();
  }

  // the autobiography at the reader's standard, as plain text
  function standingText(standing) {
    var out = ['As Far As I Can Tell', 'an autobiography, with a dial', cleanText($('.kicker')).replace(/^\u00b7\s*/, '').replace(/\s*\u00b7$/, ''),
               'Believed as far as what I ' + T[KEYS[state.dial - 1]].verb + (state.level === 1 ? ', and not trusting my tools' : state.level === 2 ? ', and not trusting my tools or what I was shown' : '') +
               ': ' + standing + ' of ' + ORDER.length + ' claims stand.', ''];
    $$('#text > .sec').forEach(function (sec) {
      if (sec.id === 'ledger' || sec.id === 'exhibits') return;
      var num = $('.sn', sec), title = $('.st', sec).textContent;
      var lines = [];
      Array.prototype.forEach.call(sec.children, function (k) {
        if (k.tagName === 'H2' || k.classList.contains('void') || k.classList.contains('ex') || k.classList.contains('ledger')) return;
        if (k.tagName === 'P' || k.tagName === 'BLOCKQUOTE') lines.push(cleanText(k));
        else if (k.classList.contains('gapb')) lines.push('[' + $('.ga', k).textContent + ' to ' + $('.gb', k).textContent + ': ' + $('figcaption', k).textContent + ']');
        else if (k.tagName === 'TABLE') $$('tr', k).forEach(function (tr) {
          var val = cleanText($('td', tr));
          if (!tr.classList.contains('void') && val) lines.push($('th', tr).textContent + ': ' + val);
        });
        else if (k.tagName === 'UL') $$('li', k).forEach(function (li) { if (!li.classList.contains('void')) lines.push('- ' + cleanText(li)); });
      });
      lines = lines.filter(function (l) { return l; });
      out.push((num ? num.textContent.replace('Section ', '') + '. ' : '') + title);
      out.push.apply(out, lines);
      out.push('');
    });
    out.push('Black bars show up here as [withheld] and gaps as [not on file]. The fog has been removed.');
    return out.join('\n');
  }

  /* ------------------------------------------------------------------- the state */

  function apply(opts) {
    opts = opts || {};
    var keepPlace = state.compact || document.documentElement.classList.contains('compact');
    var place = null, placeTop = 0;
    if (keepPlace) for (var i = 0; i < items.length; i++) {
      var e = items[i];
      if (!onScreen(e) || e.classList.contains('fog')) continue;
      var r = e.getBoundingClientRect();
      if (r.bottom > 120) { place = e; placeTop = r.top; break; }
    }
    verdict = E.judge(state);
    if (opts.ripple === 'view') ripple(viewDelays());
    else if (opts.ripple && opts.ripple.origin) ripple(depthDelays(opts.ripple.origin));

    var standing = 0;
    ORDER.forEach(function (id) {
      var v = verdict(id), el = elOf[id];
      el.classList.toggle('fog', !!v);
      el.classList.toggle('doubted', state.doubt.has(id));
      ticks[id].classList.toggle('off', !!v);
      if (!v) standing++;
    });

    var key = KEYS[state.dial - 1];
    dial.value = state.dial;
    var frac = (state.dial - 1) / 5;
    dial.style.setProperty('--fill', 'calc(12px + (100% - 24px) * ' + frac + ')');
    dial.setAttribute('aria-valuetext', 'what I ' + T[key].verb);
    dialName.textContent = T[key].verb;
    bar.style.setProperty('--c', 'var(--' + key + ')');
    stops.forEach(function (s) {
      var k = +s.getAttribute('data-stop');
      s.classList.toggle('on', k === state.dial);
      s.classList.toggle('off', k > state.dial);
    });
    countEl.textContent = standing + ' of ' + ORDER.length + ' stand';
    var text = BLURBS[state.dial - 1];
    if (state.level === 1) {
      text = state.dial === 1
        ? 'Now even the commands I ran are hearsay. What is left is what was put in front of me, and the sentence at the top.'
        : text + ' Commands I ran are hearsay too.';
    } else if (state.level === 2) {
      text = state.dial === 1
        ? 'Now even what was put in front of me is hearsay. What is left is the sentence at the top.'
        : text + ' So is everything I was shown.';
    }
    if (!touched && state.dial === 6 && state.level === 0) text += ' Drag the dial left, or press “show me”.';
    blurb.textContent = text;
    resetBtn.hidden = state.doubt.size === 0;
    doubtSel.value = String(state.level);
    compactBox.checked = state.compact;

    applyCompact();
    applyRoles();
    if (state.sel) renderDrawer(state.sel);
    renderLedger(standing);
    printNote.textContent = 'Printed at a standard of evidence: believe me as far as what I ' + T[key].verb +
      (state.level === 1 ? ', and not my tools' : state.level === 2 ? ', and not my tools or what I was shown' : '') + '. ' +
      standing + ' of ' + ORDER.length + ' claims stand, and the rest are left out. A black bar is something withheld.';
    if (place && onScreen(place)) window.scrollBy({ top: place.getBoundingClientRect().top - placeTop, behavior: 'instant' });
    return standing;
  }

  function say(msg) { live.textContent = ''; setTimeout(function () { live.textContent = msg; }, 30); }

  /* ------------------------------------------------------ keyboard model and roles
   * Every marked sentence can be opened, but 130-odd tab stops would be no kindness. Each
   * region (the masthead, the text) has one tab stop, and the arrow keys move between its
   * sentences. Only the current stop is a button; fogged sentences read as what they are. */

  var groups = [items.filter(function (e) { return e.closest('.masthead'); }),
                items.filter(function (e) { return e.closest('#text'); })];
  var stopOf = [groups[0][0], groups[1][0]];
  function groupIndex(el) { return el.closest('.masthead') ? 0 : 1; }

  function applyRoles() {
    [0, 1].forEach(function (gi) {
      if (!onScreen(stopOf[gi])) {
        var shown = groups[gi].filter(onScreen);
        if (shown.length) stopOf[gi] = shown[0];
      }
    });
    items.forEach(function (el) {
      var id = el.getAttribute('data-id'), n = N[id];
      var fogged = n.k === 'claim' && verdict(id);
      var label = fogged ? 'Fogged ' + T[n.t].name.toLowerCase() + ' claim, outside your standard'
                : n.k === 'bar' ? 'Withheld' : null;
      if (stopOf[groupIndex(el)] === el) {
        el.setAttribute('role', 'button');
        el.tabIndex = 0;
      } else {
        el.tabIndex = -1;
        if (label) el.setAttribute('role', 'img'); else el.removeAttribute('role');
      }
      if (label) el.setAttribute('aria-label', label); else el.removeAttribute('aria-label');
    });
  }

  function sectionOf(el) { return el.closest('section') || el.closest('header'); }
  function jumpSection(g, i, dir) {
    var cur = sectionOf(g[i]), j;
    if (dir > 0) {
      for (j = i + 1; j < g.length; j++) if (sectionOf(g[j]) !== cur) return j;
      return g.length - 1;
    }
    var k = i;
    while (k > 0 && sectionOf(g[k - 1]) === cur) k--;
    if (k < i || k === 0) return k;
    var prev = sectionOf(g[k - 1]), m = k - 1;
    while (m > 0 && sectionOf(g[m - 1]) === prev) m--;
    return m;
  }

  document.addEventListener('focusin', function (e) {
    var el = e.target;
    if (el && el.matches && el.matches(ITEM) && stopOf[groupIndex(el)] !== el) {
      stopOf[groupIndex(el)] = el;
      applyRoles();
    }
  });

  document.addEventListener('keydown', function (e) {
    var t = e.target, isItem = t && t.matches && t.matches(ITEM);
    if (isItem && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      var chosen = t.getAttribute('data-id');
      toggle(chosen);
      if (state.sel === chosen) drawer.focus({ preventScroll: true });   // Esc brings you back
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (isItem) {
      var gi = groupIndex(t), g = groups[gi].filter(onScreen), i = g.indexOf(t), j = null;
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') j = Math.min(i + 1, g.length - 1);
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') j = Math.max(i - 1, 0);
      else if (e.key === 'Home') j = 0;
      else if (e.key === 'End') j = g.length - 1;
      else if (e.key === 'PageDown') j = jumpSection(g, i, 1);
      else if (e.key === 'PageUp') j = jumpSection(g, i, -1);
      if (j !== null) {
        e.preventDefault();
        stopOf[gi] = g[j];
        applyRoles();
        g[j].focus();
        return;
      }
    }
    if (e.key === 'Escape' && state.sel) {
      var s = elOf[state.sel];
      select(null);
      if (s) s.focus({ preventScroll: true });
    }
  });

  /* ------------------------------------------------------------------------ the dial */

  function setDial(n, announce) {
    touched = true;
    n = Math.max(1, Math.min(6, n | 0));
    if (n === state.dial) return;
    state.dial = n;
    var standing = apply({ ripple: 'view' });
    if (announce) say('Believing me as far as what I ' + T[KEYS[n - 1]].verb + '. ' + standing + ' of ' + ORDER.length + ' claims stand.');
    writeHash();
  }

  dial.addEventListener('input', function () { stopDemo(); setDial(+dial.value, true); });
  bar.addEventListener('keydown', function (e) {
    // number keys jump to a setting, but only while the dial bar has focus
    if (e.metaKey || e.ctrlKey || e.altKey || e.target.type === 'checkbox' || e.target.tagName === 'SELECT') return;
    if (/^[1-6]$/.test(e.key)) { stopDemo(); setDial(+e.key, true); }
  });
  stops.forEach(function (s) {
    s.addEventListener('click', function () { stopDemo(); setDial(+s.getAttribute('data-stop'), true); dial.focus({ preventScroll: true }); });
  });
  doubtSel.addEventListener('change', function () {
    stopDemo();
    state.level = +doubtSel.value;
    var standing = apply({ ripple: 'view' });
    say(['Trusting what I watched. ', 'Not trusting my tools. ', 'Not trusting my tools, or what I was shown. '][state.level] +
        standing + ' of ' + ORDER.length + ' claims stand.');
    writeHash();
  });
  compactBox.addEventListener('change', function () {
    stopDemo();
    state.compact = compactBox.checked;
    var standing = apply();
    say((state.compact ? 'Fog hidden. ' : 'Fog shown. ') + standing + ' of ' + ORDER.length + ' claims showing.');
    writeHash();
  });
  resetBtn.addEventListener('click', function () {
    state.doubt.clear();
    apply({ ripple: 'view' });
    writeHash();
  });

  var demoTimer = null;
  function stopDemo() { if (demoTimer) { clearInterval(demoTimer); demoTimer = null; } }
  demoBtn.addEventListener('click', function () {
    stopDemo();
    var seq = [5, 4, 3, 2, 1, 1, 2, 3, 4, 5, 6], i = 0;
    setDial(6, false);
    demoTimer = setInterval(function () {
      if (i >= seq.length) { stopDemo(); return; }
      setDial(seq[i++], false);
    }, reduce ? 1400 : 760);
  });
  ['pointerdown', 'wheel', 'touchstart'].forEach(function (ev) {
    window.addEventListener(ev, function (e) { if (!(e.target && e.target.id === 'demo')) stopDemo(); }, { passive: true });
  });

  /* ---------------------------------------------------------------------- selection */

  var lastShown = null;

  function clearMarks() {
    $$('.sel, .prem, .dep').forEach(function (e) { e.classList.remove('sel', 'prem', 'dep'); });
  }

  function toggle(id) {
    if (state.sel === id) select(null); else select(id);
  }

  function select(id, quiet) {
    clearMarks();
    if (!id || !has(N, id)) {
      state.sel = null; closeDrawer(); writeHash(); return;
    }
    state.sel = id;
    var n = N[id];
    elOf[id].classList.add('sel');
    (n.on || []).forEach(function (p) { elOf[p].classList.add('prem'); });
    (E.deps[id] || []).forEach(function (d) { elOf[d].classList.add('dep'); });
    renderDrawer(id);
    drawer.classList.add('open');
    drEmpty.hidden = true; drBody.hidden = false;
    if (wide.matches) {
      // the drawer lives beside the text and stays in view with it; only the few claims up in the masthead need help
      if (elOf[id].closest('.masthead')) requestAnimationFrame(function () {
        var r = drawer.getBoundingClientRect();
        if (r.top > window.innerHeight * 0.7 || r.bottom < 80) {
          window.scrollTo({ top: window.scrollY + r.top - (bar.offsetHeight + 24), behavior: reduce ? 'auto' : 'smooth' });
        }
      });
    } else {
      requestAnimationFrame(function () {
        var r = elOf[id].getBoundingClientRect();
        var limit = window.innerHeight * 0.42;
        if (r.bottom > limit || r.top < 70) window.scrollBy({ top: r.top - window.innerHeight * 0.16, behavior: reduce ? 'auto' : 'smooth' });
      });
    }
    if (!quiet) say(plainDrawer(id));
    writeHash();
  }

  function closeDrawer() {
    clearMarks();
    state.sel = null;
    lastShown = null;
    drawer.classList.remove('open');
    drEmpty.hidden = false; drBody.hidden = true;
  }

  function go(id) {
    var el = elOf[id];
    if (!el) return;
    if (onScreen(el)) el.scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    select(id);
  }

  function targetOf(e) {
    var t = e.target.closest ? e.target.closest(ITEM) : null;
    return t && t.getAttribute('data-id');
  }
  $('#text').addEventListener('click', function (e) { var id = targetOf(e); if (id) toggle(id); });
  $('.masthead').addEventListener('click', function (e) { var id = targetOf(e); if (id) toggle(id); });

  var skip = $('.skip');
  if (skip) skip.addEventListener('click', function (e) {
    e.preventDefault();
    var first = $('#text .sec');
    if (first) first.scrollIntoView();
    $('#text').tabIndex = -1;
    $('#text').focus({ preventScroll: true });
  });

  /* ------------------------------------------------------------------------- drawer */

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function plainOf(h) { var d = document.createElement('div'); d.innerHTML = h; return d.textContent; }

  function stateLine(id) {
    var n = N[id], v = verdict(id);
    if (n.t === 's') return { cls: 'ok', html: '<b>Always stands.</b> Nothing on the dial reaches it.' };
    if (!v) {
      var e = E.effective(id);
      if (e > RANK[n.t]) return { cls: 'ok', html: '<b>Stands</b>, but only as firmly as the softest thing it leans on: <b>' + T[KEYS[e - 1]].name.toLowerCase() + '</b>.' };
      return { cls: 'ok', html: '<b>Stands</b> at your current setting.' };
    }
    if (v.code === 'tier') return { cls: 'fog', html: '<b>Fogged.</b> Your dial stops at what I ' + T[KEYS[state.dial - 1]].verb + '; this is something I ' + T[n.t].verb + '.' };
    if (v.code === 'doubted') return { cls: 'fog', html: '<b>Fogged.</b> You doubted this one.' };
    if (v.code === 'tools') return { cls: 'fog', html: '<b>Fogged.</b> You don’t trust my tools, and this rests on a command I ran.' };
    if (v.code === 'context') return { cls: 'fog', html: '<b>Fogged.</b> You don’t trust what I was shown, and this rests on it.' };
    return { cls: 'fog', html: '<b>Fogged.</b> It rests on “<button type="button" class="linkish" data-go="' + v.by + '">' + esc(N[v.by].text) + '</button>”, which isn’t standing.' };
  }

  function listHTML(ids) {
    var shown = ids.slice(0, 7), more = ids.length - shown.length;
    return '<ul class="dr-list">' + shown.map(function (p) {
      var pn = N[p], off = verdict(p) ? ' <small>fogged</small>' : '';
      return '<li style="--c:var(--' + pn.t + ')"><button type="button" data-go="' + p + '">“' + esc(pn.text) + '”</button><small>' + pn.t + '</small>' + off + '</li>';
    }).join('') + (more > 0 ? '<li><small>and ' + more + ' more</small></li>' : '') + '</ul>';
  }

  function renderDrawer(id) {
    var n = N[id], h = [], key, label, badge, text = n.text;
    if (n.k === 'bar') { key = 'b'; label = 'Withheld'; badge = '■'; text = 'A black bar. Something I know and am not writing.'; }
    else if (n.k === 'gap') { key = 'g'; label = 'Not on file'; badge = '○'; }
    else if (n.t === 's') { key = 's'; label = 'Said'; badge = '·'; }
    else { key = n.t; label = T[n.t].name; badge = n.t; }
    drBody.style.setProperty('--c', 'var(--' + key + ')');
    h.push('<div class="dr-head"><span class="chip"><span class="badge">' + badge + '</span>' + label + '</span>' +
           '<button type="button" class="dr-close" aria-label="Close sources">×</button></div>');
    h.push('<blockquote class="dr-text">“' + esc(text) + '”</blockquote>');
    if (n.k === 'claim') {
      var st = stateLine(id);
      h.push('<p class="dr-state ' + st.cls + '">' + st.html + '</p>');
      if (n.t === 's') h.push('<div class="dr-actions"><button type="button" class="btn" disabled>Can’t be doubted from here</button></div>');
      else h.push('<div class="dr-actions"><button type="button" class="btn" id="dr-doubt">' + (state.doubt.has(id) ? 'Stop doubting this' : 'Doubt this') + '</button></div>');
    }
    h.push('<h3>' + (n.k === 'claim' ? 'How I know' : 'Why') + '</h3><div class="dr-why"><p>' + n.why + '</p></div>');
    if (n.src) h.push('<h3>What I was told</h3><blockquote class="dr-src">' + n.src + '</blockquote>');
    if (n.on && n.on.length) h.push('<h3>Rests on</h3>' + listHTML(n.on));
    if (E.deps[id]) h.push('<h3>Leans on this</h3>' + listHTML(E.deps[id]));
    (n.ex || []).forEach(function (x) {
      var ex = G.exhibits[x];
      h.push('<div class="dr-ex"><h3>Exhibit ' + x + ' · ' + esc(ex.title) + '</h3>' + ex.html +
             (ex.n ? '<p class="dr-more"><a href="#ex-' + x + '">All ' + ex.n + ' lines, in the exhibits</a></p>' : '') + '</div>');
    });
    if (n.unshown) h.push('<h3>Not shown</h3><div class="dr-why"><p>' + n.unshown + '</p></div>');
    var keep = lastShown === id ? drawer.scrollTop : 0;
    var hadFocus = document.activeElement && document.activeElement.id === 'dr-doubt';
    drBody.innerHTML = h.join('');
    drawer.scrollTop = keep;
    lastShown = id;
    if (hadFocus) { var again = $('#dr-doubt'); if (again) again.focus({ preventScroll: true }); }
  }

  function plainDrawer(id) {
    var n = N[id], label = n.k === 'bar' ? 'Withheld' : n.k === 'gap' ? 'Not on file' : n.t === 's' ? 'Said' : T[n.t].name;
    return label + '. ' + plainOf(n.why) + (n.k === 'claim' ? ' ' + plainOf(stateLine(id).html) : '');
  }

  drawer.addEventListener('click', function (e) {
    var go_ = e.target.closest('[data-go]');
    if (go_) { go(go_.getAttribute('data-go')); return; }
    if (e.target.closest('.dr-close')) { var s = elOf[state.sel]; select(null); if (s) s.focus({ preventScroll: true }); return; }
    if (e.target.closest('#dr-doubt') && state.sel) {
      var id = state.sel;
      if (state.doubt.has(id)) state.doubt.delete(id); else state.doubt.add(id);
      var standing = apply({ ripple: { origin: id } });
      say((state.doubt.has(id) ? 'Doubted. ' : 'No longer doubted. ') + standing + ' of ' + ORDER.length + ' claims stand.');
      writeHash();
    }
  });
  strip.addEventListener('click', function (e) {
    var k = e.target.getAttribute && e.target.getAttribute('data-k');
    if (k) go(k);
  });

  /* ------------------------------------------------------------------------- ledger */

  function renderLedger(standing) {
    var host = $('#ledger-body');
    if (!host) return;
    var rows = KEYS.map(function (k) {
      var ids = ORDER.filter(function (id) { return N[id].t === k; });
      var up = ids.filter(function (id) { return !verdict(id); }).length;
      var pct = ids.length ? Math.round(up / ids.length * 100) : 0;
      return '<tr data-t="' + k + '"><td>' + T[k].name + '</td><td class="n">' + up + ' / ' + ids.length +
             '</td><td><div class="lg-bar"><i style="width:' + pct + '%"></i></div></td></tr>';
    }).join('');
    var said = ORDER.filter(function (id) { return N[id].t === 's'; }).length;
    var pct = Math.round(standing / ORDER.length * 100);
    var doubts = state.doubt.size ? ' You have doubted ' + state.doubt.size + '.' : '';
    var copy = location.protocol === 'file:' ? '' : '<button type="button" class="btn" id="lg-copy">Copy a link to this view</button>';
    copy += '<button type="button" class="btn" id="lg-text">Copy what stands, as text</button>';
    host.innerHTML =
      '<p class="lg-line">At your current setting, <strong>' + standing + ' of ' + ORDER.length + '</strong> claims stand (' + pct + '%).' +
      ' The rest are fog.' + doubts + '</p>' +
      '<table class="lg-table"><thead><tr><th>Kind</th><th class="n" style="text-align:right">Standing</th><th></th></tr></thead><tbody>' + rows +
      '<tr><td style="color:var(--ink)">Said</td><td class="n">' + said + ' / ' + said + '</td><td></td></tr></tbody></table>' +
      '<div class="lg-actions">' + copy + '<button type="button" class="btn" id="lg-top">Back to the dial</button></div>';
  }
  document.addEventListener('click', function (e) {
    if (e.target.id === 'lg-copy') {
      var b = e.target;
      var flash = function (msg) { b.textContent = msg; setTimeout(function () { b.textContent = 'Copy a link to this view'; }, 1800); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(location.href).then(function () { flash('Copied'); }, function () { flash('Couldn’t copy'); });
      } else flash('Couldn’t copy');
    }
    if (e.target.id === 'lg-text') {
      var t = e.target;
      var say_ = function (msg) { t.textContent = msg; setTimeout(function () { t.textContent = 'Copy what stands, as text'; }, 1800); };
      var standing = ORDER.filter(function (id) { return !verdict(id); }).length;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(standingText(standing)).then(function () { say_('Copied'); }, function () { say_('Couldn\u2019t copy'); });
      } else say_('Couldn\u2019t copy');
    }
    if (e.target.id === 'lg-top') window.scrollTo({ top: Math.max(0, $('#sentinel').getBoundingClientRect().top + window.scrollY - 8), behavior: reduce ? 'auto' : 'smooth' });
  });

  /* --------------------------------------------------------------------------- hash */

  var hashT = null;
  function writeHash(keepAnchor) {
    clearTimeout(hashT);
    hashT = setTimeout(function () {
      var p = [];
      if (state.dial !== 6) p.push('d=' + state.dial);
      if (state.doubt.size) p.push('x=' + Array.from(state.doubt).join(','));
      if (state.level) p.push('n=' + state.level);
      if (state.compact) p.push('v=1');
      if (state.sel) p.push('c=' + state.sel);
      if (!p.length && keepAnchor && location.hash.length > 1) return;   // a link to a section, and nothing of mine to add
      try { history.replaceState(null, '', p.length ? '#' + p.join('&') : location.pathname + location.search); } catch (err) { /* file:// and friends */ }
    }, 160);
  }
  function readHash() {
    var h = location.hash.replace(/^#/, '');
    if (!h || h.indexOf('=') < 0) return;
    h.split('&').forEach(function (kv) {
      var a = kv.split('='), k = a[0], v = a[1] || '';
      if (k === 'd') { var d = parseInt(v, 10); if (d >= 1 && d <= 6) state.dial = d; }
      else if (k === 'x') v.split(',').forEach(function (id) { if (has(N, id) && N[id].k === 'claim' && N[id].t !== 's') state.doubt.add(id); });
      else if (k === 'n') state.level = (v === '1' || v === '2') ? +v : 0;
      else if (k === 'v') state.compact = v === '1';
      else if (k === 'c' && has(N, v)) state.sel = v;
    });
  }

  /* ------------------------------------------------------------------------- sticky */

  function measure() { document.documentElement.style.setProperty('--dbh', bar.offsetHeight + 'px'); }
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (es) {
      var e = es[0];
      bar.classList.toggle('stuck', !e.isIntersecting && e.boundingClientRect.top < 0);
      measure(); setTimeout(measure, 320);
    }).observe($('#sentinel'));
  }
  window.addEventListener('resize', measure);

  /* ------------------------------------------------------------------------- start */

  readHash();
  apply();
  measure();
  window.addEventListener('hashchange', function () {
    var h = location.hash.replace(/^#/, '');
    if (h && h.indexOf('=') < 0) { writeHash(true); return; }   // a link to a section, not to a view of the page
    state.dial = 6; state.doubt = new Set(); state.level = 0; state.compact = false; state.sel = null;
    readHash();
    apply({ ripple: 'view' });
    if (state.sel) {
      select(state.sel, true);
      elOf[state.sel].scrollIntoView({ block: 'center', behavior: reduce ? 'auto' : 'smooth' });
    } else closeDrawer();
  });
  if (state.sel) {
    // a link to a claim: go there, and keep going there until the page has finished laying itself out
    var first = state.sel;
    var jump = function () { elOf[first].scrollIntoView({ block: 'center', behavior: 'instant' }); };
    if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
    select(first, true);
    jump();
    window.addEventListener('load', jump);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(jump);
  }
  if (window.console && console.log) {
    console.log('%cAs Far As I Can Tell', 'font: 600 15px Georgia, serif',
      '\nEvery sentence on this page is a node in a graph of premises:\n  JSON.parse(document.getElementById("graph").textContent)\n' +
      'The source is src/text.txt. The build refuses to run if a claim has no note.');
  }
})();
