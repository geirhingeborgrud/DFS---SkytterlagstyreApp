'use strict';
const express = require('express');
const { logActivity } = require('../db');
const { requireLogin, requireRole } = require('../auth');
const { str, int, BOARD_CORE, fullName } = require('../helpers');
const { issueInvite, baseUrl } = require('./auth');

const router = express.Router();
router.use(requireLogin);

const ROLES = ['admin', 'styre', 'les'];

/** Styremedlemmer (medlemmer med styreverv), med verv og ev. tilknyttet bruker. */
function boardMembers(db) {
  const rows = db.prepare(`SELECT m.*, GROUP_CONCAT(r.role) AS roles, u.id AS user_id, u.last_seen
                           FROM members m JOIN member_roles r ON r.member_id = m.id
                           LEFT JOIN users u ON u.member_id = m.id AND u.active = 1
                           WHERE m.active = 1
                           GROUP BY m.id`).all();
  const order = (roles) => Math.min(...roles.map((r) => (BOARD_CORE.includes(r) ? BOARD_CORE.indexOf(r) : 99)));
  return rows
    .map((m) => ({ ...m, roles: m.roles.split(',').sort((a, b) => order([a]) - order([b])) }))
    .sort((a, b) => order(a.roles) - order(b.roles) || fullName(a).localeCompare(fullName(b), 'nb'));
}

router.get('/', (req, res) => {
  const { db } = req.app.locals.ctx;
  const board = boardMembers(db);
  const users = db.prepare(`SELECT u.id, u.name, u.email, u.phone, u.role, u.active, u.last_seen, u.member_id,
                                   u.password_hash IS NOT NULL AS has_password
                            FROM users u ORDER BY u.active DESC, u.name`).all();
  const linkedIds = new Set(users.map((u) => u.member_id).filter(Boolean));
  const members = db.prepare('SELECT id, first_name, last_name, email FROM members WHERE active = 1 ORDER BY last_name, first_name').all();
  const unlinkedBoard = board.filter((m) => !linkedIds.has(m.id));
  res.render('board', { title: 'Styret', board, users, members, unlinkedBoard, inviteLink: req.session.inviteLink || null });
  delete req.session.inviteLink;
});

async function sendInvite(req, res, user) {
  const { db, mailer } = req.app.locals.ctx;
  const token = issueInvite(db, user.id);
  const link = `${baseUrl(req)}/invitasjon/${token}`;
  let sent = false;
  try {
    const r = await mailer.send({
      to: user.email,
      subject: `Invitasjon til styreappen for ${res.locals.clubName}`,
      text: `Hei ${user.name}!\n\n${req.user.name} har gitt deg tilgang til styreappen for ${res.locals.clubName}.\n\nVelg passord her (lenken er gyldig i 7 dager):\n${link}\n\nMed vennlig hilsen\n${res.locals.clubName}`,
    });
    sent = r.status === 'sendt';
  } catch (e) {
    console.error('Invitasjon feilet:', e.message);
  }
  // Vis alltid lenken til admin, slik at den kan deles manuelt ved behov
  req.session.inviteLink = { name: user.name, link, sent };
}

/** Gi innloggingstilgang – enten fra et medlem i registeret eller med navn/e-post direkte. */
router.post('/brukere', requireRole('admin'), async (req, res, next) => {
  try {
    const { db } = req.app.locals.ctx;
    const member = int(req.body.member_id) ? db.prepare('SELECT * FROM members WHERE id = ?').get(int(req.body.member_id)) : null;
    const name = str(req.body.name) || (member && fullName(member));
    const email = str(req.body.email) || (member && member.email);
    const role = ROLES.includes(req.body.role) ? req.body.role : 'styre';
    if (!name || !email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      req.flash('error', 'Oppgi navn og gyldig e-postadresse (eller velg et medlem som har e-post registrert).');
      return res.redirect('/styret');
    }
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      req.flash('error', 'Det finnes allerede en bruker med denne e-postadressen.'); return res.redirect('/styret');
    }
    if (member && db.prepare('SELECT 1 FROM users WHERE member_id = ?').get(member.id)) {
      req.flash('error', 'Dette medlemmet har allerede en bruker.'); return res.redirect('/styret');
    }
    const r = db.prepare('INSERT INTO users (name, email, role, phone, member_id) VALUES (?, ?, ?, ?, ?)')
      .run(name, email, role, member ? member.phone : null, member ? member.id : null);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(r.lastInsertRowid);
    await sendInvite(req, res, user);
    logActivity(db, req.user.id, 'bruker-opprettet', `${name} (${role})`);
    req.flash('ok', `${name} har fått tilgang.`);
    res.redirect('/styret');
  } catch (e) { next(e); }
});

router.post('/brukere/:id/inviter', requireRole('admin'), async (req, res, next) => {
  try {
    const user = req.app.locals.ctx.db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(int(req.params.id));
    if (!user) return res.redirect('/styret');
    await sendInvite(req, res, user);
    res.redirect('/styret');
  } catch (e) { next(e); }
});

router.post('/brukere/:id', requireRole('admin'), (req, res) => {
  const { db } = req.app.locals.ctx;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(int(req.params.id));
  if (!user) return res.redirect('/styret');
  const role = ROLES.includes(req.body.role) ? req.body.role : user.role;
  const active = req.body.active === '1' ? 1 : 0;
  // Hindre at siste aktive administrator mister rettighetene
  if (user.role === 'admin' && (role !== 'admin' || !active)) {
    const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n;
    if (admins <= 1) { req.flash('error', 'Laget må ha minst én aktiv administrator.'); return res.redirect('/styret'); }
  }
  const email = str(req.body.email) || user.email;
  if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(email, user.id)) {
    req.flash('error', 'E-postadressen er i bruk av en annen bruker.'); return res.redirect('/styret');
  }
  const memberId = int(req.body.member_id);
  if (memberId && db.prepare('SELECT 1 FROM users WHERE member_id = ? AND id != ?').get(memberId, user.id)) {
    req.flash('error', 'Medlemmet er allerede koblet til en annen bruker.'); return res.redirect('/styret');
  }
  db.prepare('UPDATE users SET name = ?, email = ?, phone = ?, role = ?, active = ?, member_id = ? WHERE id = ?')
    .run(str(req.body.name) || user.name, email, str(req.body.phone), role, active, memberId, user.id);
  if (!active) db.prepare('DELETE FROM sessions WHERE data LIKE ?').run(`%"userId":${user.id}}%`);
  logActivity(db, req.user.id, 'bruker-endret', `${user.name}: ${role}${active ? '' : ', deaktivert'}`);
  req.flash('ok', `${user.name} er oppdatert.`);
  res.redirect('/styret');
});

module.exports = router;
module.exports.boardMembers = boardMembers;
