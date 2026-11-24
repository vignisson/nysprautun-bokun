// Nýsprautun tímabókanir — starfsmannaviðmót
// Allir tímar eru í íslenskum tíma = UTC (engin sumartímabreyting), því notum við UTC-föll Date alls staðar.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.4';

// ======================================================================
// Hjálparföll
// ======================================================================
const $ = (sel, el = document) => el.querySelector(sel);
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && k !== 'list' && k !== 'form') { try { el[k] = v; } catch { el.setAttribute(k, v); } }
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const DAY_MS = 864e5;
const WD_SHORT = ['sun', 'mán', 'þri', 'mið', 'fim', 'fös', 'lau'];
const WD_LONG = ['Sunnudagur', 'Mánudagur', 'Þriðjudagur', 'Miðvikudagur', 'Fimmtudagur', 'Föstudagur', 'Laugardagur'];
const MON = ['jan', 'feb', 'mar', 'apr', 'maí', 'jún', 'júl', 'ágú', 'sep', 'okt', 'nóv', 'des'];
const MON_LONG = ['janúar', 'febrúar', 'mars', 'apríl', 'maí', 'júní', 'júlí', 'ágúst', 'september', 'október', 'nóvember', 'desember'];
const STATUS = { booked: 'Bókað', in_progress: 'Í vinnslu', ready: 'Tilbúinn', picked_up: 'Sóttur', no_show: 'Mætti ekki', cancelled: 'Afbókað' };

const day0 = (d) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
const addDays = (d, n) => new Date(d.getTime() + n * DAY_MS);
const ymd = (d) => d.toISOString().slice(0, 10);
const parseYmd = (s) => new Date(s + 'T00:00:00Z');
const isoWd = (d) => ((d.getUTCDay() + 6) % 7) + 1; // 1=mán … 7=sun
const mondayOf = (d) => addDays(day0(d), -(isoWd(d) - 1));
const today = () => day0(new Date());
const pad = (n) => String(n).padStart(2, '0');
const hm = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;
const tmin = (t) => { const [a, b] = String(t).split(':'); return +a * 60 + +b; };
const minOf = (d) => d.getUTCHours() * 60 + d.getUTCMinutes();
const fmtDay = (d) => `${WD_SHORT[d.getUTCDay()]} ${d.getUTCDate()}. ${MON[d.getUTCMonth()]}`;
const fmtLong = (d) => `${WD_LONG[d.getUTCDay()]} ${d.getUTCDate()}. ${MON_LONG[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
const fmtDT = (iso) => { const d = new Date(iso); return `${fmtDay(d)} kl. ${hm(minOf(d))}`; };
const normPlate = (p) => String(p || '').toUpperCase().replace(/[^A-Z0-9ÁÐÉÍÓÚÝÞÆÖ]/g, '');

const store = {
  get(k, d) { try { const v = localStorage.getItem('nys.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('nys.' + k, JSON.stringify(v)); } catch {} },
};

function toast(msg, bad = false) {
  const t = h('div', { class: 'toast' + (bad ? ' bad' : '') }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), bad ? 6000 : 3200);
}
function errText(e) {
  const m = e?.message || String(e);
  if (m.includes('BLOCKED:')) return `Ekki hægt að bóka á lokaðan tíma (${m.split('BLOCKED:')[1].trim()}).`;
  if (m.includes('OVERLAP:')) return 'Tíminn skarast við aðra bókun á lyftunni.';
  if (m.includes('row-level security')) return 'Þú hefur ekki heimild til þess.';
  return m;
}

// ======================================================================
// Ástand
// ======================================================================
const S = {
  sb: null, session: null, me: null,
  settings: null, lifts: [], services: [], hours: [], blocked: [],
  bookings: [], notes: [], requests: [], profiles: [],
  view: store.get('view', 'lifts'),       // 'lifts' = allar lyftur einn dag, 'lift' = ein lyfta
  range: store.get('range', 5),            // 1, 3, 5, 7, 14, 'month'
  liftId: store.get('liftId', null),
  date: today(),
  ppm: store.get('ppm', 1.1),              // pixlar á mínútu
  showRequests: false,
  outlook: false,
};

// ======================================================================
// Ræsing
// ======================================================================
async function boot() {
  const cfg = await fetch('/api/config').then((r) => r.json());
  S.outlook = cfg.outlook;
  S.sb = createClient(cfg.supabaseUrl, cfg.anonKey, { auth: { persistSession: true, detectSessionInUrl: true } });
  const needsPassword = /type=(invite|recovery)/.test(location.hash);
  const { data } = await S.sb.auth.getSession();
  S.session = data.session;
  S.sb.auth.onAuthStateChange((ev, session) => {
    S.session = session;
    if (ev === 'PASSWORD_RECOVERY') renderSetPassword();
    if (ev === 'SIGNED_OUT') renderLogin();
  });
  if (!S.session) return renderLogin();
  if (needsPassword) return renderSetPassword();
  await start();
}

async function start() {
  const { data: me } = await S.sb.from('profiles').select('*').eq('id', S.session.user.id).maybeSingle();
  if (!me || !me.active) {
    $('#app').replaceChildren(h('div', { class: 'login' }, h('form', {},
      h('h1', {}, 'Aðgangur ekki virkur'),
      h('p', { class: 'muted' }, 'Stjórnandi þarf að virkja aðganginn þinn.'),
      h('button', { class: 'btn', type: 'button', onclick: () => S.sb.auth.signOut() }, 'Skrá út'))));
    return;
  }
  S.me = me;
  await loadStatic();
  if (!S.liftId || !S.lifts.find((l) => l.id === S.liftId)) S.liftId = S.lifts[0]?.id;
  renderShell();
  await reload();
  subscribe();
  setInterval(() => drawNowLine(), 60e3);
}

async function loadStatic() {
  const [st, li, sv, hr, bl, rq] = await Promise.all([
    S.sb.from('settings').select('*').eq('id', 1).single(),
    S.sb.from('lifts').select('*').order('sort'),
    S.sb.from('services').select('*').order('sort'),
    S.sb.from('opening_hours').select('*').order('weekday'),
    S.sb.from('blocked_times').select('*'),
    S.sb.from('booking_requests').select('*').eq('status', 'new').order('created_at'),
  ]);
  S.settings = st.data;
  S.lifts = li.data || [];
  S.services = sv.data || [];
  S.hours = hr.data || [];
  S.blocked = bl.data || [];
  S.requests = rq.data || [];
}
const activeLifts = () => S.lifts.filter((l) => l.active);
const liftById = (id) => S.lifts.find((l) => l.id === id);
const serviceById = (id) => S.services.find((s) => s.id === id);

// ======================================================================
// Innskráning
// ======================================================================
function renderLogin() {
  const err = h('div', { class: 'err' });
  const email = h('input', { type: 'email', required: true, autocomplete: 'username' });
  const pw = h('input', { type: 'password', required: true, autocomplete: 'current-password' });
  const form = h('form', {
    onsubmit: async (e) => {
      e.preventDefault(); err.textContent = '';
      const { error } = await S.sb.auth.signInWithPassword({ email: email.value.trim(), password: pw.value });
      if (error) { err.textContent = 'Rangt netfang eða lykilorð.'; return; }
      const { data } = await S.sb.auth.getSession(); S.session = data.session; start();
    },
  },
    h('div', { class: 'brand' }, h('div', { class: 'logo' }, 'N'), h('h1', {}, 'Tímabókanir')),
    h('p', { class: 'muted', style: { margin: 0 } }, 'Nýsprautun – starfsfólk'),
    h('label', { class: 'f' }, 'Netfang', email),
    h('label', { class: 'f' }, 'Lykilorð', pw),
    err,
    h('button', { class: 'btn primary', type: 'submit' }, 'Skrá inn'),
    h('button', {
      class: 'btn ghost', type: 'button', onclick: async () => {
        if (!email.value) { err.textContent = 'Sláðu inn netfangið fyrst.'; return; }
        await S.sb.auth.resetPasswordForEmail(email.value.trim(), { redirectTo: location.origin + '/' });
        toast('Tölvupóstur með hlekk hefur verið sendur.');
      },
    }, 'Gleymt lykilorð?'));
  $('#app').replaceChildren(h('div', { class: 'login' }, form));
}

function renderSetPassword() {
  const pw = h('input', { type: 'password', minLength: 8, required: true, autocomplete: 'new-password' });
  const err = h('div', { class: 'err' });
  $('#app').replaceChildren(h('div', { class: 'login' }, h('form', {
    onsubmit: async (e) => {
      e.preventDefault();
      const { error } = await S.sb.auth.updateUser({ password: pw.value });
      if (error) { err.textContent = error.message; return; }
      history.replaceState(null, '', '/');
      toast('Lykilorð vistað.');
      start();
    },
  }, h('h1', {}, 'Veldu lykilorð'), h('label', { class: 'f' }, 'Nýtt lykilorð (minnst 8 stafir)', pw), err,
    h('button', { class: 'btn primary', type: 'submit' }, 'Vista lykilorð'))));
}

// ======================================================================
// Rammi: haus + dagatal
// ======================================================================
function renderShell() {
  $('#app').replaceChildren(
    h('div', { class: 'top', id: 'top' }),
    h('div', { class: 'cal', id: 'cal' }),
    h('div', { id: 'drawer' }));
  renderTop();
}

function visibleDays() {
  const d = S.date;
  if (S.view === 'lifts') return [d];
  switch (S.range) {
    case 1: return [d];
    case 3: return [d, addDays(d, 1), addDays(d, 2)];
    case 5: { const m = mondayOf(d); return [0, 1, 2, 3, 4].map((i) => addDays(m, i)); }
    case 7: { const m = mondayOf(d); return [0, 1, 2, 3, 4, 5, 6].map((i) => addDays(m, i)); }
    case 14: { const m = mondayOf(d); return Array.from({ length: 14 }, (_, i) => addDays(m, i)); }
    default: return [d];
  }
}
function monthGrid() {
  const first = new Date(Date.UTC(S.date.getUTCFullYear(), S.date.getUTCMonth(), 1));
  const start = mondayOf(first);
  return Array.from({ length: 42 }, (_, i) => addDays(start, i));
}
function loadRange() {
  if (S.view === 'lift' && S.range === 'month') { const g = monthGrid(); return [g[0], addDays(g[41], 1)]; }
  const days = visibleDays();
  return [days[0], addDays(days[days.length - 1], 1)];
}

function step(dir) {
  if (S.view === 'lift' && S.range === 'month') {
    S.date = new Date(Date.UTC(S.date.getUTCFullYear(), S.date.getUTCMonth() + dir, 1));
  } else {
    const n = S.view === 'lifts' ? 1 : (S.range === 5 || S.range === 7 ? 7 : S.range);
    S.date = addDays(S.date, n * dir);
  }
  reload();
}

function title() {
  if (S.view === 'lift' && S.range === 'month') return `${MON_LONG[S.date.getUTCMonth()][0].toUpperCase() + MON_LONG[S.date.getUTCMonth()].slice(1)} ${S.date.getUTCFullYear()}`;
  const days = visibleDays();
  if (days.length === 1) return fmtLong(days[0]);
  const a = days[0], b = days[days.length - 1];
  return `${a.getUTCDate()}. ${MON[a.getUTCMonth()]} – ${b.getUTCDate()}. ${MON[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
}

function renderTop() {
  const top = $('#top');
  const viewSeg = h('div', { class: 'seg' },
    h('button', { class: S.view === 'lifts' ? 'on' : '', onclick: () => { S.view = 'lifts'; store.set('view', 'lifts'); reload(); } }, 'Allar lyftur'),
    h('button', { class: S.view === 'lift' ? 'on' : '', onclick: () => { S.view = 'lift'; store.set('view', 'lift'); reload(); } }, 'Ein lyfta'));
  const liftSel = S.view === 'lift' ? h('select', {
    style: { width: 'auto' },
    onchange: (e) => { S.liftId = e.target.value; store.set('liftId', S.liftId); reload(); },
  }, activeLifts().map((l) => h('option', { value: l.id, selected: l.id === S.liftId }, l.name))) : null;
  const ranges = [[1, '1 d'], [3, '3 d'], [5, '5 d'], [7, 'Vika'], [14, '2 vikur'], ['month', 'Mánuður']];
  const rangeSeg = S.view === 'lift' ? h('div', { class: 'seg' }, ranges.map(([v, t]) =>
    h('button', { class: S.range === v ? 'on' : '', onclick: () => { S.range = v; store.set('range', v); reload(); } }, t))) : null;
  const dateInp = h('input', { type: 'date', value: ymd(S.date), style: { width: '140px' }, onchange: (e) => { if (e.target.value) { S.date = parseYmd(e.target.value); reload(); } } });
  const nReq = S.requests.length;

  top.replaceChildren(
    h('div', { class: 'brand' }, h('div', { class: 'logo' }, 'N'), h('span', {}, 'Nýsprautun')),
    viewSeg, liftSel, rangeSeg,
    h('div', { class: 'row', style: { gap: '4px' } },
      h('button', { class: 'btn', title: 'Fyrra', onclick: () => step(-1) }, '‹'),
      h('button', { class: 'btn', onclick: () => { S.date = today(); reload(); } }, 'Í dag'),
      h('button', { class: 'btn', title: 'Næsta', onclick: () => step(1) }, '›')),
    dateInp,
    h('div', { class: 'title' }, title()),
    h('div', { class: 'grow' }),
    searchBox(),
    h('button', { class: 'btn primary', onclick: () => openBooking({ start: defaultStart() }) }, '+ Bókun'),
    h('button', { class: 'btn', style: { background: 'var(--yellow)', borderColor: 'var(--yellow-b)' }, onclick: () => newNote() }, '+ Gulur miði'),
    h('button', { class: 'btn', onclick: () => { S.showRequests = !S.showRequests; renderDrawer(); } }, 'Beiðnir', nReq ? h('span', { class: 'badge' }, nReq) : null),
    userMenu());
}

function defaultStart() {
  const d = S.view === 'lift' && S.range !== 'month' ? visibleDays()[0] : S.date;
  const oh = hoursFor(d);
  return new Date(d.getTime() + (oh ? oh.open : 480) * 60e3);
}

function userMenu() {
  const dd = h('div', { class: 'dd', style: { display: 'none' } },
    h('div', { class: 'muted', style: { padding: '6px 10px', fontSize: '12px' } }, S.me.name || S.me.email),
    S.me.role === 'admin' ? h('button', { onclick: () => { close(); openSettings(); } }, 'Stillingar') : null,
    S.outlook ? h('button', { onclick: async () => { close(); await syncNow(); } }, 'Samstilla Outlook núna') : null,
    h('button', { onclick: () => { close(); zoom(1.25); } }, 'Stækka tímaás'),
    h('button', { onclick: () => { close(); zoom(0.8); } }, 'Minnka tímaás'),
    h('button', { onclick: () => { close(); window.print(); } }, 'Prenta'),
    h('button', { onclick: () => S.sb.auth.signOut() }, 'Skrá út'));
  const close = () => (dd.style.display = 'none');
  document.addEventListener('click', (e) => { if (!m.contains(e.target)) close(); });
  const m = h('div', { class: 'menu' }, h('button', { class: 'btn', onclick: () => (dd.style.display = dd.style.display === 'none' ? 'block' : 'none') }, '☰'), dd);
  return m;
}
function zoom(f) { S.ppm = Math.min(3, Math.max(0.5, S.ppm * f)); store.set('ppm', S.ppm); render(); }

async function syncNow() {
  toast('Samstilli við Outlook…');
  try {
    const r = await api('/api/staff/sync', {});
    if (r.errors?.length) toast('Outlook: ' + r.errors.join('; '), true);
    else toast(r.skipped || `Outlook: ${r.pushed} send, ${r.pulled} sótt.`);
    reload();
  } catch (e) { toast(errText(e), true); }
}

function searchBox() {
  const res = h('div', { class: 'res', style: { display: 'none' } });
  let tmr;
  const inp = h('input', {
    type: 'search', placeholder: 'Leita: bílnúmer, nafn, sími',
    oninput: () => {
      clearTimeout(tmr);
      tmr = setTimeout(async () => {
        const q = inp.value.trim();
        if (q.length < 2) { res.style.display = 'none'; return; }
        const p = normPlate(q);
        const like = `%${q.replace(/[%,()]/g, '')}%`;
        const ors = [`customer_name.ilike.${like}`, `phone.ilike.${like}`, `title.ilike.${like}`];
        if (p) ors.push(`plate.ilike.%${p}%`);
        const { data } = await S.sb.from('bookings').select('*').or(ors.join(',')).neq('status', 'cancelled').order('starts_at', { ascending: false }).limit(20);
        res.replaceChildren(...(data?.length ? data.map((b) => h('div', {
          onclick: () => { res.style.display = 'none'; inp.value = ''; S.date = day0(new Date(b.starts_at)); reload().then(() => openBooking({ booking: b })); },
        }, h('b', {}, b.plate || b.title || '—'), ' ', b.customer_name || '', h('div', { class: 'muted', style: { fontSize: '12px', padding: 0, border: 0 } }, `${fmtDT(b.starts_at)} · ${liftById(b.lift_id)?.name || ''} · ${STATUS[b.status]}`))) : [h('div', { class: 'muted' }, 'Ekkert fannst')]));
        res.style.display = 'block';
      }, 250);
    },
  });
  document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) res.style.display = 'none'; });
  const wrap = h('div', { class: 'search' }, inp, res);
  return wrap;
}

