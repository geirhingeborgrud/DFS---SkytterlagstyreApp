'use strict';
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { tx, logActivity, ensureSubfolder } = require('../db');
const { requireLogin, requireRole } = require('../auth');
const { hasLevel } = require('../permissions');
const { int, today, fullName, ageOn, fmtDate, fmtLocal, caseNo, BOARD_ROLES, BOARD_CORE } = require('../helpers');
const { toRtf } = require('../rtf');
const { boardMembers } = require('./board');

const router = express.Router();
router.use(requireLogin);

/** Nøkkeltall for et år, brukt både i oversikten og i utkastene. */
function yearStats(db, year) {
  const y = String(year);
  const end = `${year}-12-31`;
  const members = db.prepare('SELECT * FROM members WHERE active = 1').all();
  const ages = { under17: 0, '17-20': 0, '21-54': 0, '55+': 0, ukjent: 0 };
  const classes = {};
  for (const m of members) {
    const a = ageOn(m.birth_date, end);
    if (a == null) ages.ukjent++;
    else if (a < 17) ages.under17++;
    else if (a <= 20) ages['17-20']++;
    else if (a <= 54) ages['21-54']++;
    else ages['55+']++;
    const c = m.class || 'Ikke oppgitt';
    classes[c] = (classes[c] || 0) + 1;
  }
  const boardMeetings = db.prepare("SELECT * FROM meetings WHERE type = 'styremote' AND substr(starts_at,1,4) = ? AND status = 'gjennomfort' ORDER BY starts_at").all(y);
  const plannedMeetings = db.prepare("SELECT COUNT(*) AS n FROM meetings WHERE type = 'styremote' AND substr(starts_at,1,4) = ? AND status != 'avlyst'").get(y).n;
  const annualMeetings = db.prepare("SELECT * FROM meetings WHERE type = 'arsmote' AND substr(starts_at,1,4) = ? ORDER BY starts_at").all(y);
  const items = db.prepare(`SELECT i.* FROM meeting_items i JOIN meetings m ON m.id = i.meeting_id
                            WHERE m.type = 'styremote' AND i.year = ? ORDER BY i.number`).all(year);
  const trainings = db.prepare('SELECT discipline, COUNT(*) AS n FROM trainings WHERE substr(date,1,4) = ? GROUP BY discipline ORDER BY n DESC').all(y);
  const competitions = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM competition_participants p WHERE p.competition_id = c.id) AS participants
                                   FROM competitions c WHERE substr(c.date,1,4) = ? ORDER BY c.date`).all(y);
  const ammo = db.prepare(`SELECT a.name, a.unit,
                             SUM(CASE WHEN t.kind = 'kjop' THEN t.quantity ELSE 0 END) AS bought,
                             SUM(CASE WHEN t.kind = 'salg' THEN t.quantity ELSE 0 END) AS sold
                           FROM ammo_transactions t JOIN ammo_types a ON a.id = t.ammo_type_id
                           WHERE substr(t.date,1,4) = ? GROUP BY a.id ORDER BY a.name`).all(y);
  const weapons = db.prepare("SELECT kind, COUNT(*) AS n FROM weapons WHERE status != 'avhendet' GROUP BY kind").all();
  return {
    memberCount: members.length, ages, classes, boardMeetings, plannedMeetings, annualMeetings, items,
    trainings, trainingCount: trainings.reduce((s, t) => s + t.n, 0), competitions, ammo,
    rifles: (weapons.find((w) => w.kind === 'rifle') || {}).n || 0,
    parts: (weapons.find((w) => w.kind === 'del') || {}).n || 0,
  };
}

function folders(db, year) {
  return {
    melding: ensureSubfolder(db, 'arsmeldinger', String(year)),
    rapport: ensureSubfolder(db, 'arsrapport', String(year)),
  };
}

router.get('/', (req, res) => {
  const { db } = req.app.locals.ctx;
  const current = Number(today().slice(0, 4));
  // Årsmeldingen skrives normalt tidlig i året for fjoråret
  const year = int(req.query.ar) || (Number(today().slice(5, 7)) <= 3 ? current - 1 : current);
  const f = res.locals.canWrite ? folders(db, year) : {
    melding: (db.prepare("SELECT f.id FROM folders f JOIN folders p ON p.id = f.parent_id WHERE p.key = 'arsmeldinger' AND f.name = ?").get(String(year)) || {}).id,
    rapport: (db.prepare("SELECT f.id FROM folders f JOIN folders p ON p.id = f.parent_id WHERE p.key = 'arsrapport' AND f.name = ?").get(String(year)) || {}).id,
  };
  const docsIn = (folderId) => (folderId ? db.prepare('SELECT * FROM documents WHERE folder_id = ? ORDER BY updated_at DESC').all(folderId).filter((d) => hasLevel(db, req.user, d, 'read')) : []);
  const years = [];
  for (let y = current + 1; y >= current - 5; y--) years.push(y);
  res.render('yearly', { title: `Årsmelding og årsrapport ${year}`, year, years, stats: yearStats(db, year), folderIds: f, meldingDocs: docsIn(f.melding), rapportDocs: docsIn(f.rapport) });
});

function meldingBlocks(db, year, clubName) {
  const s = yearStats(db, year);
  const board = boardMembers(db);
  const b = [];
  b.push({ h1: `Årsmelding ${year}` }, { p: clubName }, { note: `Utkast generert ${fmtDate(today())} fra styreappen. Tekst i [hakeparentes] fylles ut av styret.` });

  b.push({ h2: '1. Styrets sammensetning' });
  if (board.length) for (const m of board) b.push({ li: `${m.roles.filter((r) => BOARD_CORE.includes(r)).map((r) => BOARD_ROLES[r]).join(', ') || m.roles.map((r) => BOARD_ROLES[r]).join(', ')}: ${fullName(m)}` });
  else b.push({ p: '[Fyll inn styrets medlemmer og verv]' });
  const others = db.prepare(`SELECT m.*, GROUP_CONCAT(r.role) AS roles FROM members m JOIN member_roles r ON r.member_id = m.id
                             WHERE r.role IN ('revisor','valgkomite') GROUP BY m.id`).all();
  if (others.length) {
    b.push({ p: 'Andre tillitsvalgte:' });
    for (const m of others) b.push({ li: `${m.roles.split(',').map((r) => BOARD_ROLES[r]).join(', ')}: ${fullName(m)}` });
  }

  b.push({ h2: '2. Medlemmer' });
  b.push({ p: `Laget hadde ${s.memberCount} aktive medlemmer ved utgangen av ${year}.` });
  b.push({ li: `Under 17 år: ${s.ages.under17}` }, { li: `17–20 år: ${s.ages['17-20']}` }, { li: `21–54 år: ${s.ages['21-54']}` }, { li: `55 år og eldre: ${s.ages['55+']}` });
  if (s.ages.ukjent) b.push({ li: `Uten registrert fødselsdato: ${s.ages.ukjent}` });

  b.push({ h2: '3. Styrets arbeid' });
  b.push({ p: `Styret har i ${year} avholdt ${s.boardMeetings.length} styremøter${s.plannedMeetings > s.boardMeetings.length ? ` (${s.plannedMeetings} planlagt totalt)` : ''} og behandlet ${s.items.length} saker.` });
  if (s.items.length) {
    b.push({ p: 'Viktige saker:' });
    for (const it of s.items) b.push({ li: `Sak ${caseNo(it)} ${it.title}${it.decision ? ` – ${it.decision.split('\n')[0]}` : ''}` });
  }
  b.push({ p: '[Kommenter de viktigste sakene styret har arbeidet med]' });

  b.push({ h2: '4. Årsmøte' });
  if (s.annualMeetings.length) for (const m of s.annualMeetings) b.push({ p: `Årsmøtet ble avholdt ${fmtLocal(m.starts_at)}${m.location ? `, ${m.location}` : ''}.` });
  else b.push({ p: '[Dato og sted for årsmøtet]' });

  b.push({ h2: '5. Trening og aktivitet' });
  b.push({ p: `Det er gjennomført ${s.trainingCount} treninger i ${year}.` });
  for (const t of s.trainings) b.push({ li: `${t.discipline || 'Uten kategori'}: ${t.n}` });
  b.push({ p: '[Beskriv sesongen, ungdomsarbeid, kurs og dugnader]' });

  b.push({ h2: '6. Stevner' });
  if (s.competitions.length) {
    for (const c of s.competitions) b.push({ li: `${fmtDate(c.date)} ${c.name}${c.location ? `, ${c.location}` : ''}${c.own_event ? ' (eget arrangement)' : ''} – ${c.participants} deltakere fra laget` });
  } else b.push({ p: '[Stevner laget har arrangert og deltatt på]' });
  b.push({ p: '[Gode resultater, premier og ferdighetsmerker]' });

  b.push({ h2: '7. Skytebane, våpen og ammunisjon' });
  b.push({ p: `Laget har ${s.rifles} rifler og ${s.parts} våpendeler registrert i våpenregisteret.` });
  for (const a of s.ammo) b.push({ li: `${a.name}: kjøpt ${a.bought || 0} ${a.unit}, solgt ${a.sold || 0} ${a.unit}` });
  b.push({ p: '[Status for skytebanen, vedlikehold og sikkerhet]' });

  b.push({ h2: '8. Økonomi' });
  b.push({ p: '[Kort omtale av regnskap og økonomi. Regnskap og revisors beretning legges fram som egne saker.]' });

  b.push({ h2: '9. Avslutning' });
  b.push({ p: '[Takk til medlemmer, dugnadsfolk og samarbeidspartnere]' });
  b.push({ p: `Sted/dato: ____________________` });
  b.push({ sign: board.length ? board.map((m) => `${fullName(m)} (${BOARD_ROLES[m.roles[0]]})`) : ['Styreleder', 'Nestleder', 'Kasserer', 'Sekretær'] });
  return b;
}

function rapportBlocks(db, year, clubName) {
  const s = yearStats(db, year);
  const b = [];
  b.push({ h1: `Årsrapport ${year}` }, { p: clubName }, { note: `Nøkkeltall generert ${fmtDate(today())} fra styreappen. Kontroller mot MittDFS og kretsens/DFS' rapporteringskrav før innsending.` });
  b.push({ h2: 'Medlemstall' }, { p: `Aktive medlemmer: ${s.memberCount}` });
  b.push({ li: `Under 17 år: ${s.ages.under17}` }, { li: `17–20 år: ${s.ages['17-20']}` }, { li: `21–54 år: ${s.ages['21-54']}` }, { li: `55 år og eldre: ${s.ages['55+']}` });
  b.push({ h2: 'Medlemmer per klasse' });
  for (const [c, n] of Object.entries(s.classes).sort()) b.push({ li: `${c}: ${n}` });
  b.push({ h2: 'Tillitsvalgte' });
  for (const m of boardMembers(db)) b.push({ li: `${m.roles.map((r) => BOARD_ROLES[r]).join(', ')}: ${fullName(m)}${m.email ? ` – ${m.email}` : ''}${m.phone ? ` – ${m.phone}` : ''}` });
  b.push({ h2: 'Aktivitet' });
  b.push({ li: `Styremøter: ${s.boardMeetings.length}` }, { li: `Behandlede styresaker: ${s.items.length}` }, { li: `Treninger: ${s.trainingCount}` }, { li: `Stevner (deltatt/arrangert): ${s.competitions.length}` });
  b.push({ h2: 'Våpen og ammunisjon' });
  b.push({ li: `Rifler: ${s.rifles}` }, { li: `Våpendeler: ${s.parts}` });
  for (const a of s.ammo) b.push({ li: `${a.name}: kjøpt ${a.bought || 0}, solgt ${a.sold || 0} ${a.unit}` });
  b.push({ h2: 'Kommentarer' }, { p: '[Fylles ut]' });
  return b;
}

