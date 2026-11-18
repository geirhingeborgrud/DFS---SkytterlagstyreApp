'use strict';

/** Alle mapper som flat liste i tre-rekkefølge, med depth og full sti. */
function folderTree(db) {
  const all = db.prepare('SELECT * FROM folders ORDER BY sort, name').all();
  const out = [];
  const walk = (parentId, depth, prefix) => {
    for (const f of all.filter((x) => (x.parent_id ?? null) === parentId)) {
      const pathName = prefix ? `${prefix} / ${f.name}` : f.name;
      out.push({ ...f, depth, path: pathName });
      walk(f.id, depth + 1, pathName);
    }
  };
  walk(null, 0, '');
  return out;
}

/** Stien fra rot til mappen (for brødsmuler). */
function breadcrumb(db, folderId) {
  const crumbs = [];
  let id = folderId;
  for (let i = 0; id && i < 20; i++) {
    const f = db.prepare('SELECT * FROM folders WHERE id = ?').get(id);
    if (!f) break;
    crumbs.unshift(f);
    id = f.parent_id;
  }
  return crumbs;
}

/** Id-er for mappen og alle undermapper. */
function descendantIds(db, folderId) {
  const ids = [folderId];
  for (let i = 0; i < ids.length; i++) {
    for (const c of db.prepare('SELECT id FROM folders WHERE parent_id = ?').all(ids[i])) ids.push(c.id);
  }
  return ids;
}

module.exports = { folderTree, breadcrumb, descendantIds };
