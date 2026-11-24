// Nýsprautun tímabókanir — Cloudflare Worker
// Þjónar starfsmannaviðmóti (/), netbókunarsíðu (/boka) og API. Cron sendir áminningar og samstillir Outlook.
import { appHtml, appJs, appCss, bokaHtml } from './assets.js'; // búið til af build.mjs úr public/
import { json, sb, getSettings, requireStaff, httpError, normPhone, normPlate, fill, bookingVars, isDate } from './util.js';
import { sendSms, sendEmail } from './messaging.js';
import { syncOutlook, listCalendars, outlookConfigured } from './outlook.js';

const SEC = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
};

function page(body, type, extra = {}) {
  return new Response(body, { headers: { 'content-type': type, 'cache-control': 'no-cache', ...SEC, ...extra } });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

      // ----- Síður -----
      if (p === '/' || p === '/index.html') return page(appHtml, 'text/html; charset=utf-8', { 'x-frame-options': 'DENY' });
      if (p === '/app.js') return page(appJs, 'text/javascript; charset=utf-8');
      if (p === '/app.css') return page(appCss, 'text/css; charset=utf-8');
      // Netbókunarsíðan má birtast í iframe á nysprautun.is
      if (p === '/boka' || p === '/boka/') return page(bokaHtml, 'text/html; charset=utf-8', {
        'content-security-policy': "frame-ancestors 'self' https://nysprautun.is https://www.nysprautun.is https://*.dudaone.com https://*.multiscreensite.com https://*.duda.co",
      });

      // ----- Opið API -----
      if (p === '/api/config') {
        return json({ supabaseUrl: env.SUPABASE_URL, anonKey: env.SUPABASE_ANON_KEY, outlook: outlookConfigured(env) });
      }
      if (p === '/api/public/options' && request.method === 'GET') return cors(await publicOptions(env));
      if (p === '/api/public/request' && request.method === 'POST') return cors(await publicRequest(env, request));

      // ----- Starfsfólk -----
      if (p === '/api/staff/notify' && request.method === 'POST') {
        await requireStaff(env, request);
        return json(await staffNotify(env, await request.json()));
      }
      if (p === '/api/staff/request-accepted' && request.method === 'POST') {
        const me = await requireStaff(env, request);
        return json(await requestAccepted(env, me, await request.json()));
      }
      if (p === '/api/staff/sync' && request.method === 'POST') {
        await requireStaff(env, request);
        return json(await syncOutlook(env));
      }
      if (p === '/api/admin/calendars' && request.method === 'POST') {
        await requireStaff(env, request, { admin: true });
        const { mailbox } = await request.json();
        return json(await listCalendars(env, mailbox));
      }
      if (p === '/api/admin/invite' && request.method === 'POST') {
        await requireStaff(env, request, { admin: true });
        return json(await invite(env, url, await request.json()));
      }
      return new Response('Fannst ekki', { status: 404 });
    } catch (e) {
      console.error(p, e.stack || e.message);
      return cors(json({ error: e.message || 'Villa' }, e.status || 500));
    }
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env));
  },
};

function cors(res) {
  const h = new Headers(res.headers);
  h.set('access-control-allow-origin', '*');
  h.set('access-control-allow-methods', 'GET,POST,OPTIONS');
  h.set('access-control-allow-headers', 'content-type');
  return new Response(res.body, { status: res.status, headers: h });
}

// ======================================================================
// Netbókun
// ======================================================================
async function publicOptions(env) {
  const [settings, services, hours, blocked] = await Promise.all([
    getSettings(env),
    sb(env, 'services?active=eq.true&online_bookable=eq.true&select=id,name,duration_minutes&order=sort'),
    sb(env, 'opening_hours?select=*&order=weekday'),
    sb(env, `blocked_times?kind=eq.once&lift_id=is.null&ends_at=gte.${new Date().toISOString()}&select=starts_at,ends_at,label`),
  ]);
  return json({
    enabled: settings.online_booking_enabled,
    shop: { name: settings.shop_name, phone: settings.shop_phone, email: settings.shop_email },
    minDays: settings.online_min_days_ahead,
    maxDays: settings.online_max_days_ahead,
    services,
    hours,
    closures: blocked,
  });
}

