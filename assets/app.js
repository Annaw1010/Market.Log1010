/* Market Pulse front end. Plain JavaScript, no build step. */
(() => {
  'use strict';

  // ------------------------------------------------------------------
  // Basics
  // ------------------------------------------------------------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const VIEWS = ['live', 'day', 'week', 'month', 'year', 'desk', 'recruit'];
  const PERIODS = {
    day: { key: '1D', brief: 'Today in sixty seconds', top: 'Top stories in the last 24 hours', table: '1-day change' },
    week: { key: '1W', brief: 'This week in sixty seconds', top: 'Top stories this week', table: '1-week change' },
    month: { key: '1M', brief: 'This month in sixty seconds', top: 'Top stories over the past 30 days', table: '1-month change' },
    year: { key: 'YTD', brief: 'The year so far in sixty seconds', top: 'Top stories this year', table: 'Year-to-date change' },
  };
  const POLL_MS = 120000;

  const S = {
    cfg: null, latest: null, top: null, ind: null, firms: null, watch: null, meta: null,
    saved: { articles: [], tickers: [] },
    view: 'day',
    filters: {},
    seenIds: null,
    freshIds: new Set(),
    openTickers: new Set(),
    sync: lsGet('mp.sync', {}) || {},
    syncState: '',
  };

  function lsGet(key, fallback) {
    try { const v = localStorage.getItem(key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  }
  function lsSet(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full or blocked */ }
  }

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [k, v] of Object.entries(props)) {
        if (v == null || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
        else if (k === 'dataset') Object.assign(node.dataset, v);
        else if (k === 'value') node.value = v;
        else if (k === 'checked') node.checked = !!v;
        else node.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  function safeUrl(u) {
    try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:' ? x.href : null; } catch { return null; }
  }
  function extLink(href, text, cls) {
    const url = safeUrl(href);
    return url ? el('a', { href: url, target: '_blank', rel: 'noopener noreferrer', class: cls }, text) : el('span', { class: cls }, text);
  }
  function domain(u) {
    try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; }
  }
  function slugTitle(u) {
    try {
      const parts = new URL(u).pathname.split('/').filter(Boolean);
      if (!parts.length) return '';
      let seg = parts.reduce((a, b) => (b.length > a.length ? b : a), '');
      seg = seg.replace(/\.(html?|php|aspx?)$/i, '');
      const words = seg.split(/[-_]+/).filter((w) => /^[a-z]+$/i.test(w));
      if (words.length < 3) return '';
      const s = words.join(' ');
      return s.charAt(0).toUpperCase() + s.slice(1);
    } catch { return ''; }
  }

  // Time and number formatting
  function ago(iso) {
    const t = Date.parse(iso);
    if (!t) return '';
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    if (h < 24) return `${h} h ago`;
    const d = Math.round(h / 24);
    return d === 1 ? 'yesterday' : `${d} days ago`;
  }
  const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
  const timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
  const monthFmt = new Intl.DateTimeFormat('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  function fmtDay(s) {
    if (!s) return '';
    const d = s.length === 10 ? new Date(`${s}T12:00:00`) : new Date(s);
    return isNaN(d) ? '' : dateFmt.format(d);
  }
  const NF = {};
  function nf(digits) {
    if (!NF[digits]) NF[digits] = new Intl.NumberFormat('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
    return NF[digits];
  }
  const MINUS = '\u2212';
  function signed(n, digits, suffix) {
    if (n == null || !isFinite(n)) return '–';
    const s = nf(digits).format(Math.abs(n));
    if (Number(s.replace(/,/g, '')) === 0) return `0${digits ? '.' + '0'.repeat(digits) : ''}${suffix}`;
    return `${n > 0 ? '+' : MINUS}${s}${suffix}`;
  }
  function signClass(n) {
    if (n == null || !isFinite(n) || Math.abs(n) < 1e-9) return 'flat';
    return n > 0 ? 'up' : 'down';
  }
  function fmtLast(rec) {
    const v = rec.last;
    switch (rec.kind) {
      case 'yield': return `${v.toFixed(2)}%`;
      case 'spread': return `${Math.round(v * 100)} bp`;
      case 'fx': return v < 10 ? v.toFixed(4) : v.toFixed(2);
      case 'level': return v.toFixed(2);
      default: return v >= 10000 ? nf(0).format(v) : nf(2).format(v);
    }
  }
  function fmtChange(rec, key) {
    const c = rec.chg && rec.chg[key];
    if (!c) return { text: '–', cls: 'flat' };
    if (rec.kind === 'yield' || rec.kind === 'spread') return { text: signed(c.bps, 0, ' bp'), cls: signClass(c.bps) };
    if (rec.kind === 'level') return { text: signed(c.abs, 2, ' pts'), cls: signClass(c.abs) };
    return { text: signed(c.pct, 2, '%'), cls: signClass(c.pct) };
  }

  function sliceSeries(series, period) {
    if (!series || series.length < 2) return [];
    if (period === 'day' || period === 'week' || period === 'live') return series.slice(-10);
    const last = new Date(series[series.length - 1][0]);
    if (period === 'month') {
      const cut = new Date(last); cut.setDate(cut.getDate() - 31);
      return series.filter(([d]) => new Date(d) >= cut);
    }
    const jan1 = `${last.getUTCFullYear()}-01-01`;
    let start = series.findIndex(([d]) => d >= jan1);
    if (start > 0) start -= 1;
    return series.slice(Math.max(0, start));
  }

  function spark(values, cls) {
    const NS = 'http://www.w3.org/2000/svg';
    const w = 84, h = 22;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
    svg.setAttribute('width', w); svg.setAttribute('height', h);
    svg.setAttribute('class', `spark ${cls || ''}`);
    svg.setAttribute('aria-hidden', 'true');
    if (!values || values.length < 2) return svg;
    const min = Math.min(...values), max = Math.max(...values), rng = (max - min) || 1;
    const pts = values.map((v, i) => `${(i / (values.length - 1) * w).toFixed(1)},${(h - 2 - (v - min) / rng * (h - 4)).toFixed(1)}`);
    const line = document.createElementNS(NS, 'polyline');
    line.setAttribute('points', pts.join(' '));
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', 'currentColor');
    line.setAttribute('stroke-width', '1.4');
    line.setAttribute('stroke-linejoin', 'round');
    svg.append(line);
    return svg;
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 4200);
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied'); }
    catch {
      const ta = el('textarea', { value: text, style: 'position:fixed;opacity:0' });
      document.body.append(ta); ta.select();
      try { document.execCommand('copy'); toast('Copied'); } catch { toast('Copy did not work in this browser'); }
      ta.remove();
    }
  }

  // ------------------------------------------------------------------
  // Theme
  // ------------------------------------------------------------------
  function themePref() { return lsGet('mp.theme', 'system'); }
  function applyTheme() {
    const pref = themePref();
    if (pref === 'light' || pref === 'dark') document.documentElement.dataset.theme = pref;
    else delete document.documentElement.dataset.theme;
  }
  function resolvedTheme() {
    const pref = themePref();
    if (pref === 'light' || pref === 'dark') return pref;
    return window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }

  // ------------------------------------------------------------------
  // TradingView widgets (free, live or near-live, no key needed)
  // ------------------------------------------------------------------
  function tvWidget(slot, name, config, creditHref) {
    slot.replaceChildren();
    const box = el('div', { class: 'tradingview-widget-container' }, el('div', { class: 'tradingview-widget-container__widget' }));
    const script = document.createElement('script');
    script.type = 'text/javascript';
    script.async = true;
    script.src = `https://s3.tradingview.com/external-embedding/embed-widget-${name}.js`;
    script.textContent = JSON.stringify(config);
    box.append(script);
    box.append(el('div', { class: 'tradingview-widget-copyright' },
      extLink(creditHref || 'https://www.tradingview.com/', 'Market data by TradingView')));
    slot.append(box);
  }

  let tapeKey = '';
  function renderTape() {
    const symbols = (S.cfg && S.cfg.tape) || [];
    const key = resolvedTheme() + JSON.stringify(symbols);
    if (key === tapeKey || !symbols.length) return;
    tapeKey = key;
    tvWidget($('#tape'), 'ticker-tape', {
      symbols, showSymbolLogo: false, isTransparent: true, displayMode: 'adaptive',
      colorTheme: resolvedTheme(), locale: 'en',
    });
  }

  // ------------------------------------------------------------------
  // Saved items (local first, synced to GitHub when connected)
  // ------------------------------------------------------------------
  function normalize(doc) {
    const d = doc && typeof doc === 'object' ? doc : {};
    return {
      articles: Array.isArray(d.articles) ? d.articles.filter((a) => a && a.url) : [],
      tickers: Array.isArray(d.tickers) ? d.tickers.filter((t) => t && t.symbol) : [],
      updated: d.updated || null,
    };
  }
  const clone = (x) => JSON.parse(JSON.stringify(x));
  function saveLocal() { lsSet('mp.saved', S.saved); }
  function syncReady() { const s = S.sync; return !!(s && s.owner && s.repo && s.token); }
  function repoGuess() {
    const host = location.hostname;
    const m = host.match(/^([^.]+)\.github\.io$/i);
    if (!m) return { owner: '', repo: '' };
    let first = location.pathname.split('/').filter(Boolean)[0] || '';
    if (first.includes('.')) first = '';
    return { owner: m[1], repo: first || `${m[1]}.github.io` };
  }
  function repoInfo() {
    const g = repoGuess();
    return { owner: S.sync.owner || g.owner, repo: S.sync.repo || g.repo, branch: S.sync.branch || 'main' };
  }

  function b64enc(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  }
  function b64dec(b64) {
    const bin = atob(String(b64).replace(/\s/g, ''));
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  }

  const gh = {
    base() {
      const { owner, repo } = repoInfo();
      return `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    },
    async req(path, opts = {}) {
      const res = await fetch(this.base() + path, {
        ...opts,
        cache: 'no-store',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${S.sync.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
        },
      });
      if (!res.ok) {
        let msg = `GitHub returned ${res.status}`;
        try { const j = await res.json(); if (j.message) msg = `${j.message} (${res.status})`; } catch { /* no body */ }
        const err = new Error(msg); err.status = res.status; throw err;
      }
      return res.status === 204 ? null : res.json();
    },
    async readSaved() {
      const { branch } = repoInfo();
      try {
        const j = await this.req(`/contents/data/saved.json?ref=${encodeURIComponent(branch)}`);
        return { sha: j.sha, doc: normalize(JSON.parse(b64dec(j.content))) };
      } catch (e) {
        if (e.status === 404) return { sha: null, doc: normalize({}) };
        throw e;
      }
    },
    async writeSaved(doc, sha, message) {
      const { branch } = repoInfo();
      const body = { message, content: b64enc(JSON.stringify(doc, null, 2) + '\n'), branch };
      if (sha) body.sha = sha;
      return this.req('/contents/data/saved.json', { method: 'PUT', body: JSON.stringify(body) });
    },
    async dispatch() {
      const { branch } = repoInfo();
      return this.req('/actions/workflows/update.yml/dispatches', { method: 'POST', body: JSON.stringify({ ref: branch }) });
    },
  };

  function setSyncState(state, detail) {
    S.syncState = state;
    const node = $('#sync-state');
    const labels = {
      ok: 'Synced with GitHub', saving: 'Saving to GitHub…', error: 'Sync failed', local: 'Saved on this device',
    };
    node.textContent = labels[state] || '';
    node.title = detail || '';
    node.classList.toggle('warn', state === 'error');
  }

  async function applyOp(op, message) {
    S.saved = normalize(op(clone(S.saved)));
    S.saved.updated = new Date().toISOString();
    saveLocal();
    safeFill();
    if (!syncReady()) { setSyncState('local'); return; }
    setSyncState('saving');
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { sha, doc } = await gh.readSaved();
        const next = normalize(op(doc));
        next.updated = new Date().toISOString();
        await gh.writeSaved(next, sha, message);
        const changed = JSON.stringify([next.articles, next.tickers]) !== JSON.stringify([S.saved.articles, S.saved.tickers]);
        S.saved = next;
        saveLocal();
        setSyncState('ok');
        if (changed) safeFill();
        return;
      } catch (e) {
        if ((e.status === 409 || e.status === 422) && attempt < 2) continue;
        setSyncState('error', e.message);
        toast(`Saved on this device. GitHub sync failed: ${e.message}`);
        return;
      }
    }
  }

  const OPS = {
    addArticle: (a) => (d) => { if (!d.articles.some((x) => x.url === a.url)) d.articles.unshift(a); return d; },
    removeArticle: (id) => (d) => { d.articles = d.articles.filter((x) => x.id !== id); return d; },
    patchArticle: (id, patch) => (d) => { const x = d.articles.find((a) => a.id === id); if (x) Object.assign(x, patch); return d; },
    addTicker: (t) => (d) => { if (!d.tickers.some((x) => x.symbol === t.symbol)) d.tickers.push(t); return d; },
    removeTicker: (sym) => (d) => { d.tickers = d.tickers.filter((x) => x.symbol !== sym); return d; },
    patchTicker: (sym, patch) => (d) => { const x = d.tickers.find((t) => t.symbol === sym); if (x) Object.assign(x, patch); return d; },
    replace: (doc) => () => normalize(doc),
  };

  function isSaved(url) { return S.saved.articles.some((a) => a.url === url); }
  function saveArticle({ url, title }) {
    const clean = safeUrl(url);
    if (!clean) { toast('That link does not look like a web address'); return false; }
    if (isSaved(clean)) { toast('Already on your desk'); return false; }
    const id = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    applyOp(OPS.addArticle({ id, url: clean, title: title || '', note: '', follow: true, added: new Date().toISOString() }),
      `Save article: ${domain(clean)}`);
    toast(syncReady() ? 'Saved to My desk. Title and follow-up coverage arrive with the next update.' : 'Saved to My desk');
    return true;
  }
  function saveButton(story) {
    const done = isSaved(story.link);
    return el('button', {
      class: `linkish${done ? ' done' : ''}`, type: 'button', disabled: done,
      onclick: (e) => { if (saveArticle({ url: story.link, title: story.title })) { e.target.textContent = 'Saved'; e.target.classList.add('done'); e.target.disabled = true; } },
    }, done ? 'Saved' : 'Save');
  }

  // ------------------------------------------------------------------
  // Data loading
  // ------------------------------------------------------------------
  async function getJSON(path) {
    const res = await fetch(`${path}?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${path} (${res.status})`);
    return res.json();
  }

  async function loadData() {
    const files = {
      latest: 'data/latest.json', top: 'data/top.json', ind: 'data/indicators.json',
      firms: 'data/firm_watch.json', watch: 'data/watchlist.json', meta: 'data/saved_meta.json',
    };
    const results = await Promise.allSettled(Object.entries(files).map(async ([k, p]) => [k, await getJSON(p)]));
    for (const r of results) if (r.status === 'fulfilled') S[r.value[0]] = r.value[1];
    const ids = new Set(((S.latest && S.latest.items) || []).map((i) => i.id));
    if (S.seenIds) for (const id of ids) if (!S.seenIds.has(id)) S.freshIds.add(id);
    S.seenIds = ids;
  }

  // Note boxes live inside lists that get redrawn, so never redraw while one has focus.
  function userIsEditing() {
    const a = document.activeElement;
    return !!a && a.tagName === 'TEXTAREA' && $('#main').contains(a);
  }
  let pendingFill = false;
  function safeFill() {
    if (userIsEditing()) pendingFill = true;
    else fillView();
  }

  async function refresh() {
    await loadData();
    renderStatus();
    safeFill();
  }

  // ------------------------------------------------------------------
  // Header
  // ------------------------------------------------------------------
  function renderStatus() {
    const node = $('#status');
    const u = S.latest && S.latest.updated;
    if (!u) { node.textContent = 'Waiting for the first update'; return; }
    const mins = (Date.now() - Date.parse(u)) / 60000;
    node.textContent = `Updated ${ago(u)}`;
    node.classList.toggle('warn', mins > 75);
    const st = S.latest.status;
    node.title = mins > 75
      ? 'The updater has not run recently. Check the Actions tab of your GitHub repo.'
      : st ? `${st.sources_ok} of ${st.sources_total} news sources responded` : '';
    if (!S.syncState) setSyncState(syncReady() ? 'ok' : 'local');
  }

  function renderNav() {
    document.querySelectorAll('.tabs a').forEach((a) => {
      if (a.dataset.view === S.view) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }

  function actionsUrl() {
    const { owner, repo } = repoInfo();
    return owner && repo ? `https://github.com/${owner}/${repo}/actions/workflows/update.yml` : null;
  }
  function emptyData(msg) {
    const url = actionsUrl();
    return el('p', { class: 'empty' }, msg || 'No data yet. The first update runs within about 20 minutes of setup. ',
      url ? ['To run it now, open ', extLink(url, 'the workflow on GitHub'), ' and choose Run workflow.'] : 'To run it now, open the Actions tab of your repo and choose Run workflow.');
  }

  // ------------------------------------------------------------------
  // View mounting. mountView builds the skeleton (forms, widgets) once;
  // fillView refreshes the data-driven parts without touching widgets.
  // ------------------------------------------------------------------
  let mountedKey = '';
  const slots = {};

  function render(force) {
    renderNav();
    const key = `${S.view}|${resolvedTheme()}`;
    if (force || key !== mountedKey) { mountView(); mountedKey = key; }
    fillView();
    renderStatus();
    renderTape();
  }

  function mountView() {
    const main = $('#main');
    main.replaceChildren();
    for (const k of Object.keys(slots)) delete slots[k];
    const v = S.view;
    if (PERIODS[v]) mountPeriod(main, v);
    else if (v === 'live') mountLive(main);
    else if (v === 'desk') mountDesk(main);
    else if (v === 'recruit') mountRecruit(main);
  }

  function fillView() {
    const v = S.view;
    if (PERIODS[v]) fillPeriod(v);
    else if (v === 'live') fillLive();
    else if (v === 'desk') fillDesk();
    else if (v === 'recruit') fillRecruit();
  }

  // ---------- Period views (Today, Week, Month, Year) ----------
  function briefBlock(title, text, extraClass) {
    return el('section', { class: `brief ${extraClass || ''}`, 'aria-label': title },
      el('div', { class: 'brief-head' },
        el('h2', { class: 'brief-title' }, title),
        text ? el('button', { class: 'linkish', type: 'button', onclick: () => copyText(text) }, 'Copy') : null),
      text ? el('p', { class: 'brief-text' }, text)
        : el('p', { class: 'brief-empty' }, 'The brief appears after the first update with market data.'));
  }

  function mountPeriod(main, p) {
    slots.brief = el('div');
    slots.chips = el('div', { class: 'chips', role: 'group', 'aria-label': 'Filter by theme' });
    slots.list = el('div');
    slots.coverage = el('p', { class: 'section-note' });
    slots.ind = el('div', { class: 'panel' });
    slots.macro = el('div', { class: 'panel' });
    const side = el('aside', { 'aria-label': 'Key indicators' }, slots.ind, slots.macro);
    if (p === 'week' || p === 'day') {
      const cal = el('div', { class: 'widget-slot' });
      side.append(el('div', { class: 'panel' },
        el('h2', { class: 'section' }, 'Economic calendar'),
        el('p', { class: 'section-note' }, 'US releases, medium and high importance. Live from TradingView.'), cal));
      tvWidget(cal, 'events', {
        colorTheme: resolvedTheme(), isTransparent: true, width: '100%', height: 460, locale: 'en',
        importanceFilter: '0,1', countryFilter: 'us',
      }, 'https://www.tradingview.com/economic-calendar/');
    }
    main.append(
      slots.brief,
      el('div', { class: 'cols' },
        el('section', { 'aria-label': PERIODS[p].top },
          el('h2', { class: 'section' }, PERIODS[p].top), slots.coverage, slots.chips, slots.list),
        side));
  }

  function filteredStories(list, view) {
    const f = S.filters[view] || 'All';
    return f === 'All' ? list : list.filter((s) => s.theme === f || (s.tags || []).includes(f));
  }

  function renderChips(list, view) {
    const counts = {};
    for (const s of list) if (s.theme && s.theme !== 'General') counts[s.theme] = (counts[s.theme] || 0) + 1;
    const themes = Object.entries(counts).sort((a, b) => b[1] - a[1]);
    const current = S.filters[view] || 'All';
    if (current !== 'All' && !counts[current]) S.filters[view] = 'All';
    const chip = (name, n) => el('button', {
      class: 'chip', type: 'button', 'aria-pressed': String((S.filters[view] || 'All') === name),
      onclick: () => { S.filters[view] = name; fillView(); },
    }, name, n != null ? el('span', { class: 'n' }, n) : null);
    slots.chips.replaceChildren(...(themes.length ? [chip('All'), ...themes.map(([t, n]) => chip(t, n))] : []));
  }

  function storyItem(s, i, p) {
    const meta = [el('span', { class: 'src' }, s.source)];
    const others = (s.sources || []).length - 1;
    if (others > 0) meta.push(el('span', null, `and ${others} other outlet${others > 1 ? 's' : ''}`));
    if (p === 'day') meta.push(el('span', null, ago(s.updated || s.published)));
    else {
      meta.push(el('span', null, fmtDay(s.date || s.published)));
      if (s.days > 1) meta.push(el('span', null, `in the news ${s.days} days`));
    }
    if (s.theme && s.theme !== 'General') meta.push(el('span', { class: 'theme' }, s.theme));
    meta.push(saveButton(s));
    const alts = (s.alts || []).length
      ? el('details', { class: 'alts' },
        el('summary', null, 'Other coverage'),
        el('ul', null, s.alts.map((a) => el('li', null, extLink(a.link, a.title), ' ', el('span', { class: 'by' }, a.source)))))
      : null;
    return el('li', { class: `story${i < 3 ? ' lead' : ''}` },
      el('span', { class: 'rank', 'aria-hidden': 'true' }, String(i + 1)),
      el('div', null,
        extLink(s.link, s.title, 'headline'),
        i < 5 && s.summary ? el('p', { class: 'summary' }, s.summary) : null,
        el('div', { class: 'meta' }, meta),
        alts));
  }

  function indicatorTable(p) {
    const key = PERIODS[p].key;
    const groups = (S.ind && S.ind.groups) || [];
    if (!groups.length) return [el('h2', { class: 'section' }, 'Key indicators'), emptyData('Indicators appear after the first update. ')];
    const table = el('table', { class: 'ledger' }, el('caption', null, `Key indicators, ${PERIODS[p].table}`));
    const newest = groups.flatMap((g) => g.items.map((r) => r.asof)).sort().pop();
    for (const g of groups) {
      const body = el('tbody', null, el('tr', null, el('th', { class: 'group', colspan: 4, scope: 'colgroup' }, g.name)));
      for (const r of g.items) {
        const c = fmtChange(r, key);
        const vals = sliceSeries(r.series, p).map((x) => x[1]);
        body.append(el('tr', null,
          el('td', { class: 'name', title: `Latest data ${fmtDay(r.asof)}, from ${r.source}` }, r.name,
            r.asof < newest ? el('span', { class: 'asof' }, `as of ${fmtDay(r.asof)}`) : null),
          el('td', { class: 'num' }, fmtLast(r)),
          el('td', { class: `num ${c.cls}` }, c.text),
          el('td', { class: `spark ${c.cls}` }, spark(vals, c.cls))));
      }
      table.append(body);
    }
    return [el('div', { class: 'ledger-wrap' }, table),
      el('p', { class: 'section-note', style: 'margin:.6rem 0 0' }, 'Sources: Yahoo Finance and FRED. Rows marked “as of” update with a lag. Sparklines show the period.')];
  }

  function fmtMacro(m) {
    if (m.unit === '%') return `${m.value.toFixed(1)}%`;
    if (m.unit === 'k') return `${signed(m.value, 0, 'k')}`;
    return m.value.toFixed(1);
  }
  function macroAsOf(m) {
    if (!m.asof) return '';
    if (m.id === 'gdp') { const d = new Date(`${m.asof}T00:00:00Z`); return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`; }
    if (m.id === 'fedtarget') return fmtDay(m.asof);
    return monthFmt.format(new Date(`${m.asof}T00:00:00Z`));
  }
  function macroBlock() {
    const macro = (S.ind && S.ind.macro) || [];
    if (!macro.length) return [];
    return [
      el('h2', { class: 'section' }, 'Latest economic data'),
      el('p', { class: 'section-note' }, 'Most recent official release from FRED, with the prior reading.'),
      el('ul', { class: 'macro' }, macro.map((m) => el('li', null,
        el('span', null, m.name),
        el('span', { class: 'val' }, fmtMacro(m)),
        el('span', { class: 'sub' }, `${macroAsOf(m)}, prior ${fmtMacro({ ...m, value: m.prev })}`)))),
    ];
  }

  function fillPeriod(p) {
    const brief = S.ind && S.ind.briefs && S.ind.briefs[p];
    slots.brief.replaceChildren(briefBlock(PERIODS[p].brief, brief));
    const list = (S.top && S.top.periods && S.top.periods[p]) || [];
    renderChips(list, p);
    const shown = filteredStories(list, p);
    const cov = S.top && S.top.coverage;
    const note = p === 'day'
      ? 'Ranked by how many outlets cover a story, how authoritative they are, and recency.'
      : `Ranked by coverage across outlets and how many days a story stayed in the news.${cov && cov.first_day ? ` History starts ${fmtDay(cov.first_day)}.` : ''}`;
    slots.coverage.textContent = note;
    if (!list.length) slots.list.replaceChildren(emptyData());
    else if (!shown.length) slots.list.replaceChildren(el('p', { class: 'empty' }, 'Nothing in this theme for this period.'));
    else slots.list.replaceChildren(el('ol', { class: 'stories' }, shown.map((s, i) => storyItem(s, i, p))));
    slots.ind.replaceChildren(...indicatorTable(p));
    const mb = macroBlock();
    slots.macro.hidden = !mb.length;
    slots.macro.replaceChildren(...mb);
  }

  // ---------- Live ----------
  function mountLive(main) {
    slots.head = el('p', { class: 'section-note' });
    slots.chips = el('div', { class: 'chips', role: 'group', 'aria-label': 'Filter by theme' });
    slots.list = el('div');
    const tv = el('div', { class: 'widget-slot' });
    main.append(el('div', { class: 'cols', style: 'margin-top:2rem' },
      el('section', { 'aria-label': 'Running feed' },
        el('h2', { class: 'section' }, 'Running feed'), slots.head, slots.chips, slots.list),
      el('aside', { class: 'panel' },
        el('h2', { class: 'section' }, 'Live headlines'),
        el('p', { class: 'section-note' }, 'Streams continuously from TradingView, between our 20-minute updates.'), tv)));
    tvWidget(tv, 'timeline', {
      feedMode: 'all_symbols', isTransparent: true, displayMode: 'regular', width: '100%', height: 900,
      colorTheme: resolvedTheme(), locale: 'en',
    }, 'https://www.tradingview.com/news/');
  }

  function bucketFor(iso) {
    const t = new Date(iso);
    const now = new Date();
    const mins = (now - t) / 60000;
    if (mins < 60) return 'Past hour';
    const sameDay = t.toDateString() === now.toDateString();
    if (sameDay) return 'Earlier today';
    const y = new Date(now); y.setDate(now.getDate() - 1);
    if (t.toDateString() === y.toDateString()) return 'Yesterday';
    return dateFmt.format(t);
  }

  function fillLive() {
    const items = (S.latest && S.latest.items) || [];
    const st = S.latest && S.latest.status;
    slots.head.textContent = `Newest first. Checks for new stories every 2 minutes.${st ? ` ${st.sources_ok} of ${st.sources_total} sources responded on the last update.` : ''}`;
    renderChips(items, 'live');
    const shown = filteredStories(items, 'live');
    if (!items.length) { slots.list.replaceChildren(emptyData()); return; }
    if (!shown.length) { slots.list.replaceChildren(el('p', { class: 'empty' }, 'Nothing in this theme right now.')); return; }
    const groups = new Map();
    for (const it of shown) {
      const b = bucketFor(it.published);
      if (!groups.has(b)) groups.set(b, []);
      groups.get(b).push(it);
    }
    const out = [];
    for (const [name, list] of groups) {
      out.push(el('div', { class: 'feed-group' },
        el('h3', null, name),
        el('ul', { class: 'feed' }, list.map((it) => el('li', { class: S.freshIds.has(it.id) ? 'fresh' : '' },
          el('time', { datetime: it.published }, timeFmt.format(new Date(it.published))),
          el('div', null,
            extLink(it.link, it.title, 'headline'),
            el('div', { class: 'meta' },
              el('span', { class: 'src' }, it.source),
              it.outlets > 1 ? el('span', null, `${it.outlets} outlets on this story`) : null,
              it.theme && it.theme !== 'General' ? el('span', { class: 'theme' }, it.theme) : null,
              saveButton(it))))))));
    }
    slots.list.replaceChildren(...out);
  }

  // ---------- My desk ----------
  function mountDesk(main) {
    slots.banner = el('div');
    // Article form
    const url = el('input', { type: 'url', name: 'url', placeholder: 'Paste a link to any article', required: true, autocomplete: 'off' });
    const note = el('input', { type: 'text', name: 'note', placeholder: 'Optional: why it matters for a client', autocomplete: 'off' });
    const follow = el('input', { type: 'checkbox', checked: true });
    const artForm = el('form', {
      class: 'add-form',
      onsubmit: (e) => {
        e.preventDefault();
        const clean = safeUrl(url.value.trim());
        if (!clean) { toast('Paste a full link starting with https://'); return; }
        if (isSaved(clean)) { toast('Already on your desk'); return; }
        const id = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
        applyOp(OPS.addArticle({ id, url: clean, title: '', note: note.value.trim(), follow: follow.checked, added: new Date().toISOString() }),
          `Save article: ${domain(clean)}`);
        toast(syncReady() ? 'Saved. Title and follow-up coverage arrive with the next update.' : 'Saved on this device');
        url.value = ''; note.value = '';
      },
    },
    el('div', { class: 'inline' }, el('label', null, 'Article link', url), el('button', { class: 'btn', type: 'submit' }, 'Save article')),
    el('label', null, 'Note', note),
    el('label', { class: 'check' }, follow, 'Track follow-up coverage of this story'));

    // Ticker form
    const sym = el('input', { type: 'text', placeholder: 'Ticker, for example JPM or NYSE:JPM', autocomplete: 'off', spellcheck: 'false' });
    const company = el('input', { type: 'text', placeholder: 'Optional: company name for news search', autocomplete: 'off' });
    const tickForm = el('form', {
      class: 'add-form',
      onsubmit: (e) => {
        e.preventDefault();
        const s = sym.value.trim().toUpperCase().replace(/\s+/g, '');
        if (!/^[A-Z0-9._\-=^:]{1,24}$/.test(s)) { toast('Enter a ticker like JPM or NYSE:JPM'); return; }
        if (S.saved.tickers.some((t) => t.symbol === s)) { toast('Already on your watchlist'); return; }
        applyOp(OPS.addTicker({ symbol: s, query: company.value.trim(), note: '', added: new Date().toISOString() }), `Watch ${s}`);
        sym.value = ''; company.value = '';
      },
    },
    el('div', { class: 'inline' }, el('label', null, 'Ticker', sym), el('button', { class: 'btn', type: 'submit' }, 'Add to watchlist')),
    el('label', null, 'Company name', company));

    slots.articles = el('div');
    slots.quotes = el('div', { class: 'widget-slot' });
    slots.watch = el('div');
    slots.quotesKey = '';
    main.append(slots.banner, el('div', { class: 'desk' },
      el('section', { 'aria-label': 'Saved articles' },
        el('h2', { class: 'section' }, 'Saved articles'),
        el('p', { class: 'section-note' }, 'Save stories you want to bring up in interviews and coffee chats. Tracked stories show new coverage from the past week.'),
        artForm, slots.articles),
      el('section', { 'aria-label': 'Watchlist' },
        el('h2', { class: 'section' }, 'Watchlist'),
        el('p', { class: 'section-note' }, 'Live quotes from TradingView. Period changes and headlines refresh with each update.'),
        tickForm, slots.quotes, slots.watch)));
  }

  function fillDesk() {
    // Banner about sync
    if (!syncReady()) {
      slots.banner.replaceChildren(el('div', { class: 'banner' },
        el('p', null, 'Your saved items live in this browser only. Connect GitHub to sync them across your laptop and phone, and to let the updater fetch titles, follow-up coverage and ticker headlines.'),
        el('button', { class: 'btn', type: 'button', onclick: openSettings }, 'Connect GitHub')));
    } else slots.banner.replaceChildren();

    // Articles
    const metaArts = (S.meta && S.meta.articles) || {};
    const arts = S.saved.articles;
    if (!arts.length) {
      slots.articles.replaceChildren(el('p', { class: 'empty' }, 'Nothing saved yet. Paste a link above, or press Save next to any story in the other tabs.'));
    } else {
      slots.articles.replaceChildren(el('ul', { class: 'saved-list' }, arts.map((a) => {
        const m = metaArts[a.id] || {};
        const title = a.title || m.title || slugTitle(a.url) || domain(a.url);
        const noteBox = el('textarea', { rows: 2, placeholder: 'Why it matters for a client, or a question to ask', value: a.note || '' });
        noteBox.addEventListener('blur', () => setTimeout(() => {
          if (noteBox.value !== (a.note || '')) applyOp(OPS.patchArticle(a.id, { note: noteBox.value }), 'Update note');
        }, 0));
        const related = (m.related || []).slice(0, 4);
        return el('li', { class: 'saved-item' },
          extLink(a.url, title, 'headline'),
          el('div', { class: 'meta' },
            el('span', { class: 'src' }, m.site || domain(a.url)),
            el('span', null, `saved ${fmtDay(a.added)}`),
            m.error && !a.title && !m.title ? el('span', { class: 'muted' }, 'title unavailable (paywall)') : null),
          m.description ? el('p', { class: 'desc' }, m.description) : null,
          noteBox,
          a.follow !== false && related.length
            ? el('ul', { class: 'followups', 'aria-label': 'Follow-up coverage' }, related.map((r) => el('li', null,
              extLink(r.link, r.title), ' ', el('span', { class: 'by' }, `${r.source}, ${fmtDay(r.published)}`))))
            : null,
          el('div', { class: 'item-actions' },
            el('label', { class: 'check' },
              el('input', {
                type: 'checkbox', checked: a.follow !== false,
                onchange: (e) => applyOp(OPS.patchArticle(a.id, { follow: e.target.checked }), 'Update tracking'),
              }), 'Track follow-up coverage'),
            el('button', {
              class: 'linkish', type: 'button',
              onclick: () => applyOp(OPS.removeArticle(a.id), `Remove article: ${domain(a.url)}`),
            }, 'Remove')));
      })));
    }

    // Live quotes widget, rebuilt only when the ticker list changes
    const tickers = S.saved.tickers;
    const qKey = tickers.map((t) => t.symbol).join(',');
    if (qKey !== slots.quotesKey) {
      slots.quotesKey = qKey;
      if (tickers.length) {
        tvWidget(slots.quotes, 'market-quotes', {
          width: '100%', height: Math.min(90 + tickers.length * 46, 560),
          symbolsGroups: [{ name: 'Watchlist', symbols: tickers.map((t) => ({ name: t.symbol, displayName: t.symbol.split(':').pop() })) }],
          showSymbolLogo: true, isTransparent: true, colorTheme: resolvedTheme(), locale: 'en',
        });
      } else slots.quotes.replaceChildren();
    }

    // Period table
    const data = {};
    for (const r of (S.watch && S.watch.tickers) || []) data[r.symbol] = r;
    if (!tickers.length) { slots.watch.replaceChildren(el('p', { class: 'empty' }, 'Add a ticker above to start a watchlist.')); return; }
    const cols = ['1D', '1W', '1M', 'YTD'];
    const body = el('tbody');
    for (const t of tickers) {
      const r = data[t.symbol] || {};
      const short = t.symbol.split(':').pop();
      const open = S.openTickers.has(t.symbol);
      body.append(el('tr', null,
        el('td', null, el('button', {
          class: 'sym', type: 'button', 'aria-expanded': String(open),
          onclick: () => { if (open) S.openTickers.delete(t.symbol); else S.openTickers.add(t.symbol); fillDesk(); },
        }, short)),
        el('td', null, r.last != null ? nf(2).format(r.last) : '–'),
        cols.map((k) => {
          const c = r.chg && r.chg[k];
          return el('td', { class: c ? signClass(c.pct) : 'flat' }, c ? signed(c.pct, 1, '%') : '–');
        }),
        el('td', { class: r.chg && r.chg['1M'] ? signClass(r.chg['1M'].pct) : 'flat' }, spark(r.spark || []))));
      if (open) {
        const news = r.news || [];
        const noteBox = el('textarea', { rows: 3, placeholder: 'Pitch notes: thesis, catalysts, risks, valuation', value: t.note || '' });
        noteBox.addEventListener('blur', () => setTimeout(() => {
          if (noteBox.value !== (t.note || '')) applyOp(OPS.patchTicker(t.symbol, { note: noteBox.value }), `Update notes for ${short}`);
        }, 0));
        body.append(el('tr', { class: 'detail' }, el('td', { colspan: 7 },
          news.length
            ? el('ul', null, news.slice(0, 5).map((n) => el('li', null, extLink(n.link, n.title), ' ', el('span', { class: 'muted' }, `${n.source}, ${ago(n.published)}`))))
            : el('p', { class: 'muted' }, syncReady() ? 'Headlines arrive with the next update.' : 'Connect GitHub to get headlines for this ticker.'),
          noteBox,
          el('div', { class: 'item-actions' },
            extLink(`https://www.tradingview.com/symbols/${t.symbol.replace(':', '-')}/`, 'Chart on TradingView'),
            el('button', { class: 'linkish', type: 'button', onclick: () => applyOp(OPS.removeTicker(t.symbol), `Stop watching ${short}`) }, 'Remove')))));
      }
    }
    const asof = S.watch && S.watch.tickers && S.watch.tickers.find((x) => x.asof);
    slots.watch.replaceChildren(
      el('div', { class: 'ledger-wrap' }, el('table', { class: 'watch' },
        el('thead', null, el('tr', null, el('th', null, 'Ticker'), el('th', null, 'Last'), cols.map((c) => el('th', null, c)), el('th', null, '30 days'))),
        body)),
      el('p', { class: 'section-note', style: 'margin-top:.5rem' },
        asof ? `Closing and intraday prices as of the last update (${fmtDay(asof.asof)}). Click a ticker for headlines and pitch notes.` : 'Click a ticker for headlines and pitch notes.'));
  }

  // ---------- Recruiting ----------
  function mountRecruit(main) {
    slots.briefs = el('div', { class: 'brief-pair' });
    slots.angles = el('dl', { class: 'angles' });
    slots.firms = el('div', { class: 'firms' });
    const q = (text, hint, href, label) => el('li', null, el('span', { class: 'q' }, text),
      el('span', { class: 'hint' }, hint, ' ', href ? el('a', { href, class: 'linkish' }, label) : null));
    main.append(el('div', { class: 'recruit' },
      el('section', null,
        el('h2', { class: 'section' }, 'Walk me through the markets'),
        el('p', { class: 'section-note' }, 'The most common opener in private banking interviews. Read these out loud, then say it again in your own words.'),
        slots.briefs),
      el('section', null,
        el('h2', { class: 'section' }, 'Client conversation starters'),
        el('p', { class: 'section-note' }, 'What this week’s moves could mean for a wealthy family’s portfolio. Generated from the indicators and headlines; treat them as prompts to research further.'),
        slots.angles),
      el('section', null,
        el('h2', { class: 'section' }, 'Firm watch'),
        el('p', { class: 'section-note' }, 'Recent news on the firms you are recruiting at, refreshed hourly. Skim before a networking call.'),
        slots.firms),
      el('section', null,
        el('h2', { class: 'section' }, 'Practice questions'),
        el('ol', { class: 'questions' },
          q('Walk me through what happened in markets this week.', 'Start from the weekly brief, then add one story you find interesting.', '#week', 'Open the week'),
          q('Pitch me a stock.', 'Pick one name from your watchlist and keep thesis, catalysts, risks and valuation in its notes.', '#desk', 'Open your watchlist'),
          q('A founder just sold her company for $40 million. What would you talk to her about?', 'Think liquidity planning, taxes, concentrated stock, estate planning and family goals.', null),
          q('Where do you think rates are heading, and what does that mean for a client’s bonds?', 'Use the rates rows in the indicators and the Fed & rates filter.', '#month', 'Open the month'),
          q('What has our firm done recently that caught your attention?', 'Use Firm watch above, and save one story to your desk with a note.', null),
          q('Tell me about a story you have been following.', 'Use a saved article with follow-up coverage so you can describe how it developed.', '#desk', 'Open saved articles')))));
  }

  function fillRecruit() {
    const briefs = (S.ind && S.ind.briefs) || {};
    slots.briefs.replaceChildren(briefBlock('Today', briefs.day), briefBlock('This week', briefs.week));
    const angles = (S.ind && S.ind.angles && S.ind.angles.week) || [];
    slots.angles.replaceChildren(...(angles.length
      ? angles.map((a) => el('div', null, el('dt', null, a.title), el('dd', null, a.body)))
      : [emptyData('Conversation starters appear after the first update. ')]));
    const firms = (S.firms && S.firms.firms) || [];
    slots.firms.replaceChildren(...(firms.length
      ? firms.map((f) => el('div', { class: 'firm' },
        el('h3', null, f.name),
        f.items.length
          ? el('ul', null, f.items.slice(0, 5).map((n) => el('li', null, extLink(n.link, n.title), el('span', { class: 'by' }, `${n.source}, ${fmtDay(n.published)}`))))
          : el('p', { class: 'muted' }, 'No coverage in the past two weeks.')))
      : [emptyData('Firm watch appears after the first update. ')]));
  }

  // ------------------------------------------------------------------
  // Settings dialog
  // ------------------------------------------------------------------
  function openSettings() {
    const form = $('#settings-form');
    const g = repoGuess();
    form.owner.value = S.sync.owner || g.owner;
    form.repo.value = S.sync.repo || g.repo;
    form.branch.value = S.sync.branch || 'main';
    form.token.value = S.sync.token || '';
    const pref = themePref();
    form.querySelectorAll('input[name="theme"]').forEach((r) => { r.checked = r.value === pref; });
    $('#sync-result').textContent = '';
    $('#settings').showModal();
  }

  async function saveSync() {
    const form = $('#settings-form');
    const out = $('#sync-result');
    S.sync = {
      owner: form.owner.value.trim(), repo: form.repo.value.trim(),
      branch: form.branch.value.trim() || 'main', token: form.token.value.trim(),
    };
    if (!syncReady()) { out.textContent = 'Fill in owner, repository and token.'; return; }
    lsSet('mp.sync', S.sync);
    out.textContent = 'Testing…';
    try {
      const remote = await gh.readSaved();
      // Merge anything saved locally before syncing was set up
      const merged = normalize(remote.doc);
      for (const a of S.saved.articles) if (!merged.articles.some((x) => x.url === a.url)) merged.articles.push(a);
      for (const t of S.saved.tickers) if (!merged.tickers.some((x) => x.symbol === t.symbol)) merged.tickers.push(t);
      const needsWrite = merged.articles.length !== remote.doc.articles.length || merged.tickers.length !== remote.doc.tickers.length;
      S.saved = merged; saveLocal();
      if (needsWrite) await applyOp(OPS.replace(merged), 'Merge saved items from this device');
      setSyncState('ok');
      out.textContent = 'Connected. Your saved items now sync through GitHub.';
      fillView();
    } catch (e) {
      setSyncState('error', e.message);
      out.textContent = e.status === 401 ? 'GitHub rejected the token. Check that it was copied fully and has not expired.'
        : e.status === 404 ? 'Repository not found. Check the owner and repository names, and that the token can access this repo.'
          : `Could not connect: ${e.message}`;
    }
  }

  function wireSettings() {
    $('#btn-settings').addEventListener('click', openSettings);
    $('#btn-sync-save').addEventListener('click', saveSync);
    $('#btn-sync-clear').addEventListener('click', () => {
      S.sync = {}; lsSet('mp.sync', {}); setSyncState('local');
      $('#sync-result').textContent = 'Disconnected. Saved items stay on this device.';
      const f = $('#settings-form'); f.token.value = '';
      fillView();
    });
    $('#btn-export').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(S.saved, null, 2)], { type: 'application/json' });
      const a = el('a', { href: URL.createObjectURL(blob), download: `market-pulse-saved-${new Date().toISOString().slice(0, 10)}.json` });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    });
    $('#import-file').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      try {
        const doc = normalize(JSON.parse(await file.text()));
        if (!window.confirm(`Replace your saved items with ${doc.articles.length} articles and ${doc.tickers.length} tickers from this file?`)) return;
        await applyOp(OPS.replace(doc), 'Import saved items');
        toast('Imported');
      } catch { toast('That file is not a Market Pulse backup'); }
      e.target.value = '';
    });
    $('#settings-form').addEventListener('change', (e) => {
      if (e.target.name === 'theme') {
        lsSet('mp.theme', e.target.value);
        applyTheme();
        tapeKey = '';
        render(true);
      }
    });
    $('#btn-refresh').addEventListener('click', async () => {
      const btn = $('#btn-refresh');
      if (syncReady()) {
        btn.disabled = true;
        try {
          await gh.dispatch();
          toast('Update started on GitHub. New data in about two minutes.');
          let n = 0;
          const iv = setInterval(async () => { await refresh(); if (++n >= 6) clearInterval(iv); }, 30000);
        } catch (e) {
          toast(e.status === 403 || e.status === 404
            ? 'The token needs Actions: read and write permission to start updates.'
            : `Could not start the update: ${e.message}`);
        } finally { btn.disabled = false; }
      } else {
        const url = actionsUrl();
        if (url) { window.open(url, '_blank', 'noopener'); toast('On GitHub, choose Run workflow. Or connect GitHub in Settings to do it from here.'); }
        else toast('Connect GitHub in Settings to start updates from here.');
      }
      refresh();
    });
  }

  // ------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------
  function route() {
    const v = location.hash.slice(1);
    S.view = VIEWS.includes(v) ? v : 'day';
  }

  async function init() {
    applyTheme();
    route();
    wireSettings();
    window.addEventListener('hashchange', () => { route(); render(); window.scrollTo(0, 0); });
    if (window.matchMedia) {
      matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (themePref() === 'system') { tapeKey = ''; render(true); } });
    }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
    $('#main').addEventListener('focusout', () => setTimeout(() => {
      if (pendingFill && !userIsEditing()) { pendingFill = false; fillView(); }
    }, 50));

    const local = lsGet('mp.saved', null);
    if (local) S.saved = normalize(local);
    try { S.cfg = await getJSON('config.json'); } catch { S.cfg = {}; }
    await loadData();

    if (syncReady()) {
      try { S.saved = (await gh.readSaved()).doc; saveLocal(); setSyncState('ok'); }
      catch (e) { setSyncState('error', e.message); }
    } else {
      if (!local) { try { S.saved = normalize(await getJSON('data/saved.json')); saveLocal(); } catch { /* first run */ } }
      setSyncState('local');
    }
    render(true);
    setInterval(refresh, POLL_MS);
  }

  init();
})();
