// Tvíátta samstilling við Outlook-dagatöl (eitt dagatal = ein lyfta) gegnum Microsoft Graph.
// Krefst Azure app-skráningar með Application-heimildinni Calendars.ReadWrite (admin consent).
// Umhverfisbreytur: MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET
import { sb } from './util.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';

export function outlookConfigured(env) {
  return !!(env.MS_TENANT_ID && env.MS_CLIENT_ID && env.MS_CLIENT_SECRET);
}

async function token(env) {
  const res = await fetch(`https://login.microsoftonline.com/${env.MS_TENANT_ID}/oauth2/v2.0/token`, {
    method: 'POST',
    body: new URLSearchParams({
      client_id: env.MS_CLIENT_ID,
      client_secret: env.MS_CLIENT_SECRET,
      scope: 'https://graph.microsoft.com/.default',
      grant_type: 'client_credentials',
    }),
  });
  const d = await res.json();
  if (!res.ok) throw new Error('Graph token: ' + (d.error_description || d.error));
  return d.access_token;
}

async function graph(tok, url, { method = 'GET', body, headers = {} } = {}) {
  const res = await fetch(url.startsWith('http') ? url : GRAPH + url, {
    method,
    headers: {
      authorization: `Bearer ${tok}`,
      'content-type': 'application/json',
      prefer: 'outlook.timezone="UTC", odata.maxpagesize=100',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const d = await res.json().catch(() => ({}));
  if (!res.ok) {
    const e = new Error(`Graph ${method} ${res.status}: ${d.error?.message || ''}`);
    e.status = res.status;
    throw e;
  }
  return d;
}

function calBase(lift) {
  const mb = encodeURIComponent(lift.outlook_mailbox);
  return lift.outlook_calendar_id
    ? `/users/${mb}/calendars/${encodeURIComponent(lift.outlook_calendar_id)}`
    : `/users/${mb}/calendar`;
}
function evBase(lift) {
  return `/users/${encodeURIComponent(lift.outlook_mailbox)}/events`;
}

const iso = (s) => new Date(s).toISOString().replace(/\.\d{3}Z$/, '').replace('Z', '');
const STATUS = { booked: '', in_progress: '[Í vinnslu] ', ready: '[Tilbúinn] ', picked_up: '[Sóttur] ' };

function eventBody(b, serviceName) {
  const subject = `${STATUS[b.status] || ''}${[b.plate, b.customer_name, serviceName || b.title].filter(Boolean).join(' – ')}`;
  const lines = [
    b.customer_name && `Nafn: ${b.customer_name}`,
    b.phone && `Sími: ${b.phone}`,
    b.email && `Netfang: ${b.email}`,
    b.plate && `Bílnúmer: ${b.plate}`,
    serviceName && `Verk: ${serviceName}`,
    b.notes && `\n${b.notes}`,
  ].filter(Boolean);
  return {
    subject: subject || 'Bókun',
    body: { contentType: 'text', content: lines.join('\n') },
    start: { dateTime: iso(b.starts_at), timeZone: 'UTC' },
    end: { dateTime: iso(b.ends_at), timeZone: 'UTC' },
    showAs: 'busy',
    isReminderOn: false,
  };
}

// ---------- Kerfi → Outlook ----------
async function pushChanges(env, tok, lifts) {
  const liftById = Object.fromEntries(lifts.map((l) => [l.id, l]));
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const dirty = await sb(env, `bookings?outlook_dirty=eq.true&ends_at=gte.${since}&select=*,services(name)&limit=100`);
  let pushed = 0;
  for (const b of dirty) {
    const lift = liftById[b.lift_id];
    const oldLift = liftById[b.outlook_lift_id] || lift;
    try {
      const dead = ['cancelled', 'no_show'].includes(b.status);
      // Lyfta breyttist: eyða atburði í gamla dagatalinu
      if (b.outlook_event_id && (dead || b.outlook_lift_id !== b.lift_id) && oldLift?.outlook_mailbox) {
        await graph(tok, `${evBase(oldLift)}/${b.outlook_event_id}`, { method: 'DELETE' }).catch((e) => { if (e.status !== 404) throw e; });
        b.outlook_event_id = null;
      }
      let patch = { outlook_dirty: false, outlook_synced_at: new Date().toISOString() };
      if (!dead && lift?.outlook_mailbox) {
        const body = eventBody(b, b.services?.name);
        let ev;
        if (b.outlook_event_id) {
          ev = await graph(tok, `${evBase(lift)}/${b.outlook_event_id}`, { method: 'PATCH', body });
        } else {
          ev = await graph(tok, `${calBase(lift)}/events`, { method: 'POST', body: { ...body, transactionId: b.id } });
        }
        patch = { ...patch, outlook_event_id: ev.id, outlook_change_key: ev.changeKey, outlook_lift_id: lift.id };
      } else {
        patch = { ...patch, outlook_event_id: null, outlook_change_key: null, outlook_lift_id: null };
      }
      await sb(env, `bookings?id=eq.${b.id}`, { method: 'PATCH', body: patch });
      pushed++;
    } catch (e) {
      console.error('outlook push', b.id, e.message);
    }
  }
  return pushed;
}

// ---------- Outlook → kerfi ----------
async function pullChanges(env, tok, lift) {
  const start = new Date(Date.now() - 14 * 864e5).toISOString();
  const end = new Date(Date.now() + 365 * 864e5).toISOString();
  let url = lift.outlook_delta_link ||
    `${calBase(lift)}/calendarView/delta?startDateTime=${start}&endDateTime=${end}`;
  let pulled = 0;
  let deltaLink = null;
  while (url) {
    let page;
    try {
      page = await graph(tok, url);
    } catch (e) {
      if (e.status === 410 || e.status === 400) {
        // Útrunninn delta-tengill: byrja upp á nýtt
        await sb(env, `lifts?id=eq.${lift.id}`, { method: 'PATCH', body: { outlook_delta_link: null } });
        if (lift.outlook_delta_link) { lift.outlook_delta_link = null; return pullChanges(env, tok, lift); }
      }
      throw e;
    }
    for (const ev of page.value || []) {
      try { pulled += await applyEvent(env, lift, ev); }
      catch (e) { console.error('outlook pull', lift.name, ev.id, e.message); }
    }
    url = page['@odata.nextLink'] || null;
    deltaLink = page['@odata.deltaLink'] || deltaLink;
  }
  await sb(env, `lifts?id=eq.${lift.id}`, {
    method: 'PATCH',
    body: { outlook_delta_link: deltaLink, outlook_synced_at: new Date().toISOString() },
  });
  return pulled;
}

async function applyEvent(env, lift, ev) {
  const existing = (await sb(env, `bookings?outlook_event_id=eq.${encodeURIComponent(ev.id)}&select=id,source,outlook_change_key,lift_id`))[0];
  if (ev['@removed']) {
    if (!existing) return 0;
    if (existing.source === 'outlook') {
      await sb(env, `bookings?id=eq.${existing.id}`, { method: 'DELETE' });
    } else {
      // Bókun úr kerfinu sem var eytt í Outlook: afbóka (ekki eyða gögnum)
      await sb(env, `bookings?id=eq.${existing.id}`, { method: 'PATCH', body: { status: 'cancelled', outlook_event_id: null, outlook_change_key: 'removed:' + Date.now(), outlook_dirty: false } });
    }
    return 1;
  }
  if (ev.isCancelled) return 0;
  if (existing && existing.outlook_change_key === ev.changeKey) return 0; // okkar eigin breyting
  const starts = ev.start?.dateTime ? new Date(ev.start.dateTime + 'Z').toISOString() : null;
  const ends = ev.end?.dateTime ? new Date(ev.end.dateTime + 'Z').toISOString() : null;
  if (!starts || !ends || ends <= starts) return 0;
  const subject = (ev.subject || '').replace(/^\[(Í vinnslu|Tilbúinn|Sóttur)\]\s*/, '');
  if (existing) {
    const patch = { starts_at: starts, ends_at: ends, outlook_change_key: ev.changeKey, outlook_dirty: false };
    if (existing.source === 'outlook') { patch.title = subject; patch.notes = ev.bodyPreview || ''; }
    await sb(env, `bookings?id=eq.${existing.id}`, { method: 'PATCH', body: patch });
  } else {
    // Atburður sem var búinn til í Outlook — er hann frá okkur (transactionId = bókunar-id)?
    if (ev.transactionId && /^[0-9a-f-]{36}$/.test(ev.transactionId)) {
      const mine = (await sb(env, `bookings?id=eq.${ev.transactionId}&select=id`))[0];
      if (mine) {
        await sb(env, `bookings?id=eq.${mine.id}`, { method: 'PATCH', body: { outlook_event_id: ev.id, outlook_change_key: ev.changeKey, outlook_lift_id: lift.id, outlook_dirty: false } });
        return 0;
      }
    }
    await sb(env, 'bookings', {
      method: 'POST',
      body: {
        lift_id: lift.id, starts_at: starts, ends_at: ends, title: subject, notes: ev.bodyPreview || '',
        source: 'outlook', send_reminder: false, created_by: null,
        outlook_event_id: ev.id, outlook_change_key: ev.changeKey, outlook_lift_id: lift.id, outlook_dirty: false,
      },
    });
  }
  return 1;
}

export async function syncOutlook(env) {
  if (!outlookConfigured(env)) return { skipped: 'Outlook ekki stillt' };
  const lifts = await sb(env, 'lifts?select=*&order=sort');
  const linked = lifts.filter((l) => l.active && l.outlook_mailbox);
  if (!linked.length) return { skipped: 'Engin lyfta tengd Outlook' };
  const tok = await token(env);
  const out = { pushed: 0, pulled: 0, errors: [] };
  try { out.pushed = await pushChanges(env, tok, lifts); } catch (e) { out.errors.push('push: ' + e.message); }
  for (const l of linked) {
    try { out.pulled += await pullChanges(env, tok, l); } catch (e) { out.errors.push(`${l.name}: ${e.message}`); }
  }
  return out;
}

// Listi yfir dagatöl í pósthólfi (hjálp í stillingum)
export async function listCalendars(env, mailbox) {
  const tok = await token(env);
  const d = await graph(tok, `/users/${encodeURIComponent(mailbox)}/calendars?$select=id,name,isDefaultCalendar`);
  return d.value;
}