async function publicRequest(env, request) {
  const settings = await getSettings(env);
  if (!settings.online_booking_enabled) throw httpError(400, 'Netbókun er lokuð í augnablikinu.');
  const b = await request.json().catch(() => ({}));
  if (b.website) return json({ ok: true }); // hunangsgildra fyrir róbóta
  const name = String(b.name || '').trim().slice(0, 120);
  const phone = normPhone(b.phone);
  const email = String(b.email || '').trim().slice(0, 200);
  const plate = normPlate(b.plate).slice(0, 10);
  if (!name || !phone || !plate) throw httpError(400, 'Nafn, símanúmer og bílnúmer eru nauðsynleg.');
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw httpError(400, 'Netfang er ekki gilt.');
  const date = /^\d{4}-\d{2}-\d{2}$/.test(b.preferred_date || '') ? b.preferred_date : null;
  const alt = /^\d{4}-\d{2}-\d{2}$/.test(b.alt_date || '') ? b.alt_date : null;
  const part = ['any', 'morning', 'afternoon'].includes(b.preferred_part) ? b.preferred_part : 'any';

  // Einföld takmörkun: 5 beiðnir á klst frá sömu IP-tölu
  const ip = request.headers.get('cf-connecting-ip') || '';
  if (ip) {
    const since = new Date(Date.now() - 3600e3).toISOString();
    const recent = await sb(env, `booking_requests?ip=eq.${encodeURIComponent(ip)}&created_at=gte.${since}&select=id`);
    if (recent.length >= 5) throw httpError(429, 'Of margar beiðnir. Reyndu aftur síðar eða hringdu.');
  }

  let service = null;
  if (b.service_id) service = (await sb(env, `services?id=eq.${b.service_id}&active=eq.true&select=id,name`))[0] || null;

  const [row] = await sb(env, 'booking_requests', {
    method: 'POST',
    prefer: 'return=representation',
    body: {
      name, phone, email: email || null, plate, service_id: service?.id || null,
      preferred_date: date, alt_date: alt, preferred_part: part,
      notes: String(b.notes || '').slice(0, 2000), ip,
    },
  });

  const vars = { verkstaedi: settings.shop_name, simi: settings.shop_phone, nafn: name, bilnumer: plate, verk: service?.name || '' };
  if (email) {
    await sendEmail(env, settings, {
      to: email, kind: 'request_received', request_id: row.id,
      subject: fill(settings.request_email_subject, vars),
      text: fill(settings.request_email_body, vars),
    });
  }
  if (settings.staff_notify_email) {
    const partTxt = { any: 'hvenær sem er', morning: 'fyrir hádegi', afternoon: 'eftir hádegi' }[part];
    await sendEmail(env, settings, {
      to: settings.staff_notify_email, kind: 'request_staff', request_id: row.id, replyTo: email || undefined,
      subject: `Ný tímabeiðni: ${plate} – ${name}`,
      text: `Ný beiðni um tíma í netbókun.\n\nNafn: ${name}\nSími: ${phone}\nNetfang: ${email || '-'}\nBílnúmer: ${plate}\nVerk: ${service?.name || '-'}\nÓskadagur: ${date ? isDate(date + 'T00:00:00Z') : '-'} (${partTxt})\nVaradagur: ${alt ? isDate(alt + 'T00:00:00Z') : '-'}\n\n${b.notes || ''}`,
    });
  }
  return json({ ok: true });
}

// ======================================================================
// Starfsfólk: skilaboð
// ======================================================================
async function staffNotify(env, { booking_id, kind }) {
  const settings = await getSettings(env);
  const b = (await sb(env, `bookings?id=eq.${booking_id}&select=*`))[0];
  if (!b) throw httpError(404, 'Bókun fannst ekki');
  const vars = await bookingVars(env, b, settings);
  if (kind === 'ready') {
    const r = await sendSms(env, settings, { to: b.phone, body: fill(settings.ready_sms_template, vars), kind: 'ready', booking_id: b.id });
    if (r.ok) await sb(env, `bookings?id=eq.${b.id}`, { method: 'PATCH', body: { ready_sms_at: new Date().toISOString() } });
    return r;
  }
  if (kind === 'confirm') {
    const r = await sendEmail(env, settings, {
      to: b.email, kind: 'confirm', booking_id: b.id,
      subject: fill(settings.confirm_email_subject, vars),
      text: fill(settings.confirm_email_body, vars),
    });
    if (r.ok) await sb(env, `bookings?id=eq.${b.id}`, { method: 'PATCH', body: { confirm_email_at: new Date().toISOString() } });
    return r;
  }
  if (kind === 'reminder') {
    const r = await sendSms(env, settings, { to: b.phone, body: fill(settings.reminder_sms_template, vars), kind: 'reminder', booking_id: b.id });
    if (r.ok) await sb(env, `bookings?id=eq.${b.id}`, { method: 'PATCH', body: { reminder_sent_at: new Date().toISOString() } });
    return r;
  }
  throw httpError(400, 'Óþekkt tegund');
}

