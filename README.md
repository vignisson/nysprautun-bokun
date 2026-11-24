# Nýsprautun – tímabókanir

Tímabókunarkerfi fyrir bifreiðaverkstæði Nýsprautunar (5 lyftur). Sami grunnur og John Tailor CRM:
Cloudflare Worker + Supabase (Postgres, Auth, Realtime) + Twilio (SMS) + Resend (tölvupóstur) + Microsoft Graph (Outlook).

## Virkni
- **Ein lyfta:** 1 dagur, 3 dagar, 5 dagar (mán–fös), vika, 2 vikur, mánuður
- **Allar lyftur hlið við hlið:** einn dagur
- Draga bókanir milli tíma, daga og lyfta; teygja til að breyta lengd; draga á tómu svæði til að búa til bókun
- **Lokaðir tímar** (vikulegir, t.d. hádegi, eða stök tímabil; allar lyftur eða ein) — gagnagrunnurinn hafnar bókunum á þá
- **Gulir miðar** eins og í John Tailor, með áminningu í tölvupósti
- **Netbókun** á `/boka`: viðskiptavinir senda beiðni sem starfsfólk breytir í bókun
- **SMS-áminning** daginn fyrir, **SMS þegar bíll er tilbúinn**, **staðfesting í tölvupósti**
- **Tvíátta Outlook-samstilling** (eitt dagatal = ein lyfta), á 5 mín fresti
- Leit eftir bílnúmeri, nafni eða síma; fyrri komur bíls birtast í bókun

## Uppsetning
1. Keyra `supabase/migrations/0001_init.sql` í nýju Supabase-verkefni.
2. Fylla inn `SUPABASE_URL` og `SUPABASE_ANON_KEY` í `wrangler.toml`.
3. Leyndarmál: `wrangler secret put SUPABASE_SERVICE_KEY` (og Twilio/Resend/MS eftir þörfum).
4. `npm i && npm run deploy`
5. Fyrsti notandinn sem er stofnaður í Supabase Auth verður stjórnandi; aðrum er boðið úr Stillingum → Starfsfólk.
6. Í Supabase Auth: slökkva á „Allow new users to sign up“ og setja Site URL á slóð kerfisins.

## Outlook (Azure)
App registration → API permissions → Microsoft Graph → **Application** → `Calendars.ReadWrite` → Grant admin consent.
Búa til client secret og setja `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` sem leyndarmál í worker.
Í Stillingum → Lyftur & Outlook: setja pósthólf hverrar lyftu og velja dagatal.

## Próf
`npm test` — prófar skemað (lokaðir tímar, skörun, Outlook-merkingar) í PGlite og hjálparföll.