// ======================================================================
// Gögn
// ======================================================================
let reloadSeq = 0;
async function reload() {
  const seq = ++reloadSeq;
  const [from, to] = loadRange();
  let q = S.sb.from('bookings').select('*').lt('starts_at', to.toISOString()).gt('ends_at', from.toISOString()).neq('status', 'cancelled');
  if (S.view === 'lift') q = q.eq('lift_id', S.liftId);
  const [bk, nt, rq, bl] = await Promise.all([
    q,
    S.sb.from('sticky_notes').select('*').gte('day', ymd(from)).lt('day', ymd(to)),
    S.sb.from('booking_requests').select('*').eq('status', 'new').order('created_at'),
    S.sb.from('blocked_times').select('*'),
  ]);
  if (seq !== reloadSeq) return;
  if (bk.error) toast(errText(bk.error), true);
  S.bookings = bk.data || [];
  S.notes = nt.data || [];
  S.requests = rq.data || [];
  S.blocked = bl.data || [];
  renderTop();
  render();
  if (S.showRequests) renderDrawer();
}

let rtTimer;
function subscribe() {
  const bump = () => { clearTimeout(rtTimer); rtTimer = setTimeout(() => { if (!drag) reload(); }, 400); };
  S.sb.channel('nys')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'bookings' }, bump)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'sticky_notes' }, bump)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'booking_requests' }, bump)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'blocked_times' }, bump)
    .subscribe();
}

