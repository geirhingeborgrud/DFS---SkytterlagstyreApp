'use strict';
const express = require('express');
const { requireLogin } = require('../auth');
const { monthGrid, eventsBetween, addDays, TYPES } = require('../calendar');
const { int, today, asArray } = require('../helpers');

const router = express.Router();
router.use(requireLogin);

router.get('/', (req, res) => {
  const { db } = req.app.locals.ctx;
  const now = today();
  let year = int(req.query.ar) || Number(now.slice(0, 4));
  let month = int(req.query.mnd) || Number(now.slice(5, 7));
  if (month < 1 || month > 12) month = Number(now.slice(5, 7));
  const selected = asArray(req.query.vis).filter((t) => TYPES[t]);
  const types = selected.length ? selected : null;
  const weeks = monthGrid(db, year, month, { types });
  const prev = month === 1 ? { ar: year - 1, mnd: 12 } : { ar: year, mnd: month - 1 };
  const next = month === 12 ? { ar: year + 1, mnd: 1 } : { ar: year, mnd: month + 1 };
  const upcoming = eventsBetween(db, now, addDays(now, 60), { types }).slice(0, 30);
  res.render('calendar', { title: 'Kalender', weeks, year, month, prev, next, now, TYPES, selected, upcoming });
});

module.exports = router;
