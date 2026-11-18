'use strict';
const express = require('express');
const { logActivity } = require('../db');
const { requireLogin, requireRole } = require('../auth');
const { str, int, today, asArray } = require('../helpers');

const router = express.Router();
router.use(requireLogin);

const FIELDS = ['name', 'date', 'end_date', 'location', 'organizer', 'signup_deadline', 'url', 'notes'];

function fromBody(body) {
  const c = {};
  for (const f of FIELDS) c[f] = str(body[f]);
  if (c.url && !/^https?:\/\//i.test(c.url)) c.url = `https://${c.url}`;
  c.own_event = body.own_event === '1' ? 1 : 0;
  return c;
}

router.get('/', (req, res) => {
  const { db } = req.app.locals.ctx;
  const now = today();
  const all = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM competition_participants p WHERE p.competition_id = c.id) AS participants
                          FROM competitions c ORDER BY c.date`).all();
  const upcoming = all.filter((c) => (c.end_date || c.date) >= now);
  const past = all.filter((c) => (c.end_date || c.date) < now).reverse();
  res.render('competitions/list', { title: 'Stevner', upcoming, past, now });
});

router.post('/', requireRole('styre'), (req, res) => {
  const { db } = req.app.locals.ctx;
  const c = fromBody(req.body);
  if (!c.name || !c.date) { req.flash('error', 'Oppgi navn og dato.'); return res.redirect('/stevner'); }
  const r = db.prepare(`INSERT INTO competitions (${FIELDS.join(', ')}, own_event) VALUES (${FIELDS.map(() => '?').join(', ')}, ?)`)
    .run(...FIELDS.map((f) => c[f]), c.own_event);
  logActivity(db, req.user.id, 'stevne-opprettet', c.name);
  res.redirect(`/stevner/${r.lastInsertRowid}`);
});

router.get('/:id', (req, res) => {
  const { db } = req.app.locals.ctx;
  const c = db.prepare('SELECT * FROM competitions WHERE id = ?').get(int(req.params.id));
  if (!c) return res.status(404).render('error', { title: 'Ikke funnet', message: 'Stevnet finnes ikke.' });
  const participants = db.prepare(`SELECT p.*, m.first_name, m.last_name, m.shooter_id, m.class AS member_class
                                   FROM competition_participants p JOIN members m ON m.id = p.member_id
                                   WHERE p.competition_id = ? ORDER BY m.last_name, m.first_name`).all(c.id);
  const ids = new Set(participants.map((p) => p.member_id));
  const members = db.prepare('SELECT id, first_name, last_name, shooter_id FROM members WHERE active = 1 ORDER BY last_name, first_name').all()
    .filter((m) => !ids.has(m.id));
  res.render('competitions/show', { title: c.name, competition: c, participants, members });
});

router.post('/:id', requireRole('styre'), (req, res) => {
  const { db } = req.app.locals.ctx;
  const old = db.prepare('SELECT * FROM competitions WHERE id = ?').get(int(req.params.id));
  if (!old) return res.redirect('/stevner');
  const c = fromBody(req.body);
  c.name = c.name || old.name;
  c.date = c.date || old.date;
  db.prepare(`UPDATE competitions SET ${FIELDS.map((f) => `${f} = ?`).join(', ')}, own_event = ? WHERE id = ?`).run(...FIELDS.map((f) => c[f]), c.own_event, old.id);
  req.flash('ok', 'Stevnet er lagret.');
  res.redirect(`/stevner/${old.id}`);
});

router.post('/:id/slett', requireRole('styre'), (req, res) => {
  req.app.locals.ctx.db.prepare('DELETE FROM competitions WHERE id = ?').run(int(req.params.id));
  req.flash('ok', 'Stevnet er slettet.');
  res.redirect('/stevner');
});

router.post('/:id/deltakere', requireRole('styre'), (req, res) => {
  const { db } = req.app.locals.ctx;
  const id = int(req.params.id);
  for (const mid of asArray(req.body.member_ids).map(Number)) {
    db.prepare('INSERT OR IGNORE INTO competition_participants (competition_id, member_id) SELECT ?, id FROM members WHERE id = ?').run(id, mid);
  }
  res.redirect(`/stevner/${id}#deltakere`);
});

router.post('/:id/deltakere/:memberId', requireRole('styre'), (req, res) => {
  const { db } = req.app.locals.ctx;
  const id = int(req.params.id);
  if (req.body.remove === '1') {
    db.prepare('DELETE FROM competition_participants WHERE competition_id = ? AND member_id = ?').run(id, int(req.params.memberId));
  } else {
    db.prepare('UPDATE competition_participants SET class = ?, result = ? WHERE competition_id = ? AND member_id = ?')
      .run(str(req.body.class), str(req.body.result), id, int(req.params.memberId));
  }
  res.redirect(`/stevner/${id}#deltakere`);
});

module.exports = router;
