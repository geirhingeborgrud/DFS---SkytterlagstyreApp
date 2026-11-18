'use strict';
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const { tx, logActivity } = require('../db');
const { requireLogin, requireRole, verifyCsrf } = require('../auth');
const { effectiveLevel, visibleDocuments, LEVELS } = require('../permissions');
const { str, int } = require('../helpers');
const { folderTree, breadcrumb } = require('../folders');

/** Kun lokale stier som retur-adresse (hindrer åpen videresending). */
function safeReturn(v) {
  return typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') ? v : null;
}

const router = express.Router();
router.use(requireLogin);

const MAX_FILE = 25 * 1024 * 1024;
const uploaders = new Map();
function upload(req, res, next) {
  const dir = req.app.locals.ctx.uploadDir;
  if (!uploaders.has(dir)) {
    uploaders.set(dir, multer({
      storage: multer.diskStorage({
        destination: dir,
        filename: (r, file, cb) => cb(null, crypto.randomBytes(16).toString('hex')),
      }),
      limits: { fileSize: MAX_FILE, files: 1 },
      defParamCharset: 'utf8',
    }));
  }
  uploaders.get(dir).single('file')(req, res, (err) => {
    if (err) return next(err);
    // CSRF-sjekk etter at multipart er lest; fjern fil hvis den feiler
    let ok = false;
    verifyCsrf(req, res, () => { ok = true; });
    if (ok) return next();
    if (req.file) fs.rm(req.file.path, { force: true }, () => {});
  });
}

function loadDoc(req, res, required) {
  const { db } = req.app.locals.ctx;
  const doc = db.prepare(`SELECT d.*, f.name AS folder_name, u.name AS owner_name
                          FROM documents d LEFT JOIN folders f ON f.id = d.folder_id
                          LEFT JOIN users u ON u.id = d.owner_id WHERE d.id = ?`).get(int(req.params.id));
  const level = effectiveLevel(db, req.user, doc);
  if (!doc || LEVELS[level] < LEVELS.read) {
    res.status(404).render('error', { title: 'Ikke funnet', message: 'Dokumentet finnes ikke, eller du har ikke tilgang.' });
    return null;
  }
  if (LEVELS[level] < LEVELS[required]) {
    res.status(403).render('error', { title: 'Ingen tilgang', message: 'Du har ikke tilstrekkelig tilgang til dette dokumentet.' });
    return null;
  }
  return { ...doc, level };
}

