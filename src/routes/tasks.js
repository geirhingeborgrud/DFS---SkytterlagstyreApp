'use strict';
const express = require('express');
const { requireLogin, requireRole } = require('../auth');
const { str, int, today } = require('../helpers');

const router = express.Router();
router.use(requireLogin);

const STATUSES = ['apen', 'pagar', 'ferdig'];

function safeBack(req, fallback) {
  try {
    const u = new URL(req.get('referer') || '');
    if (u.host === req.get('host')) return u.pathname + u.search;
  } catch { /* ugyldig referer */ }
  return fallback;
}

router.get('/', (req, res) => {
  const { db } = req.app.locals.ctx;
  const year = int(req.query.ar);
  const mine = req.query.mine === '1';
  const showDone = req.query.ferdige === '1';
  let sql = `SELECT t.*, u.name AS assignee_name, m.title AS meeting_title
             FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id LEFT JOIN meetings m ON m.id = t.meeting_id WHERE 1=1`;
  const params = [];
  if (year) { sql += ' AND (t.year = ? OR substr(t.due_date,1,4) = ?)'; params.push(year, String(year)); }
  if (mine) { sql += ' AND t.assignee_id = ?'; params.push(req.user.id); }
  if (!showDone) sql += " AND t.status != 'ferdig'";
  sql += ' ORDER BY t.due_date IS NULL, t.due_date, t.id';
  const tasks = db.prepare(sql).all(...params);
  const users = db.prepare('SELECT id, name FROM users WHERE active = 1 ORDER BY name').all();
  const years = db.prepare("SELECT DISTINCT y FROM (SELECT COALESCE(year, CAST(substr(due_date,1,4) AS INTEGER)) AS y FROM tasks) WHERE y IS NOT NULL ORDER BY y DESC").all().map((r) => r.y);
  res.render('tasks', { title: 'Oppgaver', tasks, users, years, year, mine, showDone, now: today() });
});

router.post('/', requireRole('styre'), (req, res) => {
  const { db } = req.app.locals.ctx;
  const title = str(req.body.title);
  if (!title) { req.flash('error', 'Oppgaven må ha en tittel.'); return res.redirect('/oppgaver'); }
  const due = str(req.body.due_date);
  db.prepare('INSERT INTO tasks (title, description, due_date, assignee_id, year, created_by) VALUES (?, ?, ?, ?, ?, ?)')
    .run(title, str(req.body.description), due, int(req.body.assignee_id), due ? Number(due.slice(0, 4)) : null, req.user.id);
  res.redirect('/oppgaver');
});

/** Statusendring kan gjøres av styret, eller av den oppgaven er tildelt. */
router.post('/:id/status', (req, res) => {
  const { db } = req.app.locals.ctx;
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(int(req.params.id));
  if (!t) return res.redirect('/oppgaver');
  if (!res.locals.canWrite && t.assignee_id !== req.user.id) {
    return res.status(403).render('error', { title: 'Ingen tilgang', message: 'Du kan bare endre dine egne oppgaver.' });
  }
  if (STATUSES.includes(req.body.status)) db.prepare('UPDATE tasks SET status = ? WHERE id = ?').run(req.body.status, t.id);
  res.redirect(safeBack(req, '/oppgaver'));
});

router.post('/:id', requireRole('styre'), (req, res) => {
  const { db } = req.app.locals.ctx;
  const t = db.prepare('SELECT * FROM tasks WHERE id = ?').get(int(req.params.id));
  if (!t) return res.redirect('/oppgaver');
  const status = STATUSES.includes(req.body.status) ? req.body.status : t.status;
  db.prepare('UPDATE tasks SET title = ?, description = ?, due_date = ?, assignee_id = ?, status = ? WHERE id = ?')
    .run(str(req.body.title) || t.title, str(req.body.description), str(req.body.due_date), int(req.body.assignee_id), status, t.id);
  req.flash('ok', 'Oppgaven er lagret.');
  res.redirect('/oppgaver');
});

router.post('/:id/slett', requireRole('styre'), (req, res) => {
  req.app.locals.ctx.db.prepare('DELETE FROM tasks WHERE id = ?').run(int(req.params.id));
  res.redirect('/oppgaver');
});

module.exports = router;
