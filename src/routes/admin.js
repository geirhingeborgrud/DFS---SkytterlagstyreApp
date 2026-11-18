'use strict';
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const { setSetting, getSetting, logActivity } = require('../db');
const { requireLogin, requireRole, verifyCsrf } = require('../auth');
const { str, int } = require('../helpers');

const router = express.Router();
router.use(requireLogin, requireRole('admin'));

router.get('/', (req, res) => {
  const { db, mailer } = req.app.locals.ctx;
  const folders = db.prepare(`SELECT f.*, p.name AS parent_name, (SELECT COUNT(*) FROM documents d WHERE d.folder_id = f.id) AS docs
                              FROM folders f LEFT JOIN folders p ON p.id = f.parent_id
                              WHERE f.parent_id IS NULL OR p.parent_id IS NULL
                              ORDER BY COALESCE(p.sort, f.sort), f.parent_id IS NOT NULL, f.sort, f.name`).all();
  const log = db.prepare(`SELECT a.*, u.name AS user_name FROM activity_log a LEFT JOIN users u ON u.id = a.user_id
                          ORDER BY a.id DESC LIMIT 100`).all();
  res.render('admin', { title: 'Administrasjon', folders, log, smtp: mailer.configured, mailFrom: mailer.from });
});

router.post('/innstillinger', (req, res) => {
  const { db } = req.app.locals.ctx;
  const club = str(req.body.club);
  if (club) setSetting(db, 'club_name', club);
  logActivity(db, req.user.id, 'innstillinger', club);
  req.flash('ok', 'Innstillingene er lagret.');
  res.redirect('/admin');
});

const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const logoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });

router.post('/logo', logoUpload.single('logo'), verifyCsrf, (req, res) => {
  const { db, uploadDir } = req.app.locals.ctx;
  const old = getSetting(db, 'logo_file');
  if (req.body.remove === '1') {
    setSetting(db, 'logo_file', null);
  } else {
    if (!req.file || !LOGO_TYPES.includes(req.file.mimetype)) {
      req.flash('error', 'Velg et bilde i formatet PNG, JPG, WebP eller GIF.'); return res.redirect('/admin');
    }
    const name = `logo-${crypto.randomBytes(8).toString('hex')}`;
    fs.writeFileSync(path.join(uploadDir, name), req.file.buffer);
    setSetting(db, 'logo_file', name);
    setSetting(db, 'logo_mime', req.file.mimetype);
  }
  if (old) fs.rm(path.join(uploadDir, old), { force: true }, () => {});
  logActivity(db, req.user.id, 'logo-endret', null);
  req.flash('ok', req.body.remove === '1' ? 'Logoen er fjernet.' : 'Logoen er lagret.');
  res.redirect('/admin');
});

router.post('/mapper', (req, res) => {
  const { db } = req.app.locals.ctx;
  const name = str(req.body.name);
  const parentId = int(req.body.parent_id);
  if (name && !db.prepare('SELECT 1 FROM folders WHERE name = ? AND parent_id IS ?').get(name, parentId)) {
    const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM folders WHERE parent_id IS ?').get(parentId).n;
    db.prepare('INSERT INTO folders (name, parent_id, sort) VALUES (?, ?, ?)').run(name, parentId, sort);
  }
  res.redirect('/admin#mapper');
});

router.post('/mapper/:id', (req, res) => {
  const { db } = req.app.locals.ctx;
  const name = str(req.body.name);
  if (name) {
    try {
      db.prepare('UPDATE folders SET name = ?, sort = ? WHERE id = ?').run(name, int(req.body.sort) ?? 0, int(req.params.id));
    } catch { req.flash('error', 'Navnet er allerede i bruk.'); }
  }
  res.redirect('/admin#mapper');
});

router.post('/mapper/:id/slett', (req, res) => {
  const { db } = req.app.locals.ctx;
  const f = db.prepare('SELECT * FROM folders WHERE id = ?').get(int(req.params.id));
  if (f && f.key) { req.flash('error', 'Systemmapper kan ikke slettes.'); return res.redirect('/admin#mapper'); }
  if (f && db.prepare('SELECT 1 FROM folders WHERE parent_id = ?').get(f.id)) { req.flash('error', 'Mappen har undermapper. Slett dem først.'); return res.redirect('/admin#mapper'); }
  // Dokumenter i mappen blir liggende uten mappe (ON DELETE SET NULL)
  if (f) db.prepare('DELETE FROM folders WHERE id = ?').run(f.id);
  res.redirect('/admin#mapper');
});

module.exports = router;
