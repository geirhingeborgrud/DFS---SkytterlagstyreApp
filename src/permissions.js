'use strict';
/**
 * Tilgangsmodell for dokumenter
 *
 *   ingen < les < rediger < eier
 *
 * Effektivt nivå for en bruker på et dokument er det høyeste av:
 *  - 'owner' hvis brukeren er administrator eller dokumentets eier
 *  - eksplisitt tildelt nivå i document_permissions
 *  - dokumentets standardtilgang ("hele styret") – gjelder kun brukere med rolle admin/styre,
 *    ikke brukere med ren lesetilgang (f.eks. revisor/valgkomité), som må gis tilgang eksplisitt.
 *
 *  les     : se og laste ned dokumentet, legge det ved i e-post
 *  rediger : i tillegg laste opp nye versjoner og endre tittel/beskrivelse/mappe
 *  eier    : i tillegg styre tilganger, overføre eierskap og slette dokumentet
 */

const LEVELS = { none: 0, read: 1, edit: 2, owner: 3 };
const LEVEL_LABELS = { none: 'Ingen tilgang', read: 'Les', edit: 'Rediger', owner: 'Eier' };

function maxLevel(a, b) { return LEVELS[a] >= LEVELS[b] ? a : b; }

function effectiveLevel(db, user, doc) {
  if (!user || !doc) return 'none';
  if (!user.active) return 'none';
  if (user.role === 'admin' || doc.owner_id === user.id) return 'owner';
  let level = 'none';
  if (user.role === 'styre') level = maxLevel(level, doc.default_access || 'none');
  const perm = db.prepare('SELECT level FROM document_permissions WHERE document_id = ? AND user_id = ?').get(doc.id, user.id);
  if (perm) level = maxLevel(level, perm.level);
  return level;
}

function hasLevel(db, user, doc, required) {
  return LEVELS[effectiveLevel(db, user, doc)] >= LEVELS[required];
}

/** Alle dokumenter brukeren minst kan lese, med effektivt nivå satt på hvert objekt. */
function visibleDocuments(db, user, { folderId, q } = {}) {
  let sql = `SELECT d.*, f.name AS folder_name, u.name AS owner_name,
                    v.original_name, v.size, v.mime, v.version, v.uploaded_at
             FROM documents d
             LEFT JOIN folders f ON f.id = d.folder_id
             LEFT JOIN users u ON u.id = d.owner_id
             LEFT JOIN document_versions v ON v.id = d.current_version_id
             WHERE 1=1`;
  const params = [];
  if (folderId) { sql += ' AND d.folder_id = ?'; params.push(folderId); }
  if (q) {
    sql += ' AND (d.title LIKE ? OR d.description LIKE ? OR v.original_name LIKE ?)';
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  sql += ' ORDER BY d.updated_at DESC';
  const docs = db.prepare(sql).all(...params);
  const out = [];
  for (const d of docs) {
    const level = effectiveLevel(db, user, d);
    if (LEVELS[level] >= LEVELS.read) out.push({ ...d, level });
  }
  return out;
}

module.exports = { LEVELS, LEVEL_LABELS, effectiveLevel, hasLevel, visibleDocuments };