/** Lagrer RTF som nytt dokument, eller ny versjon av eksisterende utkast med samme tittel. */
function saveDraft(db, uploadDir, user, folderId, title, rtf) {
  const stored = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(uploadDir, stored), rtf);
  const fileName = `${title}.rtf`;
  return tx(db, () => {
    let doc = db.prepare('SELECT * FROM documents WHERE folder_id = ? AND title = ?').get(folderId, title);
    if (!doc) {
      const r = db.prepare("INSERT INTO documents (title, description, folder_id, owner_id, default_access) VALUES (?, ?, ?, ?, 'edit')")
        .run(title, 'Utkast til hoveddokument. Last ned, rediger i Word og last opp ny versjon.', folderId, user.id);
      doc = { id: Number(r.lastInsertRowid) };
    }
    const v = db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM document_versions WHERE document_id = ?').get(doc.id).v;
    const r = db.prepare(`INSERT INTO document_versions (document_id, version, stored_name, original_name, mime, size, note, uploaded_by)
                          VALUES (?, ?, ?, ?, 'application/rtf', ?, 'Generert fra styreappen', ?)`)
      .run(doc.id, v, stored, fileName, Buffer.byteLength(rtf), user.id);
    db.prepare("UPDATE documents SET current_version_id = ?, updated_at = datetime('now') WHERE id = ?").run(r.lastInsertRowid, doc.id);
    return doc.id;
  });
}

router.post('/:year/utkast', requireRole('styre'), (req, res) => {
  const { db, uploadDir } = req.app.locals.ctx;
  const year = int(req.params.year);
  if (!year || year < 2000 || year > 2100) return res.redirect('/arsdokumenter');
  const f = folders(db, year);
  const isRapport = req.body.type === 'rapport';
  const title = isRapport ? `Årsrapport ${year} – utkast` : `Årsmelding ${year} – utkast`;
  const blocks = isRapport ? rapportBlocks(db, year, res.locals.clubName) : meldingBlocks(db, year, res.locals.clubName);
  const id = saveDraft(db, uploadDir, req.user, isRapport ? f.rapport : f.melding, title, toRtf(blocks));
  logActivity(db, req.user.id, isRapport ? 'arsrapport-utkast' : 'arsmelding-utkast', String(year));
  req.flash('ok', `${title} er laget (RTF – åpnes i Word). Last ned, rediger og last opp ny versjon på dokumentet.`);
  res.redirect(`/dokumenter/${id}`);
});

module.exports = router;
module.exports.yearStats = yearStats;