async function api(path, body) {
  const { data } = await S.sb.auth.getSession();
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${data.session?.access_token}` },
    body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || r.statusText);
  return d;
}

// ======================================================================
// Opnunartímar og lokaðir tímar
// ======================================================================
function hoursFor(d) {
  const r = S.hours.find((x) => x.weekday === isoWd(d));
  if (!r || r.closed) return null;
  return { open: tmin(r.open_time), close: tmin(r.close_time) };
}
// Lokuð bil (mínútur frá miðnætti) fyrir dag og lyftu
function blockedFor(d, liftId) {
  const out = [];
  const dayStart = d.getTime(), dayEnd = dayStart + DAY_MS;
  for (const b of S.blocked) {
    if (b.lift_id && b.lift_id !== liftId) continue;
    if (b.kind === 'weekly') {
      if (!b.weekdays?.includes(isoWd(d))) continue;
      if (b.valid_from && ymd(d) < b.valid_from) continue;
      if (b.valid_to && ymd(d) > b.valid_to) continue;
      out.push({ s: tmin(b.start_time), e: tmin(b.end_time), label: b.label });
    } else {
      const s = new Date(b.starts_at).getTime(), e = new Date(b.ends_at).getTime();
      if (s < dayEnd && e > dayStart) out.push({ s: Math.max(0, (s - dayStart) / 60e3), e: Math.min(1440, (e - dayStart) / 60e3), label: b.label });
    }
  }
  return out;
}
function isBlocked(d, liftId, s, e) {
  return blockedFor(d, liftId).find((b) => b.s < e && b.e > s);
}

// ======================================================================
// Teikning
// ======================================================================
function render() {
  const cal = $('#cal');
  const sc = cal.scrollTop;
  if (S.view === 'lift' && S.range === 'month') renderMonth(cal);
  else renderGrid(cal);
  cal.scrollTop = sc || initialScroll();
}
let scrolledOnce = false;
function initialScroll() {
  if (scrolledOnce) return 0;
  scrolledOnce = true;
  const g0 = tmin(S.settings.grid_start);
  const open = Math.min(...S.hours.filter((x) => !x.closed).map((x) => tmin(x.open_time)), 480);
  return Math.max(0, (open - g0 - 30) * S.ppm);
}

function columns() {
  if (S.view === 'lifts') {
    return activeLifts().map((l) => ({ key: l.id, date: S.date, liftId: l.id, label: l.name, color: l.color }));
  }
  return visibleDays().map((d) => ({ key: ymd(d), date: d, liftId: S.liftId, label: fmtDay(d) }));
}

function renderGrid(cal) {
  const g0 = tmin(S.settings.grid_start), g1 = tmin(S.settings.grid_end);
  const H = (g1 - g0) * S.ppm;
  const cols = columns();
  const td = ymd(today());
  cal.style.setProperty('--hour', `${60 * S.ppm}px`);

  const head = h('div', { class: 'cal-head' }, h('div', { class: 'gut' }),
    cols.map((c) => h('div', {
      class: 'ch' + (ymd(c.date) === td && S.view === 'lift' ? ' today' : ''),
      title: S.view === 'lift' ? 'Opna þennan dag með öllum lyftum' : 'Opna dagatal þessarar lyftu',
      onclick: () => {
        if (S.view === 'lift') { S.view = 'lifts'; S.date = c.date; store.set('view', 'lifts'); }
        else { S.view = 'lift'; S.liftId = c.liftId; store.set('view', 'lift'); store.set('liftId', c.liftId); }
        reload();
      },
    }, c.color ? h('span', { class: 'dot', style: { background: c.color } }) : null, c.label,
      h('span', { class: 'sub' }, loadText(c)))));

  const gutter = h('div', { class: 'gutter', style: { height: H + 'px' } });
  for (let m = Math.ceil(g0 / 60) * 60; m < g1; m += 60) {
    if (m === g0) continue;
    gutter.append(h('div', { class: 'hl', style: { top: (m - g0) * S.ppm + 'px' } }, hm(m)));
  }

  const colEls = cols.map((c) => {
    const el = h('div', { class: 'col', style: { height: H + 'px' } });
    el.dataset.date = ymd(c.date);
    el.dataset.lift = c.liftId;
    // Lokað utan opnunartíma
    const oh = hoursFor(c.date);
    const shade = (s, e, cls, label) => {
      const a = Math.max(s, g0), b = Math.min(e, g1);
      if (b <= a) return;
      el.append(h('div', { class: 'shade ' + cls, style: { top: (a - g0) * S.ppm + 'px', height: (b - a) * S.ppm + 'px' } }, label ? h('span', {}, label) : null));
    };
    if (!oh) shade(g0, g1, 'closed');
    else { shade(g0, oh.open, 'closed'); shade(oh.close, g1, 'closed'); }
    for (const b of blockedFor(c.date, c.liftId)) shade(b.s, b.e, 'blocked', b.label);

    // Bókanir í þessum dálki
    const dayStart = c.date.getTime(), dayEnd = dayStart + DAY_MS;
    const items = S.bookings
      .filter((b) => b.lift_id === c.liftId && new Date(b.starts_at).getTime() < dayEnd && new Date(b.ends_at).getTime() > dayStart)
      .map((b) => {
        const s = Math.max(0, (new Date(b.starts_at).getTime() - dayStart) / 60e3);
        const e = Math.min(1440, (new Date(b.ends_at).getTime() - dayStart) / 60e3);
        return { b, s, e, clipT: new Date(b.starts_at).getTime() < dayStart, clipB: new Date(b.ends_at).getTime() > dayEnd };
      })
      .sort((x, y) => x.s - y.s || y.e - x.e);
    layoutLanes(items);
    for (const it of items) el.append(bookingEl(it, g0, g1));

    // Gulir miðar
    // Í lyftusýn: allir miðar dagsins sem eru ekki bundnir annarri lyftu. Í „allar lyftur“: miðinn í dálki sinnar lyftu (óbundnir í fyrsta dálki).
    const firstLift = activeLifts()[0]?.id;
    const showNote = (n) => n.day === ymd(c.date) && (S.view === 'lift'
      ? (!n.lift_id || n.lift_id === c.liftId)
      : ((n.lift_id && liftById(n.lift_id)?.active ? n.lift_id : firstLift) === c.liftId));
    for (const n of S.notes.filter(showNote)) el.append(noteEl(n, g0));

    el.addEventListener('pointerdown', (e) => onColDown(e, el, c));
    return el;
  });

  const body = h('div', { class: 'cal-body' }, gutter, colEls);
  cal.replaceChildren(head, body);
  drawNowLine();
}

function loadText(c) {
  const oh = hoursFor(c.date);
  if (!oh) return 'lokað';
  const blocked = blockedFor(c.date, c.liftId).reduce((a, b) => a + Math.max(0, Math.min(b.e, oh.close) - Math.max(b.s, oh.open)), 0);
  const cap = oh.close - oh.open - blocked;
  const dayStart = c.date.getTime();
  const used = S.bookings.filter((b) => b.lift_id === c.liftId).reduce((a, b) => {
    const s = Math.max(oh.open, (new Date(b.starts_at).getTime() - dayStart) / 60e3);
    const e = Math.min(oh.close, (new Date(b.ends_at).getTime() - dayStart) / 60e3);
    return a + Math.max(0, e - s);
  }, 0);
  return cap > 0 ? `${Math.round((used / cap) * 100)}% bókað` : '';
}

function layoutLanes(items) {
  let group = [], groupEnd = -1;
  const flush = () => {
    const lanes = [];
    for (const it of group) {
      let i = lanes.findIndex((end) => end <= it.s);
      if (i < 0) { i = lanes.length; lanes.push(0); }
      lanes[i] = it.e; it.lane = i;
    }
    for (const it of group) it.lanes = lanes.length;
  };
  for (const it of items) {
    if (it.s >= groupEnd && group.length) { flush(); group = []; }
    group.push(it); groupEnd = Math.max(groupEnd, it.e);
  }
  if (group.length) flush();
}

function bookingEl(it, g0, g1) {
  const { b } = it;
  const s = Math.max(it.s, g0), e = Math.min(it.e, g1);
  const top = (s - g0) * S.ppm, height = Math.max(18, (e - s) * S.ppm - 2);
  const w = 100 / (it.lanes || 1);
  const svc = serviceById(b.service_id);
  const el = h('div', {
    class: `bk ${b.status}${b.source === 'outlook' ? ' outlook' : ''}${it.clipT ? ' clipT' : ''}${it.clipB ? ' clipB' : ''}`,
    style: { top: top + 'px', height: height + 'px', left: `calc(${w * (it.lane || 0)}% + 3px)`, width: `calc(${w}% - 6px)`, right: 'auto' },
    title: `${b.plate || ''} ${b.customer_name || ''}\n${fmtDT(b.starts_at)} – ${hm(minOf(new Date(b.ends_at)))}\n${svc?.name || b.title || ''}\n${STATUS[b.status]}${b.notes ? '\n\n' + b.notes : ''}`,
  },
    h('div', { class: 't' }, h('span', { class: 'pl' }, b.plate || b.title || '—'), h('span', { class: 'muted', style: { fontWeight: 500 } }, `${hm(Math.round(it.s))}–${hm(Math.round(it.e))}`)),
    height > 30 ? h('div', { class: 's' }, b.customer_name || (b.plate ? b.title : '')) : null,
    height > 46 ? h('div', { class: 's' }, svc?.name || '') : null,
    height > 62 && b.notes ? h('div', { class: 's', style: { fontStyle: 'italic' } }, b.notes) : null,
    h('div', { class: 'rz' }));
  el.dataset.id = b.id;
  el.addEventListener('pointerdown', (ev) => onBookingDown(ev, el, b, it));
  return el;
}

function noteEl(n, g0) {
  const el = h('div', {
    class: 'note' + (n.done ? ' done' : ''),
    style: { top: Math.max(0, (n.minute - g0) * S.ppm) + 'px', left: `calc(${(n.dx ?? 0.08) * 100}% )` },
  }, n.remind_at && !n.reminded_at ? h('span', { class: 'bell', title: 'Áminning ' + fmtDT(n.remind_at) }, '🔔') : null, n.body || 'Tómur miði');
  el.addEventListener('pointerdown', (ev) => onNoteDown(ev, el, n));
  return el;
}

function drawNowLine() {
  document.querySelectorAll('.now').forEach((x) => x.remove());
  if (!S.settings) return;
  const now = new Date();
  const g0 = tmin(S.settings.grid_start), g1 = tmin(S.settings.grid_end);
  const m = minOf(now);
  if (m < g0 || m > g1) return;
  document.querySelectorAll(`.col[data-date="${ymd(now)}"]`).forEach((c) => c.append(h('div', { class: 'now', style: { top: (m - g0) * S.ppm + 'px' } })));
}

// ---------- Mánaðarsýn (ein lyfta) ----------
function renderMonth(cal) {
  const days = monthGrid();
  const mth = S.date.getUTCMonth();
  const td = ymd(today());
  const head = h('div', { class: 'month-h' }, ['Mán', 'Þri', 'Mið', 'Fim', 'Fös', 'Lau', 'Sun'].map((x) => h('div', {}, x)));
  const grid = h('div', { class: 'month' }, days.map((d) => {
    const dayStart = d.getTime(), dayEnd = dayStart + DAY_MS;
    const list = S.bookings.filter((b) => new Date(b.starts_at).getTime() < dayEnd && new Date(b.ends_at).getTime() > dayStart)
      .sort((a, b) => a.starts_at.localeCompare(b.starts_at));
    const notes = S.notes.filter((n) => n.day === ymd(d) && (!n.lift_id || n.lift_id === S.liftId));
    const max = 5;
    const c = { date: d, liftId: S.liftId };
    const pct = parseInt(loadText(c)) || 0;
    return h('div', {
      class: 'mc' + (d.getUTCMonth() !== mth ? ' other' : '') + (ymd(d) === td ? ' today' : '') + (!hoursFor(d) ? ' closedday' : ''),
      onclick: (e) => { if (e.target.closest('.mi')) return; S.date = d; S.range = 1; store.set('range', 1); reload(); },
    },
      h('div', { class: 'd' }, d.getUTCDate()),
      hoursFor(d) ? h('div', { class: 'load', title: `${pct}% bókað` }, h('i', { style: { width: pct + '%' } })) : null,
      notes.map((n) => h('div', { class: 'mi note', onclick: () => editNote(n) }, n.body || 'Gulur miði')),
      list.slice(0, max).map((b) => h('div', { class: 'mi ' + b.status, onclick: () => openBooking({ booking: b }) },
        `${hm(minOf(new Date(Math.max(new Date(b.starts_at).getTime(), dayStart))))} ${b.plate || b.title || ''} ${b.customer_name || ''}`)),
      list.length > max ? h('div', { class: 'more' }, `+${list.length - max} í viðbót`) : null);
  }));
  cal.replaceChildren(head, grid);
}

// ======================================================================
// Draga og sleppa
// ======================================================================
let drag = null;
const slot = () => S.settings.slot_minutes || 15;
const snap = (m) => Math.round(m / slot()) * slot();

function colAt(x, y) {
  const el = document.elementFromPoint(x, y);
  return el?.closest?.('.col');
}
function minuteAt(colEl, y) {
  const r = colEl.getBoundingClientRect();
  return tmin(S.settings.grid_start) + (y - r.top) / S.ppm;
}

// Nýr tími: smella eða draga á tómu svæði
function onColDown(e, el, c) {
  if (e.button !== 0 || e.target !== el && !e.target.classList.contains('shade') && e.target.tagName !== 'SPAN') return;
  if (e.target.closest('.bk, .note')) return;
  const m0 = Math.floor(minuteAt(el, e.clientY) / slot()) * slot();
  const sel = h('div', { class: 'sel' });
  el.append(sel);
  drag = { kind: 'select', el, c, m0, m1: m0 + slot(), sel };
  const upd = () => {
    const a = Math.min(drag.m0, drag.m1), b = Math.max(drag.m0, drag.m1);
    const g0 = tmin(S.settings.grid_start);
    sel.style.top = (a - g0) * S.ppm + 'px';
    sel.style.height = (b - a) * S.ppm + 'px';
    sel.textContent = `${hm(a)}–${hm(b)}`;
  };
  upd();
  el.setPointerCapture(e.pointerId);
  const move = (ev) => {
    const m = Math.ceil(minuteAt(el, ev.clientY) / slot()) * slot();
    drag.m1 = m <= drag.m0 ? drag.m0 + slot() : m;
    upd();
  };
  const up = () => {
    el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up);
    sel.remove();
    const { m0, m1 } = drag; drag = null;
    const start = new Date(c.date.getTime() + m0 * 60e3);
    const dragged = m1 - m0 > slot();
    openBooking({ start, end: dragged ? new Date(c.date.getTime() + m1 * 60e3) : null, liftId: c.liftId });
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
}

function onBookingDown(e, el, b, it) {
  if (e.button !== 0) return;
  e.stopPropagation();
  const resize = e.target.classList.contains('rz');
  const startX = e.clientX, startY = e.clientY;
  const colEl = el.parentElement;
  const grabMin = minuteAt(colEl, e.clientY) - it.s;
  const dur = (new Date(b.ends_at) - new Date(b.starts_at)) / 60e3;
  let moved = false, target = null;
  el.setPointerCapture(e.pointerId);
  drag = { kind: 'booking' };
  const g0 = tmin(S.settings.grid_start);

  const move = (ev) => {
    if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 5) return;
    moved = true;
    el.classList.add('dragging');
    if (resize) {
      const m = Math.max(it.s + slot(), Math.ceil(minuteAt(colEl, ev.clientY) / slot()) * slot());
      el.style.height = (m - it.s) * S.ppm - 2 + 'px';
      target = { colEl, startMin: it.s, endMin: m };
    } else {
      el.style.visibility = 'hidden';
      const col = colAt(ev.clientX, ev.clientY) || colEl;
      el.style.visibility = '';
      if (el.parentElement !== col) col.append(el);
      const sm = snap(minuteAt(col, ev.clientY) - grabMin);
      el.style.top = (sm - g0) * S.ppm + 'px';
      el.style.left = '3px'; el.style.width = 'calc(100% - 6px)';
      target = { colEl: col, startMin: sm };
    }
  };
  const up = async () => {
    el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up);
    drag = null;
    if (!moved) return openBooking({ booking: b });
    el.classList.remove('dragging');
    if (!target) return render();
    const day = parseYmd(target.colEl.dataset.date);
    let patch;
    if (resize) {
      patch = { ends_at: new Date(day.getTime() + target.endMin * 60e3).toISOString() };
    } else {
      // Fyrir bókun sem nær yfir marga daga færist byrjunin miðað við þann hluta sem var gripinn
      const offset = (new Date(b.starts_at).getTime() - (parseYmd(colEl.dataset.date).getTime() + it.s * 60e3));
      const s = new Date(day.getTime() + target.startMin * 60e3 + offset);
      patch = { starts_at: s.toISOString(), ends_at: new Date(s.getTime() + dur * 60e3).toISOString(), lift_id: target.colEl.dataset.lift };
    }
    const { error } = await S.sb.from('bookings').update(patch).eq('id', b.id);
    if (error) { toast(errText(error), true); }
    else if (patch.lift_id && patch.lift_id !== b.lift_id) toast(`Fært á ${liftById(patch.lift_id)?.name}`);
    reload();
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
}

function onNoteDown(e, el, n) {
  if (e.button !== 0) return;
  e.stopPropagation();
  const sx = e.clientX, sy = e.clientY;
  const r0 = el.getBoundingClientRect();
  const offX = sx - r0.left, offY = sy - r0.top;
  let moved = false, target = null;
  el.setPointerCapture(e.pointerId);
  drag = { kind: 'note' };
  const g0 = tmin(S.settings.grid_start);
  const move = (ev) => {
    if (!moved && Math.hypot(ev.clientX - sx, ev.clientY - sy) < 5) return;
    moved = true; el.classList.add('dragging');
    el.style.visibility = 'hidden';
    const col = colAt(ev.clientX, ev.clientY) || el.parentElement;
    el.style.visibility = '';
    if (el.parentElement !== col) col.append(el);
    const cr = col.getBoundingClientRect();
    const top = Math.max(0, ev.clientY - offY - cr.top);
    const dx = Math.min(0.9, Math.max(0, (ev.clientX - offX - cr.left) / cr.width));
    el.style.top = top + 'px'; el.style.left = dx * 100 + '%';
    target = { col, minute: Math.round(g0 + top / S.ppm), dx };
  };
  const up = async () => {
    el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up);
    drag = null;
    if (!moved) return editNote(n);
    el.classList.remove('dragging');
    if (!target) return;
    const patch = { day: target.col.dataset.date, minute: target.minute, dx: target.dx, updated_at: new Date().toISOString() };
    if (S.view === 'lifts') patch.lift_id = target.col.dataset.lift;
    const { error } = await S.sb.from('sticky_notes').update(patch).eq('id', n.id);
    if (error) toast(errText(error), true);
    reload();
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
}

// ======================================================================
// Gluggar
// ======================================================================
function modal(titleText, body, footer, { wide = false, onClose } = {}) {
  const ov = h('div', { class: 'overlay' });
  const close = () => { ov.remove(); document.removeEventListener('keydown', key); onClose?.(); };
  const key = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', key);
  ov.addEventListener('pointerdown', (e) => { if (e.target === ov) close(); });
  ov.append(h('div', { class: 'modal' + (wide ? ' wide' : '') },
    h('header', {}, h('h2', {}, titleText), h('button', { class: 'btn ghost', onclick: close }, '✕')),
    body, footer || null));
  document.body.append(ov);
  return { close, ov };
}

const timeOpts = (sel) => {
  const out = [];
  for (let m = 0; m < 1440; m += slot()) out.push(h('option', { value: hm(m), selected: hm(m) === sel }, hm(m)));
  if (sel && !out.find((o) => o.value === sel)) out.unshift(h('option', { value: sel, selected: true }, sel));
  return out;
};

// ---------- Bókun ----------
function openBooking({ booking = null, start = null, end = null, liftId = null, request = null } = {}) {
  const b = booking ? { ...booking } : {
    lift_id: liftId || (S.view === 'lift' ? S.liftId : activeLifts()[0]?.id),
    starts_at: (start || defaultStart()).toISOString(),
    ends_at: null, status: 'booked', send_reminder: true, plate: '', customer_name: '', phone: '', email: '', notes: '', title: '', service_id: null,
  };
  if (request) Object.assign(b, { plate: request.plate, customer_name: request.name, phone: request.phone, email: request.email || '', service_id: request.service_id, notes: request.notes || '', source: 'online' });
  const svcDefault = serviceById(b.service_id);
  if (!b.ends_at) {
    const mins = end ? (end - new Date(b.starts_at)) / 60e3 : (svcDefault?.duration_minutes || 60);
    b.ends_at = new Date(new Date(b.starts_at).getTime() + mins * 60e3).toISOString();
  }
  const sd = new Date(b.starts_at), ed = new Date(b.ends_at);

  const f = {
    lift: h('select', {}, S.lifts.filter((l) => l.active || l.id === b.lift_id).map((l) => h('option', { value: l.id, selected: l.id === b.lift_id }, l.name))),
    sdate: h('input', { type: 'date', value: ymd(sd) }),
    stime: h('select', {}, timeOpts(hm(minOf(sd)))),
    edate: h('input', { type: 'date', value: ymd(ed) }),
    etime: h('select', {}, timeOpts(hm(minOf(ed)))),
    service: h('select', {}, h('option', { value: '' }, '— veldu verk —'),
      S.services.filter((s) => s.active || s.id === b.service_id).map((s) => h('option', { value: s.id, selected: s.id === b.service_id }, `${s.name} (${durTxt(s.duration_minutes)})`))),
    plate: h('input', { type: 'text', value: b.plate || '', placeholder: 'AB123', style: { textTransform: 'uppercase', fontFamily: 'ui-monospace,monospace', fontWeight: 700 } }),
    name: h('input', { type: 'text', value: b.customer_name || '' }),
    phone: h('input', { type: 'tel', value: b.phone || '' }),
    email: h('input', { type: 'email', value: b.email || '' }),
    title: h('input', { type: 'text', value: b.title || '', placeholder: 'T.d. tjón á afturhlera' }),
    notes: h('textarea', { rows: 3 }, b.notes || ''),
    reminder: h('input', { type: 'checkbox', checked: b.send_reminder !== false }),
  };
  let status = b.status || 'booked';
  const statusSeg = h('div', { class: 'seg status-seg' }, ['booked', 'in_progress', 'ready', 'picked_up', 'no_show'].map((v) =>
    h('button', { type: 'button', 'data-v': v, class: v === status ? 'on' : '', onclick: (e) => { status = v; statusSeg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x.dataset.v === v)); } }, STATUS[v])));
  const info = h('div', {});
  const warn = h('div', {});

  // Verk valið: setja lengd
  f.service.addEventListener('change', () => {
    const s = serviceById(f.service.value);
    if (!s) return;
    const st = new Date(`${f.sdate.value}T${f.stime.value}:00Z`);
    const en = new Date(st.getTime() + s.duration_minutes * 60e3);
    f.edate.value = ymd(en); setSel(f.etime, hm(minOf(en)));
    check();
  });
  // Byrjun breytist: halda lengd
  let durMin = (ed - sd) / 60e3;
  const shiftEnd = () => {
    const st = new Date(`${f.sdate.value}T${f.stime.value}:00Z`);
    const en = new Date(st.getTime() + durMin * 60e3);
    f.edate.value = ymd(en); setSel(f.etime, hm(minOf(en)));
    check();
  };
  f.sdate.addEventListener('change', shiftEnd); f.stime.addEventListener('change', shiftEnd);
  const updDur = () => { durMin = (new Date(`${f.edate.value}T${f.etime.value}:00Z`) - new Date(`${f.sdate.value}T${f.stime.value}:00Z`)) / 60e3; check(); };
  f.edate.addEventListener('change', updDur); f.etime.addEventListener('change', updDur); f.lift.addEventListener('change', check);

  // Fletta upp bílnúmeri
  f.plate.addEventListener('blur', async () => {
    const p = normPlate(f.plate.value);
    f.plate.value = p;
    if (!p || p === b.plate) return;
    const { data: v } = await S.sb.from('vehicles').select('*, customers(*)').eq('plate', p).maybeSingle();
    const { data: last } = await S.sb.from('bookings').select('starts_at,status,service_id,title,customer_name,phone,email').eq('plate', p).neq('id', b.id || '00000000-0000-0000-0000-000000000000').order('starts_at', { ascending: false }).limit(3);
    const c = v?.customers;
    if (c) {
      if (!f.name.value) f.name.value = c.name || '';
      if (!f.phone.value) f.phone.value = c.phone || '';
      if (!f.email.value) f.email.value = c.email || '';
    } else if (last?.[0]) {
      if (!f.name.value) f.name.value = last[0].customer_name || '';
      if (!f.phone.value) f.phone.value = last[0].phone || '';
      if (!f.email.value) f.email.value = last[0].email || '';
    }
    info.replaceChildren(last?.length ? h('div', { class: 'hint' }, h('b', {}, 'Fyrri komur: '),
      last.map((x) => `${fmtDay(new Date(x.starts_at))} ${new Date(x.starts_at).getUTCFullYear()} – ${serviceById(x.service_id)?.name || x.title || ''} (${STATUS[x.status]})`).join(' · ')) : '');
  });

  function check() {
    const st = new Date(`${f.sdate.value}T${f.stime.value}:00Z`), en = new Date(`${f.edate.value}T${f.etime.value}:00Z`);
    const msgs = [];
    if (!(en > st)) msgs.push('Lok verður að vera eftir byrjun.');
    else {
      const d = day0(st);
      const bl = isBlocked(d, f.lift.value, minOf(st), (en - d) / 60e3);
      if (bl) msgs.push(`Skarast við lokaðan tíma: ${bl.label}.`);
      const oh = hoursFor(d);
      if (!oh) msgs.push('Lokað þennan dag.');
      else if (minOf(st) < oh.open || (ymd(en) === ymd(st) && minOf(en) > oh.close)) msgs.push(`Utan opnunartíma (${hm(oh.open)}–${hm(oh.close)}).`);
    }
    warn.replaceChildren(msgs.length ? h('div', { class: 'warn' }, msgs.join(' ')) : '');
  }
  check();

  const log = h('div', { class: 'log' });
  if (b.id) {
    S.sb.from('message_log').select('*').eq('booking_id', b.id).order('created_at', { ascending: false }).then(({ data }) => {
      if (data?.length) log.replaceChildren(h('b', {}, 'Skilaboð'), data.map((m) => h('div', {}, `${fmtDT(m.created_at)} · ${m.channel === 'sms' ? 'SMS' : 'Tölvupóstur'} · ${kindTxt(m.kind)} · ${m.to_addr} · ${m.status === 'sent' ? '✓' : m.status === 'skipped' ? 'ekki sent (óvirkt)' : '✗ ' + (m.error || '')}`)));
    });
  }

  const body = h('div', { class: 'body' },
    request ? h('div', { class: 'hint' }, `Netbókunarbeiðni frá ${request.name}: óskadagur ${request.preferred_date ? fmtDay(parseYmd(request.preferred_date)) : '—'} (${partTxt(request.preferred_part)})${request.alt_date ? ', varadagur ' + fmtDay(parseYmd(request.alt_date)) : ''}`) : null,
    h('div', { class: 'grid3' },
      h('label', { class: 'f' }, 'Lyfta', f.lift),
      h('label', { class: 'f' }, 'Bílnúmer', f.plate),
      h('label', { class: 'f' }, 'Verk', f.service)),
    h('div', { class: 'grid2' },
      h('label', { class: 'f' }, 'Byrjar', h('div', { class: 'row' }, f.sdate, f.stime)),
      h('label', { class: 'f' }, 'Lýkur', h('div', { class: 'row' }, f.edate, f.etime))),
    warn,
    h('div', { class: 'grid3' },
      h('label', { class: 'f' }, 'Nafn', f.name),
      h('label', { class: 'f' }, 'Sími', f.phone),
      h('label', { class: 'f' }, 'Netfang', f.email)),
    info,
    h('label', { class: 'f' }, 'Lýsing', f.title),
    h('label', { class: 'f' }, 'Athugasemdir', f.notes),
    b.id ? h('label', { class: 'f' }, 'Staða', statusSeg) : null,
    h('label', { class: 'row', style: { fontSize: '13px' } }, f.reminder, 'Senda SMS-áminningu daginn fyrir', b.reminder_sent_at ? h('span', { class: 'muted' }, `(send ${fmtDT(b.reminder_sent_at)})`) : null),
    b.source === 'outlook' ? h('div', { class: 'hint' }, 'Þessi bókun kom úr Outlook.') : null,
    log);

  const sendConfirm = h('input', { type: 'checkbox', checked: !!(request && request.email) });

  async function save() {
    const st = new Date(`${f.sdate.value}T${f.stime.value}:00Z`), en = new Date(`${f.edate.value}T${f.etime.value}:00Z`);
    if (!(en > st)) { toast('Lok verður að vera eftir byrjun.', true); return null; }
    const plate = normPlate(f.plate.value);
    const row = {
      lift_id: f.lift.value, starts_at: st.toISOString(), ends_at: en.toISOString(),
      service_id: f.service.value || null, plate, customer_name: f.name.value.trim(), phone: f.phone.value.trim(),
      email: f.email.value.trim() || null, title: f.title.value.trim(), notes: f.notes.value.trim(),
      send_reminder: f.reminder.checked, status,
    };
    if (!b.id && request) row.source = 'online';
    try { Object.assign(row, await upsertCustomer(row)); } catch (e) { console.warn(e); }
    const q = b.id ? S.sb.from('bookings').update(row).eq('id', b.id).select().single() : S.sb.from('bookings').insert(row).select().single();
    const { data, error } = await q;
    if (error) { toast(errText(error), true); return null; }
    return data;
  }

  const footer = h('footer', {},
    h('div', { class: 'r' },
      b.id ? h('button', {
        class: 'btn danger', onclick: async () => {
          if (!confirm('Afbóka þennan tíma?')) return;
          const { error } = await S.sb.from('bookings').update({ status: 'cancelled' }).eq('id', b.id);
          if (error) return toast(errText(error), true);
          m.close(); toast('Tími afbókaður'); reload();
        },
      }, 'Afbóka') : null,
      b.id && b.email ? h('button', { class: 'btn', onclick: () => notify(b.id, 'confirm') }, 'Senda staðfestingu') : null,
      b.id && b.phone && status !== 'ready' ? h('button', {
        class: 'btn', style: { color: 'var(--s-ready)' }, onclick: async () => {
          status = 'ready';
          const saved = await save(); if (!saved) return;
          await notify(b.id, 'ready'); m.close(); reload();
        },
      }, '✓ Tilbúinn + SMS') : null,
      request ? h('label', { class: 'row', style: { fontSize: '13px' } }, sendConfirm, 'Senda staðfestingu í tölvupósti') : null),
    h('div', { class: 'r' },
      h('button', { class: 'btn', onclick: () => m.close() }, 'Hætta við'),
      h('button', {
        class: 'btn primary', onclick: async () => {
          const prev = b.status;
          const saved = await save(); if (!saved) return;
          m.close();
          toast(b.id ? 'Bókun uppfærð' : 'Bókun skráð');
          if (request) {
            try { await api('/api/staff/request-accepted', { request_id: request.id, booking_id: saved.id, send_email: sendConfirm.checked && !!saved.email }); }
            catch (e) { toast(errText(e), true); }
          }
          if (b.id && prev !== 'ready' && saved.status === 'ready' && saved.phone && confirm('Senda SMS um að bíllinn sé tilbúinn?')) await notify(saved.id, 'ready');
          if (S.view === 'lift' && saved.lift_id !== S.liftId) { S.liftId = saved.lift_id; store.set('liftId', S.liftId); }
          if (!booking) S.date = day0(new Date(saved.starts_at));
          reload();
        },
      }, 'Vista')));

  const m = modal(b.id ? `Bókun – ${b.plate || b.title || ''}` : (request ? 'Bóka tíma úr beiðni' : 'Ný bókun'), body, footer);
  setTimeout(() => (b.id ? null : f.plate.focus()), 30);
}

function setSel(sel, val) {
  if (![...sel.options].some((o) => o.value === val)) sel.prepend(h('option', { value: val }, val));
  sel.value = val;
}
const durTxt = (m) => (m % 60 === 0 ? `${m / 60} klst` : m > 60 ? `${Math.floor(m / 60)} klst ${m % 60} mín` : `${m} mín`);
const partTxt = (p) => ({ any: 'hvenær sem er', morning: 'fyrir hádegi', afternoon: 'eftir hádegi' }[p] || p);
const kindTxt = (k) => ({ reminder: 'áminning', ready: 'tilbúinn', confirm: 'staðfesting', request_received: 'beiðni móttekin', request_staff: 'tilkynning', sticky_reminder: 'gulur miði' }[k] || k);

async function notify(id, kind) {
  try {
    const r = await api('/api/staff/notify', { booking_id: id, kind });
    if (r.skipped) toast(kind === 'ready' ? 'SMS er óvirkt í stillingum — ekkert sent.' : 'Tölvupóstur er óvirkur í stillingum — ekkert sent.', true);
    else if (r.ok) toast(kind === 'ready' ? 'SMS sent' : 'Tölvupóstur sendur');
    else toast('Ekki tókst að senda: ' + (r.error || ''), true);
  } catch (e) { toast(errText(e), true); }
}

async function upsertCustomer(row) {
  const out = {};
  if (row.phone || row.email) {
    let c = null;
    if (row.phone) c = (await S.sb.from('customers').select('*').eq('phone', row.phone).limit(1)).data?.[0];
    if (!c && row.email) c = (await S.sb.from('customers').select('*').eq('email', row.email).limit(1)).data?.[0];
    if (c) {
      const patch = {};
      if (row.customer_name && row.customer_name !== c.name) patch.name = row.customer_name;
      if (row.email && row.email !== c.email) patch.email = row.email;
      if (row.phone && row.phone !== c.phone) patch.phone = row.phone;
      if (Object.keys(patch).length) await S.sb.from('customers').update(patch).eq('id', c.id);
    } else {
      c = (await S.sb.from('customers').insert({ name: row.customer_name, phone: row.phone || null, email: row.email }).select().single()).data;
    }
    if (c) out.customer_id = c.id;
  }
  if (row.plate) {
    let v = (await S.sb.from('vehicles').select('*').eq('plate', row.plate).maybeSingle()).data;
    if (!v) v = (await S.sb.from('vehicles').insert({ plate: row.plate, customer_id: out.customer_id || null }).select().single()).data;
    else if (out.customer_id && v.customer_id !== out.customer_id) await S.sb.from('vehicles').update({ customer_id: out.customer_id }).eq('id', v.id);
    if (v) out.vehicle_id = v.id;
  }
  return out;
}

// ---------- Gulir miðar ----------
async function newNote() {
  const d = S.view === 'lift' && S.range !== 'month' ? visibleDays()[0] : S.date;
  const n = { day: ymd(d), minute: (hoursFor(d)?.open ?? 480) + 30, dx: 0.1, body: '', lift_id: S.view === 'lift' ? S.liftId : activeLifts()[0]?.id };
  editNote(n);
}
function editNote(n) {
  const body = h('textarea', { rows: 5, placeholder: 'T.d. Hringja í Jón vegna varahluta' }, n.body || '');
  const day = h('input', { type: 'date', value: n.day });
  const time = h('select', {}, timeOpts(hm(Math.round(n.minute / slot()) * slot())));
  const lift = h('select', {}, h('option', { value: '' }, 'Engin sérstök lyfta'), S.lifts.map((l) => h('option', { value: l.id, selected: l.id === n.lift_id }, l.name)));
  const remind = h('input', { type: 'datetime-local', value: n.remind_at ? new Date(n.remind_at).toISOString().slice(0, 16) : '' });
  const done = h('input', { type: 'checkbox', checked: !!n.done });
  const m = modal(n.id ? 'Gulur miði' : 'Nýr gulur miði', h('div', { class: 'body', style: { background: 'var(--yellow)' } },
    body,
    h('div', { class: 'grid3' }, h('label', { class: 'f' }, 'Dagur', day), h('label', { class: 'f' }, 'Tími', time), h('label', { class: 'f' }, 'Lyfta', lift)),
    h('label', { class: 'f' }, 'Áminning í tölvupósti (valfrjálst)', remind),
    n.id ? h('label', { class: 'row' }, done, 'Lokið') : null),
  h('footer', {},
    h('div', { class: 'r' }, n.id ? h('button', {
      class: 'btn danger', onclick: async () => {
        if (!confirm('Eyða miðanum?')) return;
        await S.sb.from('sticky_notes').delete().eq('id', n.id); m.close(); reload();
      },
    }, 'Eyða') : null),
    h('div', { class: 'r' },
      h('button', { class: 'btn', onclick: () => m.close() }, 'Hætta við'),
      h('button', {
        class: 'btn primary', onclick: async () => {
          const row = {
            body: body.value, day: day.value, minute: tmin(time.value), lift_id: lift.value || null, done: done.checked,
            remind_at: remind.value ? new Date(remind.value + ':00Z').toISOString() : null, dx: n.dx ?? 0.1, updated_at: new Date().toISOString(),
          };
          if (n.remind_at !== row.remind_at) row.reminded_at = null;
          const { error } = n.id ? await S.sb.from('sticky_notes').update(row).eq('id', n.id) : await S.sb.from('sticky_notes').insert(row);
          if (error) return toast(errText(error), true);
          m.close(); reload();
        },
      }, 'Vista'))));
  setTimeout(() => body.focus(), 30);
}

// ---------- Beiðnir úr netbókun ----------
function renderDrawer() {
  const dr = $('#drawer');
  if (!S.showRequests) { dr.replaceChildren(); return; }
  const svc = (id) => serviceById(id)?.name || '—';
  dr.replaceChildren(h('div', { class: 'drawer' },
    h('header', {}, h('b', {}, `Beiðnir úr netbókun (${S.requests.length})`), h('button', { class: 'btn ghost', onclick: () => { S.showRequests = false; renderDrawer(); } }, '✕')),
    h('div', { class: 'list' },
      S.requests.length ? S.requests.map((r) => h('div', { class: 'req' },
        h('div', { class: 'row', style: { justifyContent: 'space-between' } }, h('span', { class: 'pl' }, r.plate), h('span', { class: 'muted', style: { fontSize: '12px' } }, fmtDT(r.created_at))),
        h('div', {}, h('b', {}, r.name), ' · ', h('a', { href: 'tel:' + r.phone }, r.phone), r.email ? [' · ', h('a', { href: 'mailto:' + r.email }, r.email)] : null),
        h('div', {}, svc(r.service_id)),
        h('div', { class: 'muted' }, `Óskadagur: ${r.preferred_date ? fmtDay(parseYmd(r.preferred_date)) : '—'} (${partTxt(r.preferred_part)})${r.alt_date ? ' · varadagur ' + fmtDay(parseYmd(r.alt_date)) : ''}`),
        r.notes ? h('div', { style: { whiteSpace: 'pre-wrap', fontSize: '13px' } }, r.notes) : null,
        h('div', { class: 'row', style: { marginTop: '6px' } },
          h('button', {
            class: 'btn primary sm', onclick: () => {
              const d = r.preferred_date ? parseYmd(r.preferred_date) : today();
              const oh = hoursFor(d);
              const m = r.preferred_part === 'afternoon' ? 13 * 60 : (oh?.open ?? 480);
              S.date = d;
              reload().then(() => openBooking({ start: new Date(d.getTime() + m * 60e3), request: r }));
            },
          }, 'Bóka tíma'),
          h('button', {
            class: 'btn sm', onclick: async () => {
              if (!confirm(`Hafna beiðni frá ${r.name}? (Mundu að hafa samband við viðkomandi.)`)) return;
              await S.sb.from('booking_requests').update({ status: 'declined', handled_by: S.me.id, handled_at: new Date().toISOString() }).eq('id', r.id);
              reload();
            },
          }, 'Hafna')))) : h('div', { class: 'muted', style: { padding: '20px', textAlign: 'center' } }, 'Engar nýjar beiðnir.'),
      h('div', { class: 'hint' }, 'Netbókunarsíðan: ', h('a', { href: '/boka', target: '_blank' }, location.origin + '/boka')))));
}

// ======================================================================
// Stillingar (aðeins stjórnendur)
// ======================================================================
async function openSettings(tab = 'general') {
  await loadStatic();
  const { data: profiles } = await S.sb.from('profiles').select('*').order('name');
  S.profiles = profiles || [];
  const tabs = [['general', 'Almennt'], ['hours', 'Opnunartímar'], ['blocked', 'Lokaðir tímar'], ['lifts', 'Lyftur & Outlook'], ['services', 'Verk'], ['messages', 'Skilaboð'], ['staff', 'Starfsfólk']];
  const content = h('div', { class: 'body' });
  const tabBar = h('div', { class: 'tabs' }, tabs.map(([k, t]) => h('button', { class: k === tab ? 'on' : '', onclick: () => { m.close(); openSettings(k); } }, t)));
  const m = modal('Stillingar', h('div', {}, tabBar, content), null, { wide: true, onClose: async () => { await loadStatic(); reload(); } });
  ({ general: setGeneral, hours: setHours, blocked: setBlocked, lifts: setLifts, services: setServices, messages: setMessages, staff: setStaff })[tab](content);
}

async function saveSettings(patch) {
  const { error } = await S.sb.from('settings').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', 1);
  if (error) return toast(errText(error), true);
  Object.assign(S.settings, patch);
  toast('Vistað');
}

function field(label, input, hint) {
  return h('label', { class: 'f' }, label, input, hint ? h('span', { class: 'muted', style: { fontWeight: 400 } }, hint) : null);
}

function setGeneral(el) {
  const s = S.settings;
  const i = {
    shop_name: h('input', { type: 'text', value: s.shop_name }),
    shop_phone: h('input', { type: 'text', value: s.shop_phone || '' }),
    shop_email: h('input', { type: 'email', value: s.shop_email || '' }),
    shop_address: h('input', { type: 'text', value: s.shop_address || '' }),
    grid_start: h('input', { type: 'time', value: s.grid_start.slice(0, 5) }),
    grid_end: h('input', { type: 'time', value: s.grid_end.slice(0, 5) }),
    slot_minutes: h('select', {}, [5, 10, 15, 20, 30, 60].map((v) => h('option', { value: v, selected: v === s.slot_minutes }, `${v} mín`))),
    online_booking_enabled: h('input', { type: 'checkbox', checked: s.online_booking_enabled }),
    online_min_days_ahead: h('input', { type: 'number', min: 0, value: s.online_min_days_ahead }),
    online_max_days_ahead: h('input', { type: 'number', min: 1, value: s.online_max_days_ahead }),
    staff_notify_email: h('input', { type: 'email', value: s.staff_notify_email || '' }),
  };
  el.replaceChildren(
    h('div', { class: 'grid2' }, field('Nafn verkstæðis', i.shop_name), field('Símanúmer', i.shop_phone), field('Netfang', i.shop_email), field('Heimilisfang', i.shop_address)),
    h('div', { class: 'grid3' }, field('Dagatal byrjar', i.grid_start), field('Dagatal endar', i.grid_end), field('Tímabil (smellur)', i.slot_minutes)),
    h('h3', { style: { margin: '8px 0 0' } }, 'Netbókun'),
    h('label', { class: 'row' }, i.online_booking_enabled, 'Netbókun opin (viðskiptavinir senda beiðni sem starfsfólk staðfestir)'),
    h('div', { class: 'grid3' }, field('Fyrsti mögulegi dagur (dagar fram í tímann)', i.online_min_days_ahead), field('Síðasti mögulegi dagur', i.online_max_days_ahead), field('Tilkynning um nýjar beiðnir á netfang', i.staff_notify_email)),
    h('div', { class: 'hint' }, 'Slóð á netbókun: ', h('a', { href: '/boka', target: '_blank' }, location.origin + '/boka'), ' — má setja inn á nysprautun.is sem iframe/HTML-widget.'),
    h('div', {}, h('button', {
      class: 'btn primary', onclick: () => saveSettings({
        shop_name: i.shop_name.value, shop_phone: i.shop_phone.value, shop_email: i.shop_email.value, shop_address: i.shop_address.value,
        grid_start: i.grid_start.value, grid_end: i.grid_end.value, slot_minutes: +i.slot_minutes.value,
        online_booking_enabled: i.online_booking_enabled.checked, online_min_days_ahead: +i.online_min_days_ahead.value,
        online_max_days_ahead: +i.online_max_days_ahead.value, staff_notify_email: i.staff_notify_email.value,
      }),
    }, 'Vista')));
}

function setHours(el) {
  const rows = S.hours.map((r) => ({ r, closed: h('input', { type: 'checkbox', checked: r.closed }), o: h('input', { type: 'time', value: r.open_time.slice(0, 5) }), c: h('input', { type: 'time', value: r.close_time.slice(0, 5) }) }));
  el.replaceChildren(
    h('table', { class: 't' }, h('tr', {}, h('th', {}, 'Dagur'), h('th', {}, 'Lokað'), h('th', {}, 'Opnar'), h('th', {}, 'Lokar')),
      rows.map((x) => h('tr', {}, h('td', {}, WD_LONG[x.r.weekday % 7]), h('td', {}, x.closed), h('td', {}, x.o), h('td', {}, x.c)))),
    h('div', { class: 'hint' }, 'Utan opnunartíma er dagatalið skyggt. Starfsfólk getur samt bókað þar, en netbókun býður ekki upp á lokaða daga.'),
    h('div', {}, h('button', {
      class: 'btn primary', onclick: async () => {
        for (const x of rows) {
          const { error } = await S.sb.from('opening_hours').update({ closed: x.closed.checked, open_time: x.o.value, close_time: x.c.value }).eq('weekday', x.r.weekday);
          if (error) return toast(errText(error), true);
        }
        toast('Opnunartímar vistaðir');
      },
    }, 'Vista')));
}

function setBlocked(el) {
  const liftSel = (v) => h('select', {}, h('option', { value: '' }, 'Allar lyftur'), S.lifts.map((l) => h('option', { value: l.id, selected: l.id === v }, l.name)));
  const wdBoxes = (arr) => h('div', { class: 'wd' }, [1, 2, 3, 4, 5, 6, 7].map((d) => h('label', {}, h('input', { type: 'checkbox', value: d, checked: arr?.includes(d) }), ['M', 'Þ', 'M', 'F', 'F', 'L', 'S'][d - 1])));
  const readWd = (box) => [...box.querySelectorAll('input:checked')].map((x) => +x.value);

  const weekly = S.blocked.filter((b) => b.kind === 'weekly');
  const once = S.blocked.filter((b) => b.kind === 'once').sort((a, b) => a.starts_at.localeCompare(b.starts_at));

  const del = async (b) => { if (!confirm(`Eyða „${b.label}“?`)) return; await S.sb.from('blocked_times').delete().eq('id', b.id); await loadStatic(); setBlocked(el); };

  const wRows = weekly.map((b) => {
    const x = { label: h('input', { type: 'text', value: b.label }), lift: liftSel(b.lift_id), wd: wdBoxes(b.weekdays), s: h('input', { type: 'time', value: b.start_time.slice(0, 5) }), e: h('input', { type: 'time', value: b.end_time.slice(0, 5) }) };
    return h('tr', {}, h('td', {}, x.label), h('td', {}, x.lift), h('td', {}, x.wd), h('td', {}, x.s), h('td', {}, x.e),
      h('td', {}, h('button', {
        class: 'btn sm', onclick: async () => {
          const { error } = await S.sb.from('blocked_times').update({ label: x.label.value, lift_id: x.lift.value || null, weekdays: readWd(x.wd), start_time: x.s.value, end_time: x.e.value }).eq('id', b.id);
          error ? toast(errText(error), true) : toast('Vistað');
        },
      }, 'Vista'), ' ', h('button', { class: 'btn sm danger', onclick: () => del(b) }, 'Eyða')));
  });
  const nw = { label: h('input', { type: 'text', placeholder: 'T.d. Hádegi' }), lift: liftSel(''), wd: wdBoxes([1, 2, 3, 4, 5]), s: h('input', { type: 'time', value: '12:00' }), e: h('input', { type: 'time', value: '12:30' }) };

  const oRows = once.map((b) => h('tr', {}, h('td', {}, b.label), h('td', {}, liftById(b.lift_id)?.name || 'Allar lyftur'), h('td', {}, fmtDT(b.starts_at)), h('td', {}, fmtDT(b.ends_at)),
    h('td', {}, h('button', { class: 'btn sm danger', onclick: () => del(b) }, 'Eyða'))));
  const no = { label: h('input', { type: 'text', placeholder: 'T.d. Lyfta í viðgerð / Jólafrí' }), lift: liftSel(''), s: h('input', { type: 'datetime-local' }), e: h('input', { type: 'datetime-local' }) };

  el.replaceChildren(
    h('div', { class: 'hint' }, 'Á lokuðum tímum er ekki hægt að bóka (hvorki starfsfólk né netbókun). Gildir fyrir allar lyftur eða eina lyftu.'),
    h('h3', { style: { margin: 0 } }, 'Endurteknir (vikulega)'),
    h('table', { class: 't' }, h('tr', {}, ['Heiti', 'Lyfta', 'Dagar', 'Frá', 'Til', ''].map((x) => h('th', {}, x))), wRows,
      h('tr', {}, h('td', {}, nw.label), h('td', {}, nw.lift), h('td', {}, nw.wd), h('td', {}, nw.s), h('td', {}, nw.e), h('td', {}, h('button', {
        class: 'btn sm primary', onclick: async () => {
          const { error } = await S.sb.from('blocked_times').insert({ kind: 'weekly', label: nw.label.value || 'Lokað', lift_id: nw.lift.value || null, weekdays: readWd(nw.wd), start_time: nw.s.value, end_time: nw.e.value });
          if (error) return toast(errText(error), true);
          await loadStatic(); setBlocked(el);
        },
      }, '+ Bæta við')))),
    h('h3', { style: { margin: '10px 0 0' } }, 'Stök tímabil'),
    h('table', { class: 't' }, h('tr', {}, ['Heiti', 'Lyfta', 'Frá', 'Til', ''].map((x) => h('th', {}, x))), oRows,
      h('tr', {}, h('td', {}, no.label), h('td', {}, no.lift), h('td', {}, no.s), h('td', {}, no.e), h('td', {}, h('button', {
        class: 'btn sm primary', onclick: async () => {
          if (!no.s.value || !no.e.value) return toast('Veldu frá og til.', true);
          const { error } = await S.sb.from('blocked_times').insert({ kind: 'once', label: no.label.value || 'Lokað', lift_id: no.lift.value || null, starts_at: new Date(no.s.value + ':00Z').toISOString(), ends_at: new Date(no.e.value + ':00Z').toISOString() });
          if (error) return toast(errText(error), true);
          await loadStatic(); setBlocked(el);
        },
      }, '+ Bæta við')))));
}

function setLifts(el) {
  const rows = S.lifts.map((l) => {
    const x = {
      name: h('input', { type: 'text', value: l.name }), color: h('input', { type: 'color', value: l.color, style: { width: '46px', padding: '2px' } }),
      sort: h('input', { type: 'number', value: l.sort, style: { width: '64px' } }), active: h('input', { type: 'checkbox', checked: l.active }),
      mailbox: h('input', { type: 'email', value: l.outlook_mailbox || '', placeholder: 'lyfta1@nysprautun.is' }),
      cal: h('select', {}, h('option', { value: l.outlook_calendar_id || '' }, l.outlook_calendar_id ? 'Valið dagatal' : 'Sjálfgefið dagatal')),
    };
    const findCals = h('button', {
      class: 'btn sm', onclick: async () => {
        if (!x.mailbox.value) return toast('Sláðu inn pósthólf fyrst.', true);
        try {
          const cals = await api('/api/admin/calendars', { mailbox: x.mailbox.value });
          x.cal.replaceChildren(h('option', { value: '' }, 'Sjálfgefið dagatal'), cals.map((c) => h('option', { value: c.id, selected: c.id === l.outlook_calendar_id }, c.name + (c.isDefaultCalendar ? ' (sjálfgefið)' : ''))));
          toast(`${cals.length} dagatöl fundust`);
        } catch (e) { toast(errText(e), true); }
      },
    }, 'Sækja dagatöl');
    return h('tr', {}, h('td', {}, x.sort), h('td', {}, x.name), h('td', {}, x.color), h('td', {}, x.active),
      h('td', {}, x.mailbox), h('td', {}, h('div', { class: 'row' }, x.cal, S.outlook ? findCals : null)),
      h('td', { class: 'muted', style: { fontSize: '12px' } }, l.outlook_synced_at ? fmtDT(l.outlook_synced_at) : '—'),
      h('td', {}, h('button', {
        class: 'btn sm', onclick: async () => {
          const changedCal = x.mailbox.value !== (l.outlook_mailbox || '') || x.cal.value !== (l.outlook_calendar_id || '');
          const patch = { name: x.name.value, color: x.color.value, sort: +x.sort.value, active: x.active.checked, outlook_mailbox: x.mailbox.value || null, outlook_calendar_id: x.cal.value || null };
          if (changedCal) patch.outlook_delta_link = null;
          const { error } = await S.sb.from('lifts').update(patch).eq('id', l.id);
          error ? toast(errText(error), true) : toast('Vistað');
        },
      }, 'Vista')));
  });
  el.replaceChildren(
    h('table', { class: 't' }, h('tr', {}, ['Röð', 'Heiti', 'Litur', 'Virk', 'Outlook-pósthólf', 'Dagatal', 'Síðast samstillt', ''].map((x) => h('th', {}, x))), rows),
    h('div', {}, h('button', {
      class: 'btn', onclick: async () => {
        await S.sb.from('lifts').insert({ name: `Lyfta ${S.lifts.length + 1}`, sort: S.lifts.length + 1 });
        await loadStatic(); setLifts(el);
      },
    }, '+ Bæta við lyftu')),
    S.outlook
      ? h('div', { class: 'hint' }, 'Outlook-samstilling er virk og keyrir á 5 mínútna fresti. Bókanir í kerfinu birtast í dagatali lyftunnar, og það sem er skráð beint í Outlook birtist hér (merkt „Outlook“). ', h('button', { class: 'btn sm', onclick: syncNow }, 'Samstilla núna'))
      : h('div', { class: 'warn' }, 'Outlook-samstilling er ekki enn tengd. Þegar Azure app-skráningin er komin (MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET í worker) birtist hún hér.'));
}

function setServices(el) {
  const rows = S.services.map((s) => {
    const x = { name: h('input', { type: 'text', value: s.name }), dur: h('input', { type: 'number', min: 5, step: 5, value: s.duration_minutes, style: { width: '90px' } }), online: h('input', { type: 'checkbox', checked: s.online_bookable }), active: h('input', { type: 'checkbox', checked: s.active }), sort: h('input', { type: 'number', value: s.sort, style: { width: '64px' } }) };
    return h('tr', {}, h('td', {}, x.sort), h('td', {}, x.name), h('td', {}, x.dur), h('td', {}, x.online), h('td', {}, x.active),
      h('td', {}, h('button', {
        class: 'btn sm', onclick: async () => {
          const { error } = await S.sb.from('services').update({ name: x.name.value, duration_minutes: +x.dur.value, online_bookable: x.online.checked, active: x.active.checked, sort: +x.sort.value }).eq('id', s.id);
          error ? toast(errText(error), true) : toast('Vistað');
        },
      }, 'Vista')));
  });
  const nw = { name: h('input', { type: 'text', placeholder: 'Heiti verks' }), dur: h('input', { type: 'number', min: 5, step: 5, value: 60, style: { width: '90px' } }) };
  el.replaceChildren(
    h('table', { class: 't' }, h('tr', {}, ['Röð', 'Heiti', 'Lengd (mín)', 'Í netbókun', 'Virkt', ''].map((x) => h('th', {}, x))), rows,
      h('tr', {}, h('td', {}), h('td', {}, nw.name), h('td', {}, nw.dur), h('td', {}), h('td', {}), h('td', {}, h('button', {
        class: 'btn sm primary', onclick: async () => {
          if (!nw.name.value) return;
          const { error } = await S.sb.from('services').insert({ name: nw.name.value, duration_minutes: +nw.dur.value, sort: S.services.length + 1 });
          if (error) return toast(errText(error), true);
          await loadStatic(); setServices(el);
        },
      }, '+ Bæta við')))),
    h('div', { class: 'hint' }, 'Lengdin er sjálfgefin þegar verk er valið í bókun; það má alltaf breyta henni.'));
}

function setMessages(el) {
  const s = S.settings;
  const i = {
    sms_enabled: h('input', { type: 'checkbox', checked: s.sms_enabled }),
    email_enabled: h('input', { type: 'checkbox', checked: s.email_enabled }),
    reminder_hour: h('select', {}, Array.from({ length: 24 }, (_, k) => h('option', { value: k, selected: k === s.reminder_hour }, `kl. ${pad(k)}:00`))),
    reminder_sms_template: h('textarea', { rows: 2 }, s.reminder_sms_template),
    ready_sms_template: h('textarea', { rows: 2 }, s.ready_sms_template),
    confirm_email_subject: h('input', { type: 'text', value: s.confirm_email_subject }),
    confirm_email_body: h('textarea', { rows: 7 }, s.confirm_email_body),
    request_email_subject: h('input', { type: 'text', value: s.request_email_subject }),
    request_email_body: h('textarea', { rows: 5 }, s.request_email_body),
  };
  const smsLen = (ta) => { const n = h('span', { class: 'muted' }); const u = () => { n.textContent = ` ~${ta.value.length} stafir (SMS er sent án íslenskra stafa)`; }; ta.addEventListener('input', u); u(); return n; };
  el.replaceChildren(
    h('div', { class: 'hint' }, 'Breytur: {nafn} {bilnumer} {dagur} {timi} {verk} {verkstaedi} {simi} {opnunartimi}'),
    h('div', { class: 'row' }, h('label', { class: 'row' }, i.sms_enabled, 'SMS virkt (Twilio)'), h('label', { class: 'row' }, i.email_enabled, 'Tölvupóstur virkur (Resend)')),
    field('SMS-áminning send daginn fyrir, eftir', i.reminder_hour),
    field('SMS-áminning', i.reminder_sms_template), smsLen(i.reminder_sms_template),
    field('SMS: bíll tilbúinn', i.ready_sms_template), smsLen(i.ready_sms_template),
    field('Staðfesting í tölvupósti – efni', i.confirm_email_subject),
    field('Staðfesting í tölvupósti – texti', i.confirm_email_body),
    field('Beiðni móttekin – efni', i.request_email_subject),
    field('Beiðni móttekin – texti', i.request_email_body),
    h('div', {}, h('button', {
      class: 'btn primary', onclick: () => saveSettings({
        sms_enabled: i.sms_enabled.checked, email_enabled: i.email_enabled.checked, reminder_hour: +i.reminder_hour.value,
        reminder_sms_template: i.reminder_sms_template.value, ready_sms_template: i.ready_sms_template.value,
        confirm_email_subject: i.confirm_email_subject.value, confirm_email_body: i.confirm_email_body.value,
        request_email_subject: i.request_email_subject.value, request_email_body: i.request_email_body.value,
      }),
    }, 'Vista')));
}

function setStaff(el) {
  const rows = S.profiles.map((p) => {
    const role = h('select', {}, h('option', { value: 'staff', selected: p.role === 'staff' }, 'Starfsmaður'), h('option', { value: 'admin', selected: p.role === 'admin' }, 'Stjórnandi'));
    const active = h('input', { type: 'checkbox', checked: p.active, disabled: p.id === S.me.id });
    const name = h('input', { type: 'text', value: p.name });
    return h('tr', {}, h('td', {}, name), h('td', {}, p.email), h('td', {}, role), h('td', {}, active),
      h('td', {}, h('button', {
        class: 'btn sm', onclick: async () => {
          const { error } = await S.sb.from('profiles').update({ name: name.value, role: role.value, active: active.checked }).eq('id', p.id);
          error ? toast(errText(error), true) : toast('Vistað');
        },
      }, 'Vista')));
  });
  const ni = { email: h('input', { type: 'email', placeholder: 'netfang@nysprautun.is' }), name: h('input', { type: 'text', placeholder: 'Nafn' }), role: h('select', {}, h('option', { value: 'staff' }, 'Starfsmaður'), h('option', { value: 'admin' }, 'Stjórnandi')) };
  el.replaceChildren(
    h('table', { class: 't' }, h('tr', {}, ['Nafn', 'Netfang', 'Hlutverk', 'Virkur', ''].map((x) => h('th', {}, x))), rows),
    h('h3', { style: { margin: '10px 0 0' } }, 'Bjóða nýjum starfsmanni'),
    h('div', { class: 'grid3' }, ni.email, ni.name, ni.role),
    h('div', {}, h('button', {
      class: 'btn primary', onclick: async () => {
        try { await api('/api/admin/invite', { email: ni.email.value, name: ni.name.value, role: ni.role.value }); toast('Boð sent í tölvupósti'); m2(); }
        catch (e) { toast(errText(e), true); }
      },
    }, 'Senda boð')),
    h('div', { class: 'hint' }, 'Viðkomandi fær tölvupóst með hlekk og velur sér lykilorð.'));
  const m2 = async () => { const { data } = await S.sb.from('profiles').select('*').order('name'); S.profiles = data || []; setStaff(el); };
}

boot().catch((e) => { console.error(e); $('#app').replaceChildren(h('div', { class: 'boot' }, 'Villa við ræsingu: ' + e.message)); });
