// Sameiginleg hjálparföll fyrir worker

export const TZ = 'Atlantic/Reykjavik'; // = UTC allt árið

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

// Supabase REST með service-lykli (framhjá RLS — aðeins notað í worker)
export async function sb(env, path, { method = 'GET', body, prefer, headers = {} } = {}) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: env.SUPABASE_SERVICE_KEY,
      authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
      'content-type': 'application/json',
      ...(prefer ? { prefer } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || text || res.statusText;
    const err = new Error(msg);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export async function getSettings(env) {
  const rows = await sb(env, 'settings?id=eq.1&select=*');
  return rows[0];
}

// Starfsmaður: staðfestir Supabase JWT og að prófíll sé virkur
export async function requireStaff(env, request, { admin = false } = {}) {
  const auth = request.headers.get('authorization') || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) throw httpError(401, 'Ekki innskráður');
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw httpError(401, 'Innskráning útrunnin');
  const user = await res.json();
  const rows = await sb(env, `profiles?id=eq.${user.id}&select=*`);
  const p = rows[0];
  if (!p || !p.active) throw httpError(403, 'Aðgangur ekki virkur');
  if (admin && p.role !== 'admin') throw httpError(403, 'Aðeins stjórnendur');
  return p;
}

export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

// ---------- Íslenskar dagsetningar ----------
const DAYS = ['sunnudaginn', 'mánudaginn', 'þriðjudaginn', 'miðvikudaginn', 'fimmtudaginn', 'föstudaginn', 'laugardaginn'];
const MONTHS = ['janúar', 'febrúar', 'mars', 'apríl', 'maí', 'júní', 'júlí', 'ágúst', 'september', 'október', 'nóvember', 'desember'];

export function isDate(iso) {
  const d = new Date(iso);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()}. ${MONTHS[d.getUTCMonth()]}`;
}
export function isTime(iso) {
  const d = new Date(iso);
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;
}

// ---------- SMS-texti án íslenskra stafa (sama regla og hjá John Tailor) ----------
const MAP = { á: 'a', Á: 'A', ð: 'd', Ð: 'D', é: 'e', É: 'E', í: 'i', Í: 'I', ó: 'o', Ó: 'O', ú: 'u', Ú: 'U', ý: 'y', Ý: 'Y', þ: 'th', Þ: 'Th', æ: 'ae', Æ: 'Ae', ö: 'o', Ö: 'O', '–': '-', '—': '-', '„': '"', '“': '"', '’': "'" };
export function asciiIs(s) {
  return String(s).replace(/[^\x00-\x7F]/g, (c) => MAP[c] ?? '');
}

export function fill(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? ''));
}

export function normPhone(p) {
  let s = String(p || '').replace(/[^\d+]/g, '');
  if (!s) return '';
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (/^\d{7}$/.test(s)) s = '+354' + s;
  if (/^354\d{7}$/.test(s)) s = '+' + s;
  return s;
}

export function normPlate(p) {
  return String(p || '').toUpperCase().replace(/[^A-Z0-9ÁÐÉÍÓÚÝÞÆÖ]/g, '');
}

export async function openingText(env, iso) {
  const d = iso ? new Date(iso) : new Date();
  const wd = ((d.getUTCDay() + 6) % 7) + 1;
  const rows = await sb(env, `opening_hours?weekday=eq.${wd}&select=*`);
  const r = rows[0];
  if (!r || r.closed) return 'naesta virka dag';
  return `${r.open_time.slice(0, 5)}-${r.close_time.slice(0, 5)}`;
}

export async function bookingVars(env, b, settings) {
  let service = '';
  if (b.service_id) {
    const s = await sb(env, `services?id=eq.${b.service_id}&select=name`);
    service = s[0]?.name || '';
  }
  return {
    verkstaedi: settings.shop_name,
    simi: settings.shop_phone,
    nafn: b.customer_name || '',
    bilnumer: b.plate || '',
    dagur: isDate(b.starts_at),
    timi: isTime(b.starts_at),
    verk: service || b.title || '',
    opnunartimi: await openingText(env),
  };
}