async function requestAccepted(env, me, { request_id, booking_id, send_email = true }) {
  await sb(env, `booking_requests?id=eq.${request_id}`, {
    method: 'PATCH',
    body: { status: 'accepted', booking_id, handled_by: me.id, handled_at: new Date().toISOString() },
  });
  if (send_email) return staffNotify(env, { booking_id, kind: 'confirm' });
  return { ok: true };
}

async function invite(env, url, { email, name, role = 'staff' }) {
  if (!email) throw httpError(400, 'Vantar netfang');
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/invite`, {
    method: 'POST',
    headers: { apikey: env.SUPABASE_SERVICE_KEY, authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ email, data: { name }, redirect_to: `${url.origin}/` }),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) throw httpError(400, d.msg || d.message || 'Ekki tókst að bjóða notanda');
  await sb(env, `profiles?id=eq.${d.id}`, { method: 'PATCH', body: { active: true, role: role === 'admin' ? 'admin' : 'staff', name: name || '' } });
  return { ok: true };
}

// ======================================================================
// Cron (á 5 mín fresti)
// ======================================================================
async function runCron(env) {
  const out = {};
  try { out.reminders = await sendReminders(env); } catch (e) { console.error('reminders', e.message); }
  try { out.notes = await stickyReminders(env); } catch (e) { console.error('notes', e.message); }
  try { out.outlook = await syncOutlook(env); } catch (e) { console.error('outlook', e.message); }
  console.log('cron', JSON.stringify(out));
  return out;
}

// SMS-áminning daginn fyrir tímann, send eftir kl. reminder_hour
async function sendReminders(env) {
  const settings = await getSettings(env);
  const now = new Date();
  if (now.getUTCHours() < settings.reminder_hour) return 0;
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const after = new Date(tomorrow.getTime() + 864e5);
  const list = await sb(env,
    `bookings?starts_at=gte.${tomorrow.toISOString()}&starts_at=lt.${after.toISOString()}` +
    `&status=eq.booked&send_reminder=eq.true&reminder_sent_at=is.null&phone=neq.&select=*&limit=200`);
  let n = 0;
  for (const b of list) {
    const vars = await bookingVars(env, b, settings);
    const r = await sendSms(env, settings, { to: b.phone, body: fill(settings.reminder_sms_template, vars), kind: 'reminder', booking_id: b.id });
    // Merkjum líka sem „sent“ ef SMS er óvirkt, svo það sé ekki reynt aftur og aftur
    if (r.ok || r.skipped) {
      await sb(env, `bookings?id=eq.${b.id}`, { method: 'PATCH', body: { reminder_sent_at: new Date().toISOString() } });
      n++;
    }
  }
  return n;
}

// Gulir miðar með áminningu: tölvupóstur til þess sem bjó miðann til
async function stickyReminders(env) {
  const settings = await getSettings(env);
  const due = await sb(env, `sticky_notes?remind_at=lte.${new Date().toISOString()}&reminded_at=is.null&done=eq.false&select=*,profiles(email,name)&limit=50`);
  for (const n of due) {
    const to = n.profiles?.email || settings.staff_notify_email;
    if (to) {
      await sendEmail(env, settings, {
        to, kind: 'sticky_reminder',
        subject: `Áminning: ${n.body.split('\n')[0].slice(0, 60) || 'Gulur miði'}`,
        text: `Áminning af gulum miða (${isDate(n.day + 'T00:00:00Z')}):\n\n${n.body}`,
      });
    }
    await sb(env, `sticky_notes?id=eq.${n.id}`, { method: 'PATCH', body: { reminded_at: new Date().toISOString() } });
  }
  return due.length;
}
