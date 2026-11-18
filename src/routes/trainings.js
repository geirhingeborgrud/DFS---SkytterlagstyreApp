'use strict';
const express = require('express');
const crypto = require('node:crypto');
const { tx, logActivity } = require('../db');
const { requireLogin, requireRole } = require('../auth');
const { monthGrid, addDays } = require('../calendar');
const { str, int, today } = require('../helpers');

const router = express.Router();
router.use(requireLogin);

const FIELDS = ['title', 'date', 'start_time', 'end_time', 'location', 'discipline', 'leader', 'notes'];
const DISCIPLINES = ['Bane 100/200/300 m', 'Felt', 'Innendørs 15 m', 'Skiskyting', 'Ungdom/rekrutt', 'Annet'];

function fromBody(body) {
  const t = {};
  for (const f of FIELDS) t[f] = str(body[f]);
  return t;
}

router.get('/', (req, res) => {
  const { db } = req.app.locals.ctx;
  const now = today();
  const year = int(req.query.ar) || Number(now.slice(0, 4));
  const month = int(req.query.mnd) || Number(now.slice(5, 7));
  const weeks = monthGrid(db, year, month, { types: ['trening'] });
  const upcoming = db.prepare('SELECT * FROM trainings WHERE date >= ? ORDER BY date, start_time LIMIT 30').all(now);
  const prev = month === 1 ? { ar: year - 1, mnd: 12 } : { ar: year, mnd: month - 1 };
  const next = month === 12 ? { ar: year + 1, mnd: 1 } : { ar: year, mnd: month + 1 };
  res.render('trainings/list', { title: 'Treninger', weeks, year, month, prev, next, upcoming, now, DISCIPLINES });
});

/** Oppretter én trening, eller en ukentlig serie (repeat = antall uker). */
router.post('/', requireRole('styre'), (req, res) => {
  const { db } = req.app.locals.ctx;
  const t = fromBody(req.body);
  if (!t.title || !t.date) { req.flash('error', 'Oppgi tittel og dato.'); return res.redirect('/treninger'); }
  const weeks = Math.min(Math.max(int(req.body.repeat) || 1, 1), 52);
  const series = weeks > 1 ? crypto.randomBytes(6).toString('hex') : null;
  tx(db, () => {
    for (let i = 0; i < weeks; i++) {
      db.prepare(`INSERT INTO trainings (${FIELDS.join(', ')}, series) VALUES (${FIELDS.map(() => '?').join(', ')}, ?)`)
        .run(...FIELDS.map((f) => (f === 'date' ? addDays(t.date, 7 * i) : t[f])), series);
    }
  });
  logActivity(db, req.user.id, 'trening-opprettet', `${t.title} ${t.date} (${weeks})`);
  req.flash('ok', weeks > 1 ? `${weeks} ukentlige treninger er lagt inn.` : 'Treningen er lagt inn.');
  res.redirect(`/treninger?ar=${t.date.slice(0, 4)}&mnd=${Number(t.date.slice(5, 7))}`);
});

router.get('/:id', (req, res) => {
  const t = req.app.locals.ctx.db.prepare('SELECT * FROM trainings WHERE id = ?').get(int(req.params.id));
  if (!t) return res.status(404).render('error', { title: 'Ikke funnet', message: 'Treningen finnes ikke.' });
  const seriesCount = t.series ? req.app.locals.ctx.db.prepare('SELECT COUNT(*) AS n FROM trainings WHERE series = ? AND date >= ?').get(t.series, t.date).n : 0;
  res.render('trainings/show', { title: t.title, training: t, seriesCount, DISCIPLINES });
});

router.post('/:id', requireRole('styre'), (req, res) => {
  const { db } = req.app.locals.ctx;
  const t = db.prepare('SELECT * FROM trainings WHERE id = ?').get(int(req.params.id));
  if (!t) return res.redirect('/treninger');
  const u = fromBody(req.body);
  u.title = u.title || t.title;
  u.date = u.date || t.date;
  db.prepare(`UPDATE trainings SET ${FIELDS.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`).run(...FIELDS.map((f) => u[f]), t.id);
  req.flash('ok', 'Treningen er lagret.');
  res.redirect(`/treninger/${t.id}`);
});

router.post('/:id/slett', requireRole('styre'), (req, res) => {
  const { db } = req.app.locals.ctx;
  const t = db.prepare('SELECT * FROM trainings WHERE id = ?').get(int(req.params.id));
  if (!t) return res.redirect('/treninger');
  if (req.body.series === '1' && t.series) db.prepare('DELETE FROM trainings WHERE series = ? AND date >= ?').run(t.series, t.date);
  else db.prepare('DELETE FROM trainings WHERE id = ?').run(t.id);
  req.flash('ok', 'Slettet.');
  res.redirect('/treninger');
});

module.exports = router;
