'use strict';
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const { tx, logActivity, getSetting, setSetting, folderIdByKey, DEFAULT_LOAN_TEMPLATE } = require('../db');
const { requireLogin, requireRole, requireBoardRole, hasBoardRole, verifyCsrf } = require('../auth');
const { hasLevel } = require('../permissions');
const { str, int, today, fullName, fmtDate, WEAPON_STATUS } = require('../helpers');

const router = express.Router();
// Våpenregisteret er tilgjengelig for styret. Endringer krever administrator eller våpenansvarlig.
router.use(requireLogin, requireRole('styre'));
const canEditWeapons = requireBoardRole('vapenansvarlig');
// Ammunisjon: våpenansvarlig og kasserer
const canEditAmmo = requireBoardRole('vapenansvarlig', 'kasserer');

const KINDS = { rifle: 'Rifle', del: 'Våpendel' };
const PART_TYPES = ['Pipe', 'Sluttstykke', 'Låskasse', 'Mekanisme', 'Magasin', 'Annet'];
const FIELDS = ['part_type', 'manufacturer', 'model', 'caliber', 'serial_number', 'card_number', 'card_holder', 'storage', 'acquired_date', 'notes'];

const uploaders = new Map();
function cardUpload(req, res, next) {
  const dir = req.app.locals.ctx.uploadDir;
  if (!uploaders.has(dir)) {
    uploaders.set(dir, multer({
      storage: multer.diskStorage({ destination: dir, filename: (r, f, cb) => cb(null, crypto.randomBytes(16).toString('hex')) }),
      limits: { fileSize: 25 * 1024 * 1024, files: 1 },
      defParamCharset: 'utf8',
    }));
  }
  uploaders.get(dir).single('card')(req, res, (err) => {
    if (err) return next(err);
    let ok = false;
    verifyCsrf(req, res, () => { ok = true; });
    if (ok) return next();
    if (req.file) fs.rm(req.file.path, { force: true }, () => {});
  });
}

/** Lagrer opplastet våpenkort som dokument i mappen «Våpenkort» og returnerer dokument-id. */
function storeCard(db, user, file, weapon) {
  const title = `Våpenkort – ${[weapon.manufacturer, weapon.model].filter(Boolean).join(' ') || 'våpen'}${weapon.serial_number ? ` (${weapon.serial_number})` : ''}`;
  const d = db.prepare("INSERT INTO documents (title, folder_id, owner_id, default_access) VALUES (?, ?, ?, 'read')")
    .run(title, folderIdByKey(db, 'vapenkort'), user.id);
  const v = db.prepare(`INSERT INTO document_versions (document_id, version, stored_name, original_name, mime, size, uploaded_by)
                        VALUES (?, 1, ?, ?, ?, ?, ?)`).run(d.lastInsertRowid, file.filename, file.originalname, file.mimetype, file.size, user.id);
  db.prepare('UPDATE documents SET current_version_id = ? WHERE id = ?').run(v.lastInsertRowid, d.lastInsertRowid);
  return Number(d.lastInsertRowid);
}

function weaponLabel(w) {
  return [w.kind === 'del' ? w.part_type || 'Våpendel' : null, w.manufacturer, w.model, w.caliber ? `(${w.caliber})` : null].filter(Boolean).join(' ');
}

// ---- Våpenliste -------------------------------------------------------------

router.get('/', (req, res) => {
  const { db } = req.app.locals.ctx;
  const showAll = req.query.alle === '1';
  const where = showAll ? '' : "WHERE w.status != 'avhendet'";
  const all = db.prepare(`SELECT w.*, (SELECT m.first_name || ' ' || m.last_name FROM loans l JOIN members m ON m.id = l.member_id
                                        WHERE l.weapon_id = w.id AND l.status = 'aktiv' ORDER BY l.from_date DESC LIMIT 1) AS loaned_to
                          FROM weapons w ${where} ORDER BY w.kind, w.manufacturer, w.model`).all();
  const stock = ammoStock(db);
  const activeLoans = db.prepare("SELECT COUNT(*) AS n FROM loans WHERE status = 'aktiv'").get().n;
  res.render('weapons/list', {
    title: 'Våpenregister', rifles: all.filter((w) => w.kind === 'rifle'), parts: all.filter((w) => w.kind === 'del'),
    showAll, stock, activeLoans, canEdit: hasBoardRole(req.user, 'vapenansvarlig'), weaponLabel,
  });
});

