'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startApp, Client } = require('./helpers');
const { membersFromCsv } = require('../src/csv');
const { googleCalendarUrl, meetingIcs } = require('../src/calendar');
const { toRtf } = require('../src/rtf');

let app;
const admin = () => new Client(app.base);
let A; // innlogget administrator
let ids = {};

before(async () => {
  app = await startApp();
  A = admin();
  await A.get('/oppsett');
  const r = await A.submit('/oppsett', { club: 'Østre Bærum Skytterlag', name: 'Ada Admin', email: 'ada@example.com', password: 'hemmelig-passord', password2: 'hemmelig-passord' });
  assert.equal(r.status, 200);
  assert.match(r.text, /Østre Bærum Skytterlag/);
});
after(() => app.close());

function inviteToken(email) {
  return app.db.prepare('SELECT invite_token FROM users WHERE email = ?').get(email).invite_token;
}

async function loginAs(email, password = 'passord-som-er-langt') {
  const c = new Client(app.base);
  await c.get('/logg-inn');
  const r = await c.post('/logg-inn', { email, password });
  assert.equal(r.status, 302, `innlogging feilet for ${email}`);
  return c;
}

async function invite(memberId, role) {
  await A.get('/styret');
  await A.submit('/styret/brukere', { member_id: memberId, role });
  const email = app.db.prepare('SELECT email FROM members WHERE id = ?').get(memberId).email;
  const c = new Client(app.base);
  const tok = inviteToken(email);
  assert.ok(tok, 'invitasjon mangler');
  await c.get(`/invitasjon/${tok}`);
  const r = await c.post(`/invitasjon/${tok}`, { password: 'passord-som-er-langt', password2: 'passord-som-er-langt' });
  assert.equal(r.status, 302);
  return c;
}

test('uinnlogget blir sendt til innlogging, og innloggingssiden viser lagets navn', async () => {
  const c = new Client(app.base);
  const r = await c.get('/dokumenter');
  assert.equal(r.status, 302);
  assert.equal(r.location, '/logg-inn');
  const login = await c.get('/logg-inn');
  assert.match(login.text, /Østre Bærum Skytterlag/);
  const bad = await c.post('/logg-inn', { email: 'ada@example.com', password: 'feil' });
  assert.equal(bad.status, 401);
});

