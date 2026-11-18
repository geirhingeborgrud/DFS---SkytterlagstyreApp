'use strict';
const express = require('express');
const { requireLogin } = require('../auth');
const { visibleDocuments } = require('../permissions');
const { monthGrid, eventsBetween, addDays } = require('../calendar');
const { today } = require('../helpers');
const { boardMembers } = require('./board');

const router = express.Router();

router.get('/', requireLogin, (req, res) => {
  const { db } = req.app.locals.ctx;
  const now = today();
  const month = Number(now.slice(5, 7));
  const year = Number(now.slice(0, 4));

  const weeks = monthGrid(db, year, month);
  const upcoming = eventsBetween(db, now, addDays(now, 30)).slice(0, 8);
  const board = boardMembers(db);
  const online = db.prepare('SELECT id, name, last_seen, member_id FROM users WHERE active = 1 AND last_seen > ? ORDER BY name')
    .all(Date.now() - 5 * 60 * 1000);
  const myTasks = db.prepare(`SELECT * FROM tasks WHERE assignee_id = ? AND status != 'ferdig'
                              ORDER BY due_date IS NULL, due_date LIMIT 8`).all(req.user.id);
  const overdue = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE status != 'ferdig' AND due_date < ?`).get(now).n;
  const annual = db.prepare('SELECT * FROM annual_items WHERE month = ? ORDER BY day, id').all(month);
  const docs = visibleDocuments(db, req.user).slice(0, 6);
  const lowAmmo = req.user.role === 'les' ? [] : db.prepare(`SELECT a.name, a.unit, a.min_stock,
      COALESCE((SELECT SUM(CASE t.kind WHEN 'kjop' THEN t.quantity WHEN 'salg' THEN -t.quantity ELSE t.quantity END)
                FROM ammo_transactions t WHERE t.ammo_type_id = a.id), 0) AS stock
      FROM ammo_types a WHERE a.active = 1 AND a.min_stock IS NOT NULL`).all().filter((a) => a.stock < a.min_stock);

  res.render('dashboard', { title: 'Oversikt', weeks, upcoming, board, online, myTasks, overdue, annual, docs, lowAmmo, month, year, now });
});

module.exports = router;
