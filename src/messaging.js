// SMS (Twilio) og tölvupóstur (Resend). Allt skráð í message_log.
import { sb, asciiIs, normPhone } from './util.js';

async function log(env, row) {
  try { await sb(env, 'message_log', { method: 'POST', body: row }); } catch (e) { console.error('log', e.message); }
}

export async function sendSms(env, settings, { to, body, kind, booking_id = null, request_id = null }) {
  const phone = normPhone(to);
  const text = asciiIs(body);
  if (!settings.sms_enabled || !env.TWILIO_SID || !env.TWILIO_TOKEN) {
    await log(env, { channel: 'sms', kind, to_addr: phone || String(to), body: text, status: 'skipped', error: 'SMS óvirkt', booking_id, request_id });
    return { ok: false, skipped: true };
  }
  if (!phone) return { ok: false, error: 'Ekkert símanúmer' };
  const form = new URLSearchParams({ To: phone, Body: text });
  if (env.TWILIO_MESSAGING_SERVICE_SID) form.set('MessagingServiceSid', env.TWILIO_MESSAGING_SERVICE_SID);
  else form.set('From', env.TWILIO_FROM);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, {
    method: 'POST',
    headers: { authorization: 'Basic ' + btoa(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`) },
    body: form,
  });
  const data = await res.json().catch(() => ({}));
  const ok = res.ok;
  await log(env, { channel: 'sms', kind, to_addr: phone, body: text, status: ok ? 'sent' : 'failed', provider_id: data.sid || null, error: ok ? null : (data.message || res.statusText), booking_id, request_id });
  return { ok, error: ok ? null : data.message };
}

export async function sendEmail(env, settings, { to, subject, text, kind, booking_id = null, request_id = null, replyTo }) {
  if (!to) return { ok: false, error: 'Ekkert netfang' };
  if (!settings.email_enabled || !env.RESEND_API_KEY) {
    await log(env, { channel: 'email', kind, to_addr: to, body: subject, status: 'skipped', error: 'Tölvupóstur óvirkur', booking_id, request_id });
    return { ok: false, skipped: true };
  }
  const html = `<div style="font-family:system-ui,sans-serif;font-size:15px;line-height:1.5;color:#111">${escapeHtml(text).replace(/\n/g, '<br>')}</div>`;
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: env.MAIL_FROM || `${settings.shop_name} <timabokanir@nysprautun.is>`,
      to: [to],
      subject,
      text,
      html,
      ...(replyTo || settings.shop_email ? { reply_to: replyTo || settings.shop_email } : {}),
    }),
  });
  const data = await res.json().catch(() => ({}));
  const ok = res.ok;
  await log(env, { channel: 'email', kind, to_addr: to, body: subject, status: ok ? 'sent' : 'failed', provider_id: data.id || null, error: ok ? null : (data.message || res.statusText), booking_id, request_id });
  return { ok, error: ok ? null : data.message };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}
