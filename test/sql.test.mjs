// Prófar skemað í PGlite (Postgres í Node) með einföldum auth-stubbum
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire('/tmp/pgt/');
const { PGlite } = await import(require.resolve('@electric-sql/pglite'));
const { citext } = await import(require.resolve('@electric-sql/pglite/contrib/citext'));

const db = new PGlite({ extensions: { citext } });
await db.exec(`
  create schema auth;
  create table auth.users (id uuid primary key, email text, raw_user_meta_data jsonb default '{}');
  create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('request.uid', true),'')::uuid $$;
  create role authenticated; create role anon;
  create publication supabase_realtime;
`);
await db.exec(readFileSync(new URL('../supabase/migrations/0001_init.sql', import.meta.url), 'utf8'));

const one = async (q, p) => (await db.query(q, p)).rows[0];

test('fyrsti notandi verður virkur admin, næsti óvirkur', async () => {
  await db.query(`insert into auth.users (id,email) values ('11111111-1111-1111-1111-111111111111','a@x.is'),('22222222-2222-2222-2222-222222222222','b@x.is')`);
  const a = await one(`select role, active from profiles where email='a@x.is'`);
  const b = await one(`select role, active from profiles where email='b@x.is'`);
  assert.deepEqual(a, { role: 'admin', active: true });
  assert.deepEqual(b, { role: 'staff', active: false });
});

const lift = async (n) => (await one(`select id from lifts where name=$1`, [n])).id;

test('bókun á hádegi (12:00-12:30) er stöðvuð', async () => {
  const l1 = await lift('Lyfta 1');
  // 2026-11-25 er miðvikudagur
  await assert.rejects(db.query(`insert into bookings (lift_id, starts_at, ends_at) values ($1,'2026-11-25 11:30Z','2026-11-25 12:15Z')`, [l1]), /BLOCKED:Hádegi/);
  await db.query(`insert into bookings (lift_id, starts_at, ends_at, plate) values ($1,'2026-11-25 09:00Z','2026-11-25 12:00Z','AB123')`, [l1]);
});

test('skörun á sömu lyftu er stöðvuð, önnur lyfta í lagi', async () => {
  const l1 = await lift('Lyfta 1'), l2 = await lift('Lyfta 2');
  await assert.rejects(db.query(`insert into bookings (lift_id, starts_at, ends_at) values ($1,'2026-11-25 10:00Z','2026-11-25 11:00Z')`, [l1]), /OVERLAP/);
  await db.query(`insert into bookings (lift_id, starts_at, ends_at) values ($1,'2026-11-25 10:00Z','2026-11-25 11:00Z')`, [l2]);
});

test('afbókuð bókun skarast ekki; laugardagur ekki með hádegi', async () => {
  const l3 = await lift('Lyfta 3');
  await db.query(`insert into bookings (lift_id, starts_at, ends_at, status) values ($1,'2026-11-25 08:00Z','2026-11-25 10:00Z','cancelled')`, [l3]);
  await db.query(`insert into bookings (lift_id, starts_at, ends_at) values ($1,'2026-11-25 08:00Z','2026-11-25 10:00Z')`, [l3]);
  await db.query(`insert into bookings (lift_id, starts_at, ends_at) values ($1,'2026-11-28 11:00Z','2026-11-28 13:00Z')`, [l3]);
});

test('fjöldaga bókun yfir hádegi stöðvast; outlook-bókun fer í gegn', async () => {
  const l4 = await lift('Lyfta 4');
  await assert.rejects(db.query(`insert into bookings (lift_id, starts_at, ends_at) values ($1,'2026-11-26 13:00Z','2026-11-27 10:00Z')`, [l4]).then(() => db.query(`insert into bookings (lift_id, starts_at, ends_at) values ($1,'2026-11-26 08:00Z','2026-11-27 16:00Z')`, [l4])), /BLOCKED|OVERLAP/);
  await db.query(`insert into bookings (lift_id, starts_at, ends_at, source) values ($1,'2026-11-30 12:00Z','2026-11-30 13:00Z','outlook')`, [l4]);
});

test('stakur lokaður tími á einni lyftu', async () => {
  const l5 = await lift('Lyfta 5'), l1 = await lift('Lyfta 1');
  await db.query(`insert into blocked_times (kind,label,lift_id,starts_at,ends_at) values ('once','Viðgerð',$1,'2026-12-01 00:00Z','2026-12-02 00:00Z')`, [l5]);
  await assert.rejects(db.query(`insert into bookings (lift_id, starts_at, ends_at) values ($1,'2026-12-01 09:00Z','2026-12-01 10:00Z')`, [l5]), /BLOCKED:Viðgerð/);
  await db.query(`insert into bookings (lift_id, starts_at, ends_at) values ($1,'2026-12-01 09:00Z','2026-12-01 10:00Z')`, [l1]);
});

test('outlook_dirty: breyting í kerfi merkir, breyting úr Outlook (nýr change_key) ekki', async () => {
  const l2 = await lift('Lyfta 2');
  const { id } = await one(`insert into bookings (lift_id, starts_at, ends_at) values ($1,'2026-12-03 09:00Z','2026-12-03 10:00Z') returning id`, [l2]);
  await db.query(`update bookings set outlook_dirty=false, outlook_change_key='k1' where id=$1`, [id]);
  await db.query(`update bookings set notes='x' where id=$1`, [id]);
  assert.equal((await one(`select outlook_dirty from bookings where id=$1`, [id])).outlook_dirty, true);
  await db.query(`update bookings set outlook_dirty=false where id=$1`, [id]);
  await db.query(`update bookings set starts_at='2026-12-03 08:00Z', outlook_change_key='k2', outlook_dirty=false where id=$1`, [id]);
  assert.equal((await one(`select outlook_dirty from bookings where id=$1`, [id])).outlook_dirty, false);
});