router.get('/ny', canEditWeapons, (req, res) => {
  const kind = KINDS[req.query.type] ? req.query.type : 'rifle';
  res.render('weapons/form', { title: `Registrer ${KINDS[kind].toLowerCase()}`, weapon: { kind, status: 'aktiv' }, KINDS, PART_TYPES });
});

router.post('/ny', canEditWeapons, cardUpload, (req, res) => {
  const { db } = req.app.locals.ctx;
  const kind = KINDS[req.body.kind] ? req.body.kind : 'rifle';
  const w = { kind };
  for (const f of FIELDS) w[f] = str(req.body[f]);
  if (!w.serial_number && !w.model) {
    if (req.file) fs.rm(req.file.path, { force: true }, () => {});
    return res.status(400).render('weapons/form', { title: `Registrer ${KINDS[kind].toLowerCase()}`, weapon: w, KINDS, PART_TYPES, error: 'Oppgi minst modell eller serienummer.' });
  }
  const id = tx(db, () => {
    const r = db.prepare(`INSERT INTO weapons (kind, ${FIELDS.join(', ')}) VALUES (?, ${FIELDS.map(() => '?').join(', ')})`).run(kind, ...FIELDS.map((f) => w[f]));
    if (req.file) db.prepare('UPDATE weapons SET card_document_id = ? WHERE id = ?').run(storeCard(db, req.user, req.file, w), r.lastInsertRowid);
    return r.lastInsertRowid;
  });
  logActivity(db, req.user.id, 'vapen-registrert', `${weaponLabel(w)} ${w.serial_number || ''}`);
  req.flash('ok', `${KINDS[kind]} er registrert.`);
  res.redirect(`/vapen/${id}`);
});

// ---- Ammunisjon -------------------------------------------------------------

function ammoStock(db) {
  return db.prepare(`SELECT a.*,
      COALESCE((SELECT SUM(CASE t.kind WHEN 'kjop' THEN t.quantity WHEN 'salg' THEN -t.quantity ELSE t.quantity END)
                FROM ammo_transactions t WHERE t.ammo_type_id = a.id), 0) AS stock
    FROM ammo_types a WHERE a.active = 1 ORDER BY a.name`).all();
}

router.get('/ammo', (req, res) => {
  const { db } = req.app.locals.ctx;
  const year = int(req.query.ar) || Number(today().slice(0, 4));
  const stock = ammoStock(db);
  const tx_ = db.prepare(`SELECT t.*, a.name AS ammo_name, a.unit, m.first_name || ' ' || m.last_name AS member_name, m.shooter_id
                          FROM ammo_transactions t JOIN ammo_types a ON a.id = t.ammo_type_id
                          LEFT JOIN members m ON m.id = t.member_id
                          WHERE substr(t.date,1,4) = ? ORDER BY t.date DESC, t.id DESC`).all(String(year));
  const totals = { kjop: 0, salg: 0, ubetalt: 0 };
  for (const t of tx_) {
    const sum = (t.unit_price || 0) * t.quantity;
    if (t.kind === 'kjop') totals.kjop += sum;
    if (t.kind === 'salg') { totals.salg += sum; if (!t.paid) totals.ubetalt += sum; }
  }
  const members = db.prepare('SELECT id, first_name, last_name, shooter_id FROM members WHERE active = 1 ORDER BY last_name, first_name').all();
  res.render('weapons/ammo', { title: 'Ammunisjon', stock, transactions: tx_, totals, members, year, now: today(), canEdit: hasBoardRole(req.user, 'vapenansvarlig', 'kasserer') });
});

router.post('/ammo/typer', canEditAmmo, (req, res) => {
  const { db } = req.app.locals.ctx;
  const name = str(req.body.name);
  if (name) {
    db.prepare('INSERT INTO ammo_types (name, caliber, unit, price, min_stock) VALUES (?, ?, ?, ?, ?)')
      .run(name, str(req.body.caliber), str(req.body.unit) || 'skudd', parseFloat(String(req.body.price || '').replace(',', '.')) || null, int(req.body.min_stock));
  }
  res.redirect('/vapen/ammo');
});

