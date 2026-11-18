'use strict';
const express = require('express');
const { tx, logActivity } = require('../db');
const { requireLogin, requireRole } = require('../auth');
const { str, int, today } = require('../helpers');

const router = express.Router();
router.use(requireLogin);

function itemFromBody(body) {
  const month = int(body.month);
  const day = int(body.day);
  return {
    month: month >= 1 && month <= 12 ? month : null,
    day: day >= 1 && day <= 31 ? day : null,
    title: str(body.title),
    description: str(body.description),
    responsible: str(body.responsible),
  };
}

router.get('/', (req, res) => {
  const { db } = req.app.locals.ctx;
  const items = db.prepare('SELECT * FROM annual_items ORDER BY month, day IS NULL, day, id').all();
  const byMonth = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, items: items.filter((it) => it.month === i + 1) }));
  const year = Number(today().slice(0, 4));
  const generated = db.prepare('SELECT DISTINCT year FROM tasks WHERE annual_item_id IS NOT NULL ORDER BY year').all().map((r) => r.year);
  res.render('annual', { title: 'Årshjul', byMonth, currentMonth: Number(today().slice(5, 7)), year, generated });
});

router.post('/', requireRole('styre'), (req, res) => {
  const { db } = req.app.locals.ctx;
  const it = itemFromBody(req.body);
  if (!it.month || !it.title) { req.flash('error', 'Oppgi måned og tittel.'); return res.redirect('/arshjul'); }
  db.prepare('INSERT INTO annual_items (month, day, title, description, responsible) VALUES (?, ?, ?, ?, ?)')
    .run(it.month, it.day, it.title, it.description, it.responsible);
  res.redirect(`/arshjul#m${it.month}`);
});

/** Lager oppgaver for et år fra årshjulet (hopper over aktiviteter som allerede er generert). */
router.post('/generer', requireRole('styre'), (req, res) => {
  const { db } = req.app.locals.ctx;
  const year = int(req.body.year);
  if (!year || year < 2000 || year > 2100) { req.flash('error', 'Ugyldig år.'); return res.redirect('/arshjul'); }
  const items = db.prepare('SELECT * FROM annual_items').all();
  let created = 0;
  tx(db, () => {
    for (const it of items) {
      const exists = db.prepare('SELECT 1 FROM tasks WHERE annual_item_id = ? AND year = ?').get(it.id, year);
      if (exists) continue;
      const lastDay = new Date(Date.UTC(year, it.month, 0)).getUTCDate();
      const day = Math.min(it.day || lastDay, lastDay);
      const due = `${year}-${String(it.month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const desc = [it.description, it.responsible ? `Ansvarlig (forslag): ${it.responsible}` : null].filter(Boolean).join('\n');
      db.prepare('INSERT INTO tasks (title, description, due_date, annual_item_id, year, created_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(it.title, desc || null, due, it.id, year, req.user.id);
      created++;
    }
  });
  logActivity(db, req.user.id, 'arshjul-generert', `${year}: ${created} oppgaver`);
  req.flash('ok', created ? `${created} oppgaver er opprettet for ${year}. Fordel ansvar under «Oppgaver».` : `Alle aktiviteter for ${year} finnes allerede som oppgaver.`);
  res.redirect(`/oppgaver?ar=${year}`);
});

router.post('/:id', requireRole('styre'), (req, res) => {
  const { db } = req.app.locals.ctx;
  const it = itemFromBody(req.body);
  if (!it.month || !it.title) { req.flash('error', 'Oppgi måned og tittel.'); return res.redirect('/arshjul'); }
  db.prepare('UPDATE annual_items SET month = ?, day = ?, title = ?, description = ?, responsible = ? WHERE id = ?')
    .run(it.month, it.day, it.title, it.description, it.responsible, int(req.params.id));
  req.flash('ok', 'Aktiviteten er lagret.');
  res.redirect(`/arshjul#m${it.month}`);
});

router.post('/:id/slett', requireRole('styre'), (req, res) => {
  req.app.locals.ctx.db.prepare('DELETE FROM annual_items WHERE id = ?').run(int(req.params.id));
  res.redirect('/arshjul');
});

module.exports = router;
