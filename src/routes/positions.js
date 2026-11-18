'use strict';
const express = require('express');
const { tx, logActivity, ensureSubfolder } = require('../db');
const { requireLogin, requireRole } = require('../auth');
const { hasLevel } = require('../permissions');
const { str, int, BOARD_ROLES, fullName } = require('../helpers');

/**
 * Stillingsinstrukser: én side per verv med
 *  - dokumenter (egen undermappe under «Stillingsinstrukser»)
 *  - sjekklister som kan krysses av og nullstilles (f.eks. ved ny sesong / nytt styre)
 */
const router = express.Router();
router.use(requireLogin);

function loadRole(req, res) {
  const role = req.params.role;
  if (!BOARD_ROLES[role]) { res.status(404).render('error', { title: 'Ikke funnet', message: 'Vervet finnes ikke.' }); return null; }
  return role;
}

/** Medlemmet med vervet kan krysse av i egne sjekklister; styret kan redigere alt. */
function canTick(req, role) {
  return req.user.role === 'admin' || req.user.role === 'styre' || (req.user.boardRoles || []).includes(role);
}

router.get('/', (req, res) => {
  const { db } = req.app.locals.ctx;
  const holders = db.prepare(`SELECT r.role, m.first_name, m.last_name FROM member_roles r JOIN members m ON m.id = r.member_id WHERE m.active = 1`).all();
  const counts = db.prepare(`SELECT c.role, COUNT(i.id) AS total, SUM(i.done_at IS NOT NULL) AS done
                             FROM checklists c LEFT JOIN checklist_items i ON i.checklist_id = c.id GROUP BY c.role`).all();
  const docCounts = db.prepare(`SELECT f.name, COUNT(d.id) AS n FROM folders f JOIN folders p ON p.id = f.parent_id AND p.key = 'stillingsinstrukser'
                                LEFT JOIN documents d ON d.folder_id = f.id GROUP BY f.id`).all();
  const roles = Object.entries(BOARD_ROLES).map(([key, label]) => ({
    key, label,
    holders: holders.filter((h) => h.role === key).map(fullName),
    checklist: counts.find((c) => c.role === key) || { total: 0, done: 0 },
    docs: (docCounts.find((d) => d.name === label) || { n: 0 }).n,
  }));
  res.render('positions/list', { title: 'Stillingsinstrukser', roles });
});

router.get('/:role', (req, res) => {
  const { db } = req.app.locals.ctx;
  const role = loadRole(req, res);
  if (!role) return;
  const folderId = ensureSubfolder(db, 'stillingsinstrukser', BOARD_ROLES[role]);
  const docs = db.prepare('SELECT * FROM documents WHERE folder_id = ? ORDER BY title').all(folderId).filter((d) => hasLevel(db, req.user, d, 'read'));
  const lists = db.prepare('SELECT * FROM checklists WHERE role = ? ORDER BY sort, id').all(role).map((c) => ({
    ...c,
    items: db.prepare(`SELECT i.*, u.name AS done_by_name FROM checklist_items i LEFT JOIN users u ON u.id = i.done_by
                       WHERE i.checklist_id = ? ORDER BY i.sort, i.id`).all(c.id),
  }));
  const holders = db.prepare(`SELECT m.* FROM member_roles r JOIN members m ON m.id = r.member_id WHERE r.role = ? AND m.active = 1`).all(role);
  res.render('positions/show', { title: BOARD_ROLES[role], role, label: BOARD_ROLES[role], folderId, docs, lists, holders, canTick: canTick(req, role) });
});

router.post('/:role/sjekklister', requireRole('styre'), (req, res) => {
  const { db } = req.app.locals.ctx;
  const role = loadRole(req, res);
  if (!role) return;
  const title = str(req.body.title);
  if (!title) { req.flash('error', 'Gi sjekklisten et navn.'); return res.redirect(`/stillinger/${role}`); }
  tx(db, () => {
    const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM checklists WHERE role = ?').get(role).n;
    const r = db.prepare('INSERT INTO checklists (role, title, sort) VALUES (?, ?, ?)').run(role, title, sort);
    // Punkter kan limes inn, ett per linje
    const lines = String(req.body.items || '').split(/\r?\n/).map((l) => l.replace(/^\s*[-*•]\s*/, '').trim()).filter(Boolean);
    lines.forEach((text, i) => db.prepare('INSERT INTO checklist_items (checklist_id, text, sort) VALUES (?, ?, ?)').run(r.lastInsertRowid, text, i));
  });
  res.redirect(`/stillinger/${role}`);
});

function loadList(db, role, id) {
  return db.prepare('SELECT * FROM checklists WHERE id = ? AND role = ?').get(id, role);
}

router.post('/:role/sjekklister/:id/punkt', requireRole('styre'), (req, res) => {
  const { db } = req.app.locals.ctx;
  const role = loadRole(req, res);
  if (!role) return;
  const list = loadList(db, role, int(req.params.id));
  const text = str(req.body.text);
  if (list && text) {
    const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM checklist_items WHERE checklist_id = ?').get(list.id).n;
    db.prepare('INSERT INTO checklist_items (checklist_id, text, sort) VALUES (?, ?, ?)').run(list.id, text, sort);
  }
  res.redirect(`/stillinger/${role}#liste-${list ? list.id : ''}`);
});

router.post('/:role/punkt/:itemId/kryss', (req, res) => {
  const { db } = req.app.locals.ctx;
  const role = loadRole(req, res);
  if (!role) return;
  if (!canTick(req, role)) return res.status(403).render('error', { title: 'Ingen tilgang', message: 'Du kan ikke krysse av i denne sjekklisten.' });
  const item = db.prepare(`SELECT i.* FROM checklist_items i JOIN checklists c ON c.id = i.checklist_id WHERE i.id = ? AND c.role = ?`).get(int(req.params.itemId), role);
  if (item) {
    if (item.done_at) db.prepare('UPDATE checklist_items SET done_at = NULL, done_by = NULL WHERE id = ?').run(item.id);
    else db.prepare("UPDATE checklist_items SET done_at = datetime('now'), done_by = ? WHERE id = ?").run(req.user.id, item.id);
  }
  res.redirect(`/stillinger/${role}#punkt-${req.params.itemId}`);
});

router.post('/:role/punkt/:itemId/slett', requireRole('styre'), (req, res) => {
  const { db } = req.app.locals.ctx;
  const role = loadRole(req, res);
  if (!role) return;
  db.prepare(`DELETE FROM checklist_items WHERE id = ? AND checklist_id IN (SELECT id FROM checklists WHERE role = ?)`).run(int(req.params.itemId), role);
  res.redirect(`/stillinger/${role}`);
});

router.post('/:role/sjekklister/:id/nullstill', requireRole('styre'), (req, res) => {
  const { db } = req.app.locals.ctx;
  const role = loadRole(req, res);
  if (!role) return;
  const list = loadList(db, role, int(req.params.id));
  if (list) {
    db.prepare('UPDATE checklist_items SET done_at = NULL, done_by = NULL WHERE checklist_id = ?').run(list.id);
    logActivity(db, req.user.id, 'sjekkliste-nullstilt', `${BOARD_ROLES[role]}: ${list.title}`);
  }
  res.redirect(`/stillinger/${role}`);
});

router.post('/:role/sjekklister/:id/slett', requireRole('styre'), (req, res) => {
  const { db } = req.app.locals.ctx;
  const role = loadRole(req, res);
  if (!role) return;
  db.prepare('DELETE FROM checklists WHERE id = ? AND role = ?').run(int(req.params.id), role);
  res.redirect(`/stillinger/${role}`);
});

module.exports = router;