test('POST uten CSRF-token avvises', async () => {
  const r = await fetch(`${app.base}/oppgaver`, { method: 'POST', headers: { cookie: A.cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'title=x' });
  assert.equal(r.status, 403);
});

test('CSV-import fra MittDFS (semikolon, Windows-1252)', async () => {
  const csv = 'Skytter-ID;Fornavn;Etternavn;Fødselsdato;E-post;Mobil;Klasse\r\n'
    + '1001;Kari;Nordmann;05.03.1980;kari@example.com;90000001;5\r\n'
    + '1002;Ola;Hansen;12.11.2009;ola@example.com;90000002;ER\r\n'
    + '1003;Bjørn;Ås;01.01.1960;bjorn@example.com;;V65\r\n'
    + '1004;Siri;Lie;;siri@example.com;;3\r\n';
  const buf = Buffer.from(new TextEncoder().encode(csv));
  // Windows-1252-variant: æøå som enkeltbytes
  const latin = Buffer.from(csv, 'latin1');
  assert.equal(membersFromCsv(latin).members[2].first_name, 'Bjørn');
  await A.get('/medlemmer/import');
  const r = await A.submit('/medlemmer/import', { file: { blob: new Blob([buf], { type: 'text/csv' }), name: 'medlemmer.csv' } }, { multipart: true });
  assert.match(r.text, /4 nye, 0 oppdatert/);
  // Importer igjen – skal oppdatere, ikke duplisere
  await A.get('/medlemmer/import');
  const r2 = await A.submit('/medlemmer/import', { file: { blob: new Blob([buf], { type: 'text/csv' }), name: 'medlemmer.csv' } }, { multipart: true });
  assert.match(r2.text, /0 nye, 4 oppdatert/);
  const kari = app.db.prepare("SELECT * FROM members WHERE shooter_id = '1001'").get();
  assert.equal(kari.birth_date, '1980-03-05');
  ids.kari = kari.id;
  ids.ola = app.db.prepare("SELECT id FROM members WHERE shooter_id = '1002'").get().id;
  ids.bjorn = app.db.prepare("SELECT id FROM members WHERE shooter_id = '1003'").get().id;
  ids.siri = app.db.prepare("SELECT id FROM members WHERE shooter_id = '1004'").get().id;
});

test('admin setter flere verv på ett medlem, styreoversikt viser dem', async () => {
  await A.get(`/medlemmer/${ids.kari}`);
  const m = app.db.prepare('SELECT * FROM members WHERE id = ?').get(ids.kari);
  await A.submit(`/medlemmer/${ids.kari}`, { ...m, active: '1', roles_submitted: '1', roles: ['kasserer', 'vapenansvarlig'] });
  await A.get(`/medlemmer/${ids.bjorn}`);
  const b = app.db.prepare('SELECT * FROM members WHERE id = ?').get(ids.bjorn);
  await A.submit(`/medlemmer/${ids.bjorn}`, { ...b, active: '1', roles_submitted: '1', roles: ['styreleder'] });
  const roles = app.db.prepare('SELECT role FROM member_roles WHERE member_id = ? ORDER BY role').all(ids.kari).map((r) => r.role);
  assert.deepEqual(roles, ['kasserer', 'vapenansvarlig']);
  const page = await A.get('/styret');
  assert.match(page.text, /Kasserer/);
  assert.match(page.text, /Våpenansvarlig/);
  assert.match(page.text, /Styreleder/);
});

test('invitasjon, innlogging og «pålogget nå» på forsiden', async () => {
  const kari = await invite(ids.kari, 'styre');
  ids.kariClient = kari;
  const home = await kari.get('/');
  assert.equal(home.status, 200);
  assert.match(home.text, /Pålogget nå/);
  assert.match(home.text, /Kari Nordmann/);
  assert.match(home.text, /Ada Admin/);
});

test('dokumenttilganger: les / rediger / eier og «kun lesetilgang»', async () => {
  const revisor = await invite(ids.siri, 'les');
  const kari = ids.kariClient;
  await A.get('/dokumenter/ny');
  const folder = app.db.prepare("SELECT id FROM folders WHERE key = 'storre-saker'").get().id;
  const up = await A.post('/dokumenter/ny', { title: 'Budsjett 2027', folder_id: folder, default_access: 'read', file: { blob: new Blob(['hei']), name: 'budsjett æøå.txt' } }, { multipart: true });
  assert.equal(up.status, 302);
  const docId = Number(up.location.split('/').pop());
  ids.doc = docId;
  assert.equal(app.db.prepare('SELECT original_name FROM document_versions WHERE document_id = ?').get(docId).original_name, 'budsjett æøå.txt');

  // Styremedlem kan lese (standard), men ikke laste opp ny versjon
  assert.equal((await kari.get(`/dokumenter/${docId}`)).status, 200);
  const dl = await kari.get(`/dokumenter/${docId}/last-ned`);
  assert.equal(dl.text, 'hei');
  const denied = await kari.post(`/dokumenter/${docId}/ny-versjon`, { file: { blob: new Blob(['x']), name: 'x.txt' } }, { multipart: true });
  assert.equal(denied.status, 403);

  // Revisor (kun lesetilgang) ser ikke dokumentet uten eksplisitt tilgang
  assert.equal((await revisor.get(`/dokumenter/${docId}`)).status, 404);

  // Eier gir Kari redigering og revisor lesing
  const kariUser = app.db.prepare('SELECT id FROM users WHERE member_id = ?').get(ids.kari).id;
  const revUser = app.db.prepare('SELECT id FROM users WHERE member_id = ?').get(ids.siri).id;
  await A.get(`/dokumenter/${docId}`);
  await A.post(`/dokumenter/${docId}/tilgang`, { default_access: 'read', [`perm_${kariUser}`]: 'edit', [`perm_${revUser}`]: 'read' });
  await kari.get(`/dokumenter/${docId}`);
  const ok = await kari.post(`/dokumenter/${docId}/ny-versjon`, { note: 'oppdatert', file: { blob: new Blob(['v2']), name: 'budsjett.txt' } }, { multipart: true });
  assert.equal(ok.status, 302);
  assert.equal((await revisor.get(`/dokumenter/${docId}`)).status, 200);
  // Rediger-nivå kan ikke slette
  assert.equal((await kari.post(`/dokumenter/${docId}/slett`, {})).status, 403);
  // Revisor kan ikke opprette dokumenter
  assert.equal((await revisor.get('/dokumenter/ny')).status, 403);
});

test('styremøte: egen mappe, styret invitert, Google Meet, kalender og innkalling', async () => {
  await A.get('/moter/ny');
  const r = await A.post('/moter/ny', { title: 'Styremøte', starts_at: '2026-12-03T18:00', location: 'Klubbhuset', meet_url: 'https://meet.google.com/abc-defg-hij' });
  assert.equal(r.status, 302);
  const id = Number(r.location.split('/').pop());
  ids.meeting = id;
  const m = app.db.prepare('SELECT * FROM meetings WHERE id = ?').get(id);
  const folder = app.db.prepare('SELECT f.name, p.key FROM folders f JOIN folders p ON p.id = f.parent_id WHERE f.id = ?').get(m.folder_id);
  assert.equal(folder.key, 'styremoter');
  assert.equal(folder.name, '2026-12-03 Styremøte');
  const attendees = app.db.prepare('SELECT member_id FROM meeting_attendees WHERE meeting_id = ?').all(id).map((a) => a.member_id).sort();
  assert.deepEqual(attendees, [ids.kari, ids.bjorn].sort());

  await A.get(`/moter/${id}`);
  await A.post(`/moter/${id}/saker`, { title: 'Godkjenning av budsjett' });
  await A.post(`/moter/${id}/saker`, { title: 'Banedugnad' });
  await A.post(`/moter/${id}/deltakere`, { member_ids: [ids.ola] });
  const page = await A.get(`/moter/${id}`);
  assert.match(page.text, /Sak 1\/26 Godkjenning av budsjett/);
  assert.match(page.text, /Sak 2\/26 Banedugnad/);
  assert.match(page.text, /calendar\.google\.com/);
  assert.match(page.text, /ola%40example\.com/);

  const ics = await A.get(`/moter/${id}/kalender.ics`);
  assert.match(ics.text, /ATTENDEE;CN=Ola Hansen/);
  assert.match(ics.text, /meet\.google\.com\/abc-defg-hij/);

  const compose = await A.get(`/epost/ny?mote=${id}`);
  assert.match(compose.text, /Innkalling til styremøte 03\.12\.2026/);
  assert.match(compose.text, /Google Meet: https:\/\/meet\.google\.com\/abc-defg-hij/);

  const cal = await A.get('/kalender?ar=2026&mnd=12');
  assert.match(cal.text, /18:00 Styremøte/);
});

test('e-post til styret med valgte dokumenter som vedlegg', async () => {
  await A.get('/epost/ny');
  const before = app.sent.length;
  const r = await A.submit('/epost/ny', {
    recipients: [`m:${ids.kari}`, `m:${ids.bjorn}`], docs: [ids.doc], mode: 'vedlegg', subject: 'Budsjett', body: 'Se vedlagt.',
  });
  assert.match(r.text, /sendt til 2 mottaker/);
  const msg = app.sent[before];
  assert.equal(msg.to.length, 2);
  assert.equal(msg.attachments.length, 1);
  assert.equal(msg.attachments[0].filename, 'budsjett.txt');
});

test('årsmøte får mappe under Årsmøter', async () => {
  await A.get('/arsmoter/ny');
  const r = await A.post('/arsmoter/ny', { title: 'Årsmøte', starts_at: '2027-02-20T12:00' });
  const id = Number(r.location.split('/').pop());
  const m = app.db.prepare('SELECT * FROM meetings WHERE id = ?').get(id);
  assert.equal(m.type, 'arsmote');
  const f = app.db.prepare('SELECT f.name, p.key FROM folders f JOIN folders p ON p.id = f.parent_id WHERE f.id = ?').get(m.folder_id);
  assert.deepEqual({ ...f }, { name: 'Årsmøte 2027', key: 'arsmoter' });
  assert.equal((await A.get('/moter/' + id)).status, 404, 'årsmøte skal ikke vises som styremøte');
});

test('våpenregister: kun admin/våpenansvarlig endrer; ammo-salg til skytter; utlån sendes', async () => {
  // Bjørn er styreleder (ikke våpenansvarlig) → får ikke registrere våpen
  const bjorn = await invite(ids.bjorn, 'styre');
  assert.equal((await bjorn.get('/vapen')).status, 200);
  assert.equal((await bjorn.get('/vapen/ny')).status, 403);

  // Kari er våpenansvarlig
  const kari = await loginAs('kari@example.com');
  await kari.get('/vapen/ny?type=rifle');
  const r = await kari.post('/vapen/ny', { kind: 'rifle', manufacturer: 'Sauer', model: '200 STR', caliber: '6,5×55', serial_number: 'S12345', card_number: 'VK-1', card: { blob: new Blob(['%PDF']), name: 'vapenkort.pdf' } }, { multipart: true });
  assert.equal(r.status, 302);
  const wid = Number(r.location.split('/').pop());
  const w = app.db.prepare('SELECT * FROM weapons WHERE id = ?').get(wid);
  assert.ok(w.card_document_id);
  assert.equal(app.db.prepare('SELECT f.key FROM documents d JOIN folders f ON f.id = d.folder_id WHERE d.id = ?').get(w.card_document_id).key, 'vapenkort');

  await kari.get('/vapen/ny?type=del');
  await kari.post('/vapen/ny', { kind: 'del', part_type: 'Pipe', manufacturer: 'Lothar Walther', caliber: '6,5×55', serial_number: 'P-9' }, { multipart: true });

  // Ammo: kjøp 1000, selg 200 til Ola
  await kari.get('/vapen/ammo');
  const type = app.db.prepare('SELECT id FROM ammo_types ORDER BY id LIMIT 1').get().id;
  await kari.post('/vapen/ammo', { kind: 'kjop', ammo_type_id: type, quantity: 1000, unit_price: '4,50', counterparty: 'Leverandør' });
  await kari.post('/vapen/ammo', { kind: 'salg', ammo_type_id: type, quantity: 200, unit_price: '6', member_id: ids.ola });
  const tooMany = await kari.submit('/vapen/ammo', { kind: 'salg', ammo_type_id: type, quantity: 5000, member_id: ids.ola });
  assert.match(tooMany.text, /bare 800/);
  const ammo = await kari.get('/vapen/ammo');
  assert.match(ammo.text, /800 skudd/);
  assert.match(ammo.text, /Ola Hansen/);

  // Utlån
  await kari.get('/vapen/utlan/ny');
  const lr = await kari.post('/vapen/utlan/ny', { weapon_id: wid, member_id: ids.ola, from_date: '2026-11-18', purpose: 'Sesongen 2027' });
  const loanId = Number(lr.location.split('/').pop());
  const loan = app.db.prepare('SELECT * FROM loans WHERE id = ?').get(loanId);
  assert.match(loan.text, /Ola Hansen/);
  assert.match(loan.text, /S12345/);
  assert.match(loan.text, /Østre Bærum Skytterlag/);
  assert.equal(app.db.prepare('SELECT status FROM weapons WHERE id = ?').get(wid).status, 'utlant');
  await kari.get(`/vapen/utlan/${loanId}`);
  const before = app.sent.length;
  await kari.post(`/vapen/utlan/${loanId}/send`, { to: 'ola@example.com' });
  assert.equal(app.sent[before].to.address, 'ola@example.com');
  assert.equal(app.sent[before].attachments.length, 1);
  assert.ok(app.db.prepare("SELECT 1 FROM documents d JOIN folders f ON f.id = d.folder_id WHERE f.key = 'utlan'").get());
  await kari.post(`/vapen/utlan/${loanId}/retur`, {});
  assert.equal(app.db.prepare('SELECT status FROM weapons WHERE id = ?').get(wid).status, 'aktiv');
});

test('treninger (ukentlig serie) og stevner vises i kalenderen', async () => {
  await A.get('/treninger');
  await A.post('/treninger', { title: 'Banetrening', date: '2026-12-01', start_time: '18:00', repeat: 4, discipline: 'Bane 100/200/300 m' });
  assert.equal(app.db.prepare("SELECT COUNT(*) AS n FROM trainings WHERE title = 'Banetrening'").get().n, 4);
  await A.get('/stevner');
  const r = await A.post('/stevner', { name: 'Julestevne', date: '2026-12-12', signup_deadline: '2026-12-05', own_event: '1' });
  const cid = Number(r.location.split('/').pop());
  await A.get(`/stevner/${cid}`);
  await A.post(`/stevner/${cid}/deltakere`, { member_ids: [ids.ola, ids.kari] });
  const cal = await A.get('/kalender?ar=2026&mnd=12');
  assert.match(cal.text, /Banetrening/);
  assert.match(cal.text, /Julestevne/);
  assert.match(cal.text, /Påmeldingsfrist: Julestevne/);
});

test('årsmelding og årsrapport: mappe per år og utkast som RTF', async () => {
  const page = await A.get('/arsdokumenter?ar=2026');
  assert.equal(page.status, 200);
  const r = await A.submit('/arsdokumenter/2026/utkast', { type: 'melding' });
  assert.match(r.text, /Årsmelding 2026 – utkast/);
  const doc = app.db.prepare("SELECT d.*, f.name AS folder, p.key FROM documents d JOIN folders f ON f.id = d.folder_id JOIN folders p ON p.id = f.parent_id WHERE d.title = 'Årsmelding 2026 – utkast'").get();
  assert.equal(doc.folder, '2026');
  assert.equal(doc.key, 'arsmeldinger');
  const dl = await A.get(`/dokumenter/${doc.id}/last-ned`);
  assert.match(dl.text, /^\{\\rtf1/);
  assert.match(dl.text, /Styrets sammensetning/);
  // Nytt utkast gir ny versjon, ikke nytt dokument
  await A.get('/arsdokumenter?ar=2026');
  await A.post('/arsdokumenter/2026/utkast', { type: 'melding' });
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM document_versions WHERE document_id = ?').get(doc.id).n, 2);
  await A.post('/arsdokumenter/2026/utkast', { type: 'rapport' });
  assert.ok(app.db.prepare("SELECT 1 FROM documents WHERE title = 'Årsrapport 2026 – utkast'").get());
});

test('stillingsinstrukser: sjekkliste som innehaver av vervet kan krysse av', async () => {
  await A.get('/stillinger/kasserer');
  await A.post('/stillinger/kasserer/sjekklister', { title: 'Årsavslutning', items: '- Avstemme bank\n- Sende regnskap til revisor' });
  const item = app.db.prepare("SELECT i.id FROM checklist_items i JOIN checklists c ON c.id = i.checklist_id WHERE c.role = 'kasserer' ORDER BY i.id LIMIT 1").get();
  const kari = await loginAs('kari@example.com');
  await kari.get('/stillinger/kasserer');
  await kari.post(`/stillinger/kasserer/punkt/${item.id}/kryss`, {});
  assert.ok(app.db.prepare('SELECT done_at FROM checklist_items WHERE id = ?').get(item.id).done_at);
  const list = await kari.get('/stillinger');
  assert.match(list.text, /1\/2 punkter utført/);
  // Revisor (kun lesetilgang, uten vervet) kan ikke krysse av
  const siri = await loginAs('siri@example.com');
  await siri.get('/stillinger/kasserer');
  assert.equal((await siri.post(`/stillinger/kasserer/punkt/${item.id}/kryss`, {})).status, 403);
});

test('logo lastes opp og vises på innloggingssiden', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  await A.get('/admin');
  const r = await A.submit('/admin/logo', { logo: { blob: new Blob([png], { type: 'image/png' }), name: 'logo.png' } }, { multipart: true });
  assert.match(r.text, /Logoen er lagret/);
  const anon = new Client(app.base);
  const login = await anon.get('/logg-inn');
  assert.match(login.text, /<img class="logo" src="\/logo/);
  const img = await fetch(`${app.base}/logo`);
  assert.equal(img.headers.get('content-type'), 'image/png');
});

test('alle hovedsider svarer 200 for administrator', async () => {
  for (const url of [`/dokumenter/${ids.doc}`, '/', '/kalender', '/moter', '/arsmoter', `/moter/${ids.meeting}/protokoll`, '/dokumenter', `/dokumenter?mappe=1`, '/oppgaver', '/arshjul',
    '/arsdokumenter', '/stillinger', '/epost', '/styret', '/medlemmer', `/medlemmer/${ids.ola}`, '/medlemmer/eksport.csv', '/vapen', '/vapen/ammo',
    '/vapen/utlan', '/vapen/utlan/mal', '/treninger', '/stevner', '/admin', '/profil']) {
    const r = await A.get(url);
    assert.equal(r.status, 200, `${url} ga ${r.status}`);
  }
});

test('hjelpefunksjoner: Google Kalender-lenke, ICS og RTF', () => {
  const url = new URL(googleCalendarUrl({ title: 'Styremøte', startsAt: '2026-12-03T18:00', location: 'Klubbhuset', guests: ['a@x.no', 'b@x.no'] }));
  assert.equal(url.searchParams.get('dates'), '20261203T180000/20261203T200000');
  assert.equal(url.searchParams.get('add'), 'a@x.no,b@x.no');
  const ics = meetingIcs({ uid: 'x', title: 'Møte; test', startsAt: '2026-12-03T23:30', attendees: [] });
  assert.match(ics, /DTEND;TZID=Europe\/Oslo:20261204T013000/);
  assert.match(ics, /SUMMARY:Møte\\; test/);
  assert.match(toRtf([{ p: 'Ærlig {test}' }]), /\\u198\?rlig \\\{test\\\}/);
});