router.post('/ammo/typer/:id', canEditAmmo, (req, res) => {
  const { db } = req.app.locals.ctx;
  db.prepare('UPDATE ammo_types SET name = COALESCE(?, name), caliber = ?, unit = COALESCE(?, unit), price = ?, min_stock = ?, active = ? WHERE id = ?')
    .run(str(req.body.name), str(req.body.caliber), str(req.body.unit), parseFloat(String(req.body.price || '').replace(',', '.')) || null,
      int(req.body.min_stock), req.body.active === '0' ? 0 : 1, int(req.params.id));
  res.redirect('/vapen/ammo');
});

router.post('/ammo', canEditAmmo, (req, res) => {
  const { db } = req.app.locals.ctx;
  const kind = ['kjop', 'salg', 'justering'].includes(req.body.kind) ? req.body.kind : null;
  const type = db.prepare('SELECT * FROM ammo_types WHERE id = ?').get(int(req.body.ammo_type_id));
  let qty = int(req.body.quantity);
  if (!kind || !type || !qty || (kind !== 'justering' && qty <= 0)) {
    req.flash('error', 'Velg ammunisjonstype og oppgi antall.'); return res.redirect('/vapen/ammo');
  }
  const memberId = kind === 'salg' ? int(req.body.member_id) : null;
  const counterparty = str(req.body.counterparty);
  if (kind === 'salg' && !memberId && !counterparty) {
    req.flash('error', 'Velg kjøper fra medlemslisten (eller skriv navn på kjøper).'); return res.redirect('/vapen/ammo');
  }
  if (kind === 'salg') {
    const stock = ammoStock(db).find((s) => s.id === type.id);
    if (stock && stock.stock < qty) {
      req.flash('error', `Det er bare ${stock.stock} ${type.unit} på lager.`); return res.redirect('/vapen/ammo');
    }
  }
  let price = parseFloat(String(req.body.unit_price || '').replace(',', '.'));
  if (!Number.isFinite(price)) price = kind === 'salg' ? type.price : null;
  db.prepare(`INSERT INTO ammo_transactions (ammo_type_id, kind, quantity, unit_price, date, member_id, counterparty, paid, note, created_by)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(type.id, kind, qty, price, str(req.body.date) || today(), memberId, counterparty, req.body.paid === '1' ? 1 : 0, str(req.body.note), req.user.id);
  logActivity(db, req.user.id, `ammo-${kind}`, `${qty} ${type.unit} ${type.name}`);
  req.flash('ok', 'Registrert.');
  res.redirect('/vapen/ammo');
});

router.post('/ammo/:id/betalt', canEditAmmo, (req, res) => {
  req.app.locals.ctx.db.prepare('UPDATE ammo_transactions SET paid = 1 - paid WHERE id = ?').run(int(req.params.id));
  res.redirect('/vapen/ammo');
});

router.post('/ammo/:id/slett', canEditAmmo, (req, res) => {
  const { db } = req.app.locals.ctx;
  db.prepare('DELETE FROM ammo_transactions WHERE id = ?').run(int(req.params.id));
  logActivity(db, req.user.id, 'ammo-slettet', String(req.params.id));
  res.redirect('/vapen/ammo');
});

// ---- Utlånserklæringer -----------------------------------------------------

function fillTemplate(template, vals) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (vals[k] != null && vals[k] !== '' ? vals[k] : '________'));
}

function loanValues(clubName, w, m, loan) {
  return {
    lag: clubName,
    navn: fullName(m),
    fodselsdato: fmtDate(m.birth_date),
    skytterid: m.shooter_id,
    adresse: [m.address, [m.postal_code, m.city].filter(Boolean).join(' ')].filter(Boolean).join(', '),
    epost: m.email,
    telefon: m.phone,
    vapentype: w.kind === 'del' ? (w.part_type || 'Våpendel') : 'Rifle',
    fabrikat: [w.manufacturer, w.model].filter(Boolean).join(' '),
    kaliber: w.caliber,
    serienummer: w.serial_number,
    vapenkort: w.card_number,
    fra: fmtDate(loan.from_date),
    til: loan.to_date ? fmtDate(loan.to_date) : 'inntil videre',
    formal: loan.purpose,
    dato: fmtDate(today()),
  };
}

router.get('/utlan', (req, res) => {
  const { db } = req.app.locals.ctx;
  const loans = db.prepare(`SELECT l.*, w.kind, w.part_type, w.manufacturer, w.model, w.caliber, w.serial_number, w.card_number,
                                   m.first_name, m.last_name, m.shooter_id
                            FROM loans l JOIN weapons w ON w.id = l.weapon_id JOIN members m ON m.id = l.member_id
                            ORDER BY l.status = 'aktiv' DESC, l.from_date DESC`).all();
  res.render('weapons/loans', { title: 'Utlånserklæringer', loans, weaponLabel, canEdit: hasBoardRole(req.user, 'vapenansvarlig') });
});

router.get('/utlan/mal', canEditWeapons, (req, res) => {
  const { db } = req.app.locals.ctx;
  res.render('weapons/template', { title: 'Mal for utlånserklæring', template: getSetting(db, 'loan_template', DEFAULT_LOAN_TEMPLATE) });
});

router.post('/utlan/mal', canEditWeapons, (req, res) => {
  const { db } = req.app.locals.ctx;
  const t = req.body.reset === '1' ? DEFAULT_LOAN_TEMPLATE : String(req.body.template || '').replace(/\r\n/g, '\n');
  if (!t.trim()) { req.flash('error', 'Malen kan ikke være tom.'); return res.redirect('/vapen/utlan/mal'); }
  setSetting(db, 'loan_template', t);
  logActivity(db, req.user.id, 'utlansmal-endret', null);
  req.flash('ok', req.body.reset === '1' ? 'Malen er tilbakestilt til standard.' : 'Malen er lagret.');
  res.redirect('/vapen/utlan/mal');
});

router.get('/utlan/ny', canEditWeapons, (req, res) => {
  const { db } = req.app.locals.ctx;
  const weapons = db.prepare("SELECT * FROM weapons WHERE status = 'aktiv' ORDER BY kind, manufacturer, model").all();
  const members = db.prepare('SELECT id, first_name, last_name, shooter_id, email FROM members WHERE active = 1 ORDER BY last_name, first_name').all();
  res.render('weapons/loan-new', { title: 'Ny utlånserklæring', weapons, members, weaponLabel, weaponId: int(req.query.vapen), now: today() });
});

router.post('/utlan/ny', canEditWeapons, (req, res) => {
  const { db } = req.app.locals.ctx;
  const w = db.prepare('SELECT * FROM weapons WHERE id = ?').get(int(req.body.weapon_id));
  const m = db.prepare('SELECT * FROM members WHERE id = ?').get(int(req.body.member_id));
  if (!w || !m) { req.flash('error', 'Velg våpen og skytter.'); return res.redirect('/vapen/utlan/ny'); }
  const loan = { from_date: str(req.body.from_date) || today(), to_date: str(req.body.to_date), purpose: str(req.body.purpose) };
  const text = fillTemplate(getSetting(db, 'loan_template', DEFAULT_LOAN_TEMPLATE), loanValues(res.locals.clubName, w, m, loan));
  const id = tx(db, () => {
    const r = db.prepare('INSERT INTO loans (weapon_id, member_id, from_date, to_date, purpose, text, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(w.id, m.id, loan.from_date, loan.to_date, loan.purpose, text, req.user.id);
    db.prepare("UPDATE weapons SET status = 'utlant' WHERE id = ?").run(w.id);
    return r.lastInsertRowid;
  });
  logActivity(db, req.user.id, 'utlan-opprettet', `${weaponLabel(w)} → ${fullName(m)}`);
  req.flash('ok', 'Utlånserklæringen er laget. Kontroller teksten, og send den på e-post eller skriv den ut for signering.');
  res.redirect(`/vapen/utlan/${id}`);
});

function loadLoan(db, id) {
  return db.prepare(`SELECT l.*, w.kind, w.part_type, w.manufacturer, w.model, w.caliber, w.serial_number,
                            m.first_name, m.last_name, m.email, m.shooter_id
                     FROM loans l JOIN weapons w ON w.id = l.weapon_id JOIN members m ON m.id = l.member_id WHERE l.id = ?`).get(id);
}

router.get('/utlan/:id', (req, res) => {
  const loan = loadLoan(req.app.locals.ctx.db, int(req.params.id));
  if (!loan) return res.status(404).render('error', { title: 'Ikke funnet', message: 'Utlånet finnes ikke.' });
  res.render('weapons/loan', { title: 'Utlånserklæring', loan, weaponLabel, canEdit: hasBoardRole(req.user, 'vapenansvarlig') });
});

router.get('/utlan/:id/skriv-ut', (req, res) => {
  const loan = loadLoan(req.app.locals.ctx.db, int(req.params.id));
  if (!loan) return res.status(404).render('error', { title: 'Ikke funnet', message: 'Utlånet finnes ikke.' });
  res.render('weapons/loan-print', { title: 'Utlånserklæring', loan, print: true });
});

router.post('/utlan/:id', canEditWeapons, (req, res) => {
  const { db } = req.app.locals.ctx;
  const loan = loadLoan(db, int(req.params.id));
  if (!loan) return res.redirect('/vapen/utlan');
  const text = String(req.body.text || '').replace(/\r\n/g, '\n');
  if (text.trim()) db.prepare('UPDATE loans SET text = ? WHERE id = ?').run(text, loan.id);
  req.flash('ok', 'Teksten er lagret.');
  res.redirect(`/vapen/utlan/${loan.id}`);
});

router.post('/utlan/:id/retur', canEditWeapons, (req, res) => {
  const { db } = req.app.locals.ctx;
  const loan = loadLoan(db, int(req.params.id));
  if (!loan) return res.redirect('/vapen/utlan');
  tx(db, () => {
    db.prepare("UPDATE loans SET status = 'returnert', returned_at = ? WHERE id = ?").run(today(), loan.id);
    const other = db.prepare("SELECT 1 FROM loans WHERE weapon_id = ? AND status = 'aktiv' AND id != ?").get(loan.weapon_id, loan.id);
    if (!other) db.prepare("UPDATE weapons SET status = 'aktiv' WHERE id = ? AND status = 'utlant'").run(loan.weapon_id);
  });
  logActivity(db, req.user.id, 'utlan-returnert', String(loan.id));
  req.flash('ok', 'Våpenet er registrert som levert tilbake.');
  res.redirect(`/vapen/utlan/${loan.id}`);
});

function loanHtml(loan, clubName) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><html lang="nb"><head><meta charset="utf-8"><title>Utlånserklæring – ${esc(clubName)}</title>
<style>body{font-family:Georgia,serif;max-width:700px;margin:40px auto;line-height:1.5}pre{white-space:pre-wrap;font-family:inherit}</style>
</head><body><pre>${esc(loan.text)}</pre></body></html>`;
}

/** Sender erklæringen til skytteren (kopi til avsender) og arkiverer den i mappen «Utlånserklæringer». */
router.post('/utlan/:id/send', canEditWeapons, async (req, res, next) => {
  try {
    const { db, mailer, uploadDir } = req.app.locals.ctx;
    const loan = loadLoan(db, int(req.params.id));
    if (!loan) return res.redirect('/vapen/utlan');
    const to = str(req.body.to) || loan.email;
    if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
      req.flash('error', 'Skytteren har ingen gyldig e-postadresse. Oppgi en adresse.'); return res.redirect(`/vapen/utlan/${loan.id}`);
    }
    const name = `${loan.first_name} ${loan.last_name}`;
    const html = loanHtml(loan, res.locals.clubName);
    const fileName = `Utlånserklæring ${name} ${loan.from_date}.html`;
    let status; let error = null;
    try {
      const r = await mailer.send({
        to: { name, address: to },
        cc: req.user.email,
        subject: `Utlånserklæring – ${res.locals.clubName}`,
        text: `Hei ${loan.first_name}!\n\nVedlagt er utlånserklæring for ${weaponLabel(loan)}${loan.serial_number ? `, serienr. ${loan.serial_number}` : ''}.\nSkriv den ut, signer og lever den til våpenansvarlig.\n\n${loan.text}\n\nMed vennlig hilsen\n${req.user.name}\n${res.locals.clubName}`,
        attachments: [{ filename: fileName, content: html, contentType: 'text/html; charset=utf-8' }],
        replyTo: { name: req.user.name, address: req.user.email },
        fromName: `${req.user.name} – ${res.locals.clubName}`,
      });
      status = r.status;
    } catch (e) { status = 'feilet'; error = e.message; }

    if (status !== 'feilet') {
      tx(db, () => {
        db.prepare("UPDATE loans SET emailed_at = datetime('now') WHERE id = ?").run(loan.id);
        // Arkiver kopi i dokumentarkivet
        const stored = crypto.randomBytes(16).toString('hex');
        fs.writeFileSync(path.join(uploadDir, stored), html);
        const d = db.prepare("INSERT INTO documents (title, folder_id, owner_id, default_access) VALUES (?, ?, ?, 'read')")
          .run(`Utlånserklæring – ${name} (${fmtDate(loan.from_date)})`, folderIdByKey(db, 'utlan'), req.user.id);
        const v = db.prepare(`INSERT INTO document_versions (document_id, version, stored_name, original_name, mime, size, uploaded_by)
                              VALUES (?, 1, ?, ?, 'text/html', ?, ?)`).run(d.lastInsertRowid, stored, fileName, Buffer.byteLength(html), req.user.id);
        db.prepare('UPDATE documents SET current_version_id = ? WHERE id = ?').run(v.lastInsertRowid, d.lastInsertRowid);
      });
    }
    db.prepare('INSERT INTO emails (sender_id, subject, body, recipients, document_ids, mode, status, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.user.id, `Utlånserklæring – ${name}`, loan.text, JSON.stringify([{ name, email: to }]), '[]', 'vedlegg', status, error);
    logActivity(db, req.user.id, 'utlan-sendt', `${name} (${status})`);
    if (status === 'feilet') req.flash('error', `Sending feilet: ${error}`);
    else if (status === 'simulert') req.flash('ok', 'Erklæringen er arkivert, men SMTP er ikke konfigurert – e-posten ble ikke faktisk sendt.');
    else req.flash('ok', `Erklæringen er sendt til ${to} og arkivert under Dokumenter → Utlånserklæringer.`);
    res.redirect(`/vapen/utlan/${loan.id}`);
  } catch (e) { next(e); }
});

// ---- Enkeltvåpen (må stå sist pga. /:id) ------------------------------------

router.get('/:id', (req, res) => {
  const { db } = req.app.locals.ctx;
  const w = db.prepare('SELECT * FROM weapons WHERE id = ?').get(int(req.params.id));
  if (!w) return res.status(404).render('error', { title: 'Ikke funnet', message: 'Våpenet finnes ikke.' });
  const card = w.card_document_id ? db.prepare('SELECT * FROM documents WHERE id = ?').get(w.card_document_id) : null;
  const cardReadable = card && hasLevel(db, req.user, card, 'read');
  const loans = db.prepare(`SELECT l.*, m.first_name, m.last_name FROM loans l JOIN members m ON m.id = l.member_id
                            WHERE l.weapon_id = ? ORDER BY l.from_date DESC`).all(w.id);
  res.render('weapons/show', { title: weaponLabel(w) || 'Våpen', weapon: w, card: cardReadable ? card : null, loans, KINDS, PART_TYPES, WEAPON_STATUS, weaponLabel, canEdit: hasBoardRole(req.user, 'vapenansvarlig') });
});

router.post('/:id', canEditWeapons, cardUpload, (req, res) => {
  const { db } = req.app.locals.ctx;
  const w = db.prepare('SELECT * FROM weapons WHERE id = ?').get(int(req.params.id));
  if (!w) { if (req.file) fs.rm(req.file.path, { force: true }, () => {}); return res.redirect('/vapen'); }
  const upd = {};
  for (const f of FIELDS) upd[f] = str(req.body[f]);
  const status = WEAPON_STATUS[req.body.status] ? req.body.status : w.status;
  tx(db, () => {
    db.prepare(`UPDATE weapons SET ${FIELDS.map((f) => `${f} = ?`).join(', ')}, status = ? WHERE id = ?`).run(...FIELDS.map((f) => upd[f]), status, w.id);
    if (req.file) db.prepare('UPDATE weapons SET card_document_id = ? WHERE id = ?').run(storeCard(db, req.user, req.file, { ...w, ...upd }), w.id);
  });
  logActivity(db, req.user.id, 'vapen-endret', `${weaponLabel({ ...w, ...upd })} ${upd.serial_number || ''}`);
  req.flash('ok', 'Lagret.');
  res.redirect(`/vapen/${w.id}`);
});

module.exports = router;
