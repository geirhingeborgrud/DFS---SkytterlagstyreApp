'use strict';
const express = require('express');
const multer = require('multer');
const { tx, logActivity } = require('../db');
const { requireLogin, requireRole, verifyCsrf } = require('../auth');
const { str, int, asArray, BOARD_ROLES, fullName, today } = require('../helpers');
const { membersFromCsv, toIsoDate } = require('../csv');

const router = express.Router();
// Medlemsregisteret inneholder personopplysninger – kun for styret
router.use(requireLogin, requireRole('styre'));

const csvUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

const FIELDS = ['shooter_id', 'first_name', 'last_name', 'birth_date', 'email', 'phone', 'address', 'postal_code', 'city', 'class', 'notes'];

function fromBody(body) {
  const m = {};
  for (const f of FIELDS) m[f] = str(body[f]);
  m.birth_date = toIsoDate(m.birth_date) || m.birth_date;
  return m;
}

function setRoles(db, memberId, roles) {
  db.prepare('DELETE FROM member_roles WHERE member_id = ?').run(memberId);
  for (const r of roles) if (BOARD_ROLES[r]) db.prepare('INSERT INTO member_roles (member_id, role) VALUES (?, ?)').run(memberId, r);
}

router.get('/', (req, res) => {
  const { db } = req.app.locals.ctx;
  const q = str(req.query.q);
  const showInactive = req.query.alle === '1';
  let sql = `SELECT m.*, GROUP_CONCAT(r.role) AS roles FROM members m LEFT JOIN member_roles r ON r.member_id = m.id WHERE 1=1`;
  const params = [];
  if (!showInactive) sql += ' AND m.active = 1';
  if (q) {
    sql += ` AND (m.first_name || ' ' || m.last_name LIKE ? OR m.shooter_id LIKE ? OR m.email LIKE ?)`;
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  sql += ' GROUP BY m.id ORDER BY m.last_name, m.first_name';
  const members = db.prepare(sql).all(...params).map((m) => ({ ...m, roles: m.roles ? m.roles.split(',') : [] }));
  res.render('members/list', { title: 'Medlemmer', members, q, showInactive, now: today() });
});

router.get('/ny', (req, res) => {
  res.render('members/form', { title: 'Nytt medlem', member: { active: 1 }, roles: [] });
});

router.post('/ny', (req, res) => {
  const { db } = req.app.locals.ctx;
  const m = fromBody(req.body);
  if (!m.first_name || !m.last_name) {
    return res.status(400).render('members/form', { title: 'Nytt medlem', member: m, roles: asArray(req.body.roles), error: 'Fornavn og etternavn må fylles ut.' });
  }
  if (m.shooter_id && db.prepare('SELECT 1 FROM members WHERE shooter_id = ?').get(m.shooter_id)) {
    return res.status(400).render('members/form', { title: 'Nytt medlem', member: m, roles: asArray(req.body.roles), error: 'Skytter-ID er allerede registrert.' });
  }
  const id = tx(db, () => {
    const r = db.prepare(`INSERT INTO members (${FIELDS.join(', ')}) VALUES (${FIELDS.map(() => '?').join(', ')})`).run(...FIELDS.map((f) => m[f]));
    if (req.user.role === 'admin') setRoles(db, r.lastInsertRowid, asArray(req.body.roles));
    return r.lastInsertRowid;
  });
  logActivity(db, req.user.id, 'medlem-opprettet', fullName(m));
  req.flash('ok', `${fullName(m)} er lagt til.`);
  res.redirect(`/medlemmer/${id}`);
});

router.get('/import', (req, res) => {
  res.render('members/import', { title: 'Importer medlemmer' });
});

router.post('/import', csvUpload.single('file'), verifyCsrf, (req, res) => {
  const { db } = req.app.locals.ctx;
  if (!req.file) { req.flash('error', 'Velg en CSV-fil.'); return res.redirect('/medlemmer/import'); }
  const { members, unknownHeaders } = membersFromCsv(req.file.buffer);
  if (!members.length) {
    req.flash('error', 'Fant ingen medlemmer i filen. Sjekk at første rad inneholder kolonnenavn som «Fornavn», «Etternavn», «Skytter-ID», «E-post».');
    return res.redirect('/medlemmer/import');
  }
  const result = { created: 0, updated: 0 };
  const deactivateMissing = req.body.deactivate === '1';
  const seen = new Set();
  tx(db, () => {
    for (const m of members) {
      let existing = null;
      if (m.shooter_id) existing = db.prepare('SELECT * FROM members WHERE shooter_id = ?').get(m.shooter_id);
      if (!existing) {
        existing = db.prepare(`SELECT * FROM members WHERE lower(first_name) = lower(?) AND lower(last_name) = lower(?)
                               AND (birth_date IS ? OR birth_date IS NULL OR ? IS NULL)`).get(m.first_name, m.last_name, m.birth_date, m.birth_date);
      }
      if (existing) {
        // Oppdater kun felt som har verdi i importen
        const upd = FIELDS.filter((f) => f !== 'notes' && m[f] != null);
        db.prepare(`UPDATE members SET ${upd.map((f) => `${f} = ?`).join(', ')}, active = 1 WHERE id = ?`).run(...upd.map((f) => m[f]), existing.id);
        seen.add(existing.id);
        result.updated++;
      } else {
        const cols = FIELDS.filter((f) => f !== 'notes');
        const r = db.prepare(`INSERT INTO members (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((f) => m[f]));
        seen.add(Number(r.lastInsertRowid));
        result.created++;
      }
    }
    if (deactivateMissing) {
      const all = db.prepare('SELECT id FROM members WHERE active = 1').all();
      for (const { id } of all) {
        // Medlemmer med verv eller brukerkonto deaktiveres ikke automatisk
        const protectedMember = db.prepare('SELECT 1 FROM member_roles WHERE member_id = ? UNION SELECT 1 FROM users WHERE member_id = ?').get(id, id);
        if (!seen.has(id) && !protectedMember) { db.prepare('UPDATE members SET active = 0 WHERE id = ?').run(id); result.deactivated = (result.deactivated || 0) + 1; }
      }
    }
  });
  logActivity(db, req.user.id, 'medlemsimport', JSON.stringify(result));
  let msg = `Import fullført: ${result.created} nye, ${result.updated} oppdatert`;
  if (result.deactivated) msg += `, ${result.deactivated} satt som inaktive`;
  if (unknownHeaders.length) msg += `. Ignorerte kolonner: ${unknownHeaders.join(', ')}`;
  req.flash('ok', msg + '.');
  res.redirect('/medlemmer');
});

router.get('/eksport.csv', (req, res) => {
  const { db } = req.app.locals.ctx;
  const rows = db.prepare('SELECT * FROM members WHERE active = 1 ORDER BY last_name, first_name').all();
  const esc = (v) => (v == null ? '' : /[";\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
  const head = ['Skytter-ID', 'Fornavn', 'Etternavn', 'Fødselsdato', 'E-post', 'Mobil', 'Adresse', 'Postnr', 'Poststed', 'Klasse'];
  const lines = [head.join(';'), ...rows.map((m) => ['shooter_id', 'first_name', 'last_name', 'birth_date', 'email', 'phone', 'address', 'postal_code', 'city', 'class'].map((f) => esc(m[f])).join(';'))];
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="medlemmer.csv"');
  res.send('﻿' + lines.join('\r\n'));
});

router.get('/:id', (req, res) => {
  const { db } = req.app.locals.ctx;
  const member = db.prepare('SELECT * FROM members WHERE id = ?').get(int(req.params.id));
  if (!member) return res.status(404).render('error', { title: 'Ikke funnet', message: 'Medlemmet finnes ikke.' });
  const roles = db.prepare('SELECT role FROM member_roles WHERE member_id = ?').all(member.id).map((r) => r.role);
  const purchases = db.prepare(`SELECT t.*, a.name AS ammo_name, a.unit FROM ammo_transactions t JOIN ammo_types a ON a.id = t.ammo_type_id
                                WHERE t.member_id = ? ORDER BY t.date DESC`).all(member.id);
  const loans = db.prepare(`SELECT l.*, w.manufacturer, w.model, w.serial_number FROM loans l JOIN weapons w ON w.id = l.weapon_id
                            WHERE l.member_id = ? ORDER BY l.from_date DESC`).all(member.id);
  const competitions = db.prepare(`SELECT c.*, p.class AS p_class, p.result FROM competitions c JOIN competition_participants p ON p.competition_id = c.id
                                   WHERE p.member_id = ? ORDER BY c.date DESC`).all(member.id);
  const user = db.prepare('SELECT id, role, last_seen FROM users WHERE member_id = ?').get(member.id);
  res.render('members/show', { title: fullName(member), member, roles, purchases, loans, competitions, linkedUser: user });
});

router.post('/:id', (req, res) => {
  const { db } = req.app.locals.ctx;
  const existing = db.prepare('SELECT * FROM members WHERE id = ?').get(int(req.params.id));
  if (!existing) return res.redirect('/medlemmer');
  const m = fromBody(req.body);
  if (!m.first_name || !m.last_name) { req.flash('error', 'Fornavn og etternavn må fylles ut.'); return res.redirect(`/medlemmer/${existing.id}`); }
  if (m.shooter_id && db.prepare('SELECT 1 FROM members WHERE shooter_id = ? AND id != ?').get(m.shooter_id, existing.id)) {
    req.flash('error', 'Skytter-ID er allerede registrert på et annet medlem.'); return res.redirect(`/medlemmer/${existing.id}`);
  }
  tx(db, () => {
    db.prepare(`UPDATE members SET ${FIELDS.map((f) => `${f} = ?`).join(', ')}, active = ? WHERE id = ?`)
      .run(...FIELDS.map((f) => m[f]), req.body.active === '1' ? 1 : 0, existing.id);
    // Verv styrer tilganger (f.eks. våpenansvarlig) – kun administrator kan endre dem
    if (req.user.role === 'admin' && req.body.roles_submitted === '1') setRoles(db, existing.id, asArray(req.body.roles));
  });
  logActivity(db, req.user.id, 'medlem-endret', fullName(m));
  req.flash('ok', 'Medlemmet er lagret.');
  res.redirect(`/medlemmer/${existing.id}`);
});

module.exports = router;