function addVersion(db, docId, file, userId, note) {
  const next = db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM document_versions WHERE document_id = ?').get(docId).v;
  const r = db.prepare(`INSERT INTO document_versions (document_id, version, stored_name, original_name, mime, size, note, uploaded_by)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(docId, next, file.filename, file.originalname, file.mimetype || null, file.size, note, userId);
  db.prepare("UPDATE documents SET current_version_id = ?, updated_at = datetime('now') WHERE id = ?").run(r.lastInsertRowid, docId);
  return next;
}

const ACCESS = ['none', 'read', 'edit'];

// ---- Liste ----------------------------------------------------------------

router.get('/', (req, res) => {
  const { db } = req.app.locals.ctx;
  const folderId = int(req.query.mappe);
  const q = str(req.query.q);
  const tree = folderTree(db);
  const folder = folderId ? db.prepare('SELECT * FROM folders WHERE id = ?').get(folderId) : null;
  const subfolders = db.prepare('SELECT * FROM folders WHERE parent_id IS ? ORDER BY sort, name').all(folder ? folder.id : null);
  // Uten mappe og uten søk: vis sist endrede dokumenter
  let docs = visibleDocuments(db, req.user, { folderId: folder ? folder.id : null, q });
  if (!folder && !q) docs = docs.slice(0, 25);
  const counts = {};
  for (const d of visibleDocuments(db, req.user)) counts[d.folder_id] = (counts[d.folder_id] || 0) + 1;
  res.render('documents/list', { title: folder ? folder.name : 'Dokumenter', tree, folder, subfolders, docs, folderId: folder && folder.id, q, counts, crumbs: folder ? breadcrumb(db, folder.id) : [] });
});

// ---- Nytt dokument ----------------------------------------------------------

router.get('/ny', requireRole('styre'), (req, res) => {
  const { db } = req.app.locals.ctx;
  res.render('documents/new', { title: 'Last opp dokument', folders: folderTree(db), folderId: int(req.query.mappe), retur: safeReturn(req.query.retur) });
});

router.post('/ny', requireRole('styre'), upload, (req, res) => {
  const { db } = req.app.locals.ctx;
  if (!req.file) { req.flash('error', 'Velg en fil å laste opp.'); return res.redirect('/dokumenter/ny'); }
  const title = str(req.body.title) || path.parse(req.file.originalname).name;
  const access = ACCESS.includes(req.body.default_access) ? req.body.default_access : 'read';
  const folder = int(req.body.folder_id);
  const id = tx(db, () => {
    const r = db.prepare('INSERT INTO documents (title, description, folder_id, owner_id, default_access) VALUES (?, ?, ?, ?, ?)')
      .run(title, str(req.body.description), folder, req.user.id, access);
    const docId = Number(r.lastInsertRowid);
    addVersion(db, docId, req.file, req.user.id, null);
    return docId;
  });
  logActivity(db, req.user.id, 'dokument-lastet-opp', title);
  const retur = safeReturn(req.body.retur);
  req.flash('ok', retur ? `«${title}» er lastet opp.` : 'Dokumentet er lastet opp. Du er eier og kan justere tilganger under.');
  res.redirect(retur || `/dokumenter/${id}`);
});

// ---- Vis --------------------------------------------------------------------

router.get('/:id', (req, res) => {
  const { db } = req.app.locals.ctx;
  const doc = loadDoc(req, res, 'read');
  if (!doc) return;
  const versions = db.prepare(`SELECT v.*, u.name AS uploader FROM document_versions v
                               LEFT JOIN users u ON u.id = v.uploaded_by
                               WHERE v.document_id = ? ORDER BY v.version DESC`).all(doc.id);
  const folders = folderTree(db);
  const meetings = db.prepare(`SELECT m.* FROM meetings m JOIN meeting_documents md ON md.meeting_id = m.id
                               WHERE md.document_id = ? ORDER BY m.starts_at DESC`).all(doc.id);
  let users = [];
  if (doc.level === 'owner') {
    users = db.prepare(`SELECT u.id, u.name, u.role, p.level AS explicit
                        FROM users u LEFT JOIN document_permissions p ON p.user_id = u.id AND p.document_id = ?
                        WHERE u.active = 1 ORDER BY u.name`).all(doc.id)
      .map((u) => ({ ...u, effective: effectiveLevel(db, { ...u, active: 1 }, doc) }));
  }
  res.render('documents/show', { title: doc.title, doc, versions, folders, users, meetings, crumbs: doc.folder_id ? breadcrumb(db, doc.folder_id) : [] });
});

router.get('/:id/last-ned', (req, res) => {
  const { db, uploadDir } = req.app.locals.ctx;
  const doc = loadDoc(req, res, 'read');
  if (!doc) return;
  const versionNo = int(req.query.versjon);
  const v = versionNo
    ? db.prepare('SELECT * FROM document_versions WHERE document_id = ? AND version = ?').get(doc.id, versionNo)
    : db.prepare('SELECT * FROM document_versions WHERE id = ?').get(doc.current_version_id);
  if (!v) return res.status(404).render('error', { title: 'Ikke funnet', message: 'Versjonen finnes ikke.' });
  const inline = req.query.vis === '1' && /^(application\/pdf|image\/(png|jpeg|gif|webp)|text\/plain)$/.test(v.mime || '');
  res.set('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  const file = path.join(uploadDir, v.stored_name);
  const headers = { 'Content-Type': v.mime || 'application/octet-stream' };
  if (inline) {
    headers['Content-Disposition'] = `inline; filename*=UTF-8''${encodeURIComponent(v.original_name)}`;
    return res.sendFile(file, { headers });
  }
  res.download(file, v.original_name, { headers });
});

// ---- Rediger ----------------------------------------------------------------

router.post('/:id/ny-versjon', upload, (req, res) => {
  const { db } = req.app.locals.ctx;
  const doc = loadDoc(req, res, 'edit');
  if (!doc) { if (req.file) fs.rm(req.file.path, { force: true }, () => {}); return; }
  if (!req.file) { req.flash('error', 'Velg en fil.'); return res.redirect(`/dokumenter/${doc.id}`); }
  const v = tx(db, () => addVersion(db, doc.id, req.file, req.user.id, str(req.body.note)));
  logActivity(db, req.user.id, 'dokument-ny-versjon', `${doc.title} v${v}`);
  req.flash('ok', `Versjon ${v} er lastet opp.`);
  res.redirect(`/dokumenter/${doc.id}`);
});

router.post('/:id/rediger', (req, res) => {
  const { db } = req.app.locals.ctx;
  const doc = loadDoc(req, res, 'edit');
  if (!doc) return;
  const title = str(req.body.title) || doc.title;
  db.prepare("UPDATE documents SET title = ?, description = ?, folder_id = ?, updated_at = datetime('now') WHERE id = ?")
    .run(title, str(req.body.description), int(req.body.folder_id), doc.id);
  req.flash('ok', 'Dokumentet er oppdatert.');
  res.redirect(`/dokumenter/${doc.id}`);
});

router.post('/:id/tilgang', (req, res) => {
  const { db } = req.app.locals.ctx;
  const doc = loadDoc(req, res, 'owner');
  if (!doc) return;
  const access = ACCESS.includes(req.body.default_access) ? req.body.default_access : doc.default_access;
  const users = db.prepare('SELECT id FROM users WHERE active = 1').all();
  tx(db, () => {
    db.prepare('UPDATE documents SET default_access = ? WHERE id = ?').run(access, doc.id);
    for (const u of users) {
      if (u.id === doc.owner_id) continue;
      const lvl = req.body[`perm_${u.id}`];
      if (lvl === undefined) continue;
      if (['read', 'edit', 'owner'].includes(lvl)) {
        db.prepare(`INSERT INTO document_permissions (document_id, user_id, level) VALUES (?, ?, ?)
                    ON CONFLICT(document_id, user_id) DO UPDATE SET level = excluded.level`).run(doc.id, u.id, lvl);
      } else {
        db.prepare('DELETE FROM document_permissions WHERE document_id = ? AND user_id = ?').run(doc.id, u.id);
      }
    }
  });
  logActivity(db, req.user.id, 'dokument-tilgang', doc.title);
  req.flash('ok', 'Tilgangene er lagret.');
  res.redirect(`/dokumenter/${doc.id}`);
});

router.post('/:id/eier', (req, res) => {
  const { db } = req.app.locals.ctx;
  const doc = loadDoc(req, res, 'owner');
  if (!doc) return;
  const newOwner = db.prepare('SELECT * FROM users WHERE id = ? AND active = 1').get(int(req.body.owner_id));
  if (!newOwner) { req.flash('error', 'Velg en gyldig bruker.'); return res.redirect(`/dokumenter/${doc.id}`); }
  tx(db, () => {
    db.prepare('UPDATE documents SET owner_id = ? WHERE id = ?').run(newOwner.id, doc.id);
    db.prepare('DELETE FROM document_permissions WHERE document_id = ? AND user_id = ?').run(doc.id, newOwner.id);
    // Tidligere eier beholder redigeringstilgang
    db.prepare(`INSERT INTO document_permissions (document_id, user_id, level) VALUES (?, ?, 'edit')
                ON CONFLICT(document_id, user_id) DO NOTHING`).run(doc.id, doc.owner_id);
  });
  logActivity(db, req.user.id, 'dokument-eierskap', `${doc.title} → ${newOwner.name}`);
  req.flash('ok', `Eierskapet er overført til ${newOwner.name}.`);
  res.redirect(`/dokumenter/${doc.id}`);
});

router.post('/:id/slett', (req, res) => {
  const { db, uploadDir } = req.app.locals.ctx;
  const doc = loadDoc(req, res, 'owner');
  if (!doc) return;
  const files = db.prepare('SELECT stored_name FROM document_versions WHERE document_id = ?').all(doc.id);
  db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
  for (const f of files) fs.rm(path.join(uploadDir, f.stored_name), { force: true }, () => {});
  logActivity(db, req.user.id, 'dokument-slettet', doc.title);
  req.flash('ok', `«${doc.title}» er slettet.`);
  res.redirect('/dokumenter');
});

module.exports = router;
