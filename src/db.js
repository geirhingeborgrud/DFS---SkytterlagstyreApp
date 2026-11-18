'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS members (
  id          INTEGER PRIMARY KEY,
  shooter_id  TEXT UNIQUE,              -- skytter-ID / skytternummer fra MittDFS
  first_name  TEXT NOT NULL,
  last_name   TEXT NOT NULL,
  birth_date  TEXT,
  email       TEXT,
  phone       TEXT,
  address     TEXT,
  postal_code TEXT,
  city        TEXT,
  class       TEXT,
  active      INTEGER NOT NULL DEFAULT 1,
  notes       TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS member_roles (
  member_id INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  role      TEXT NOT NULL,
  PRIMARY KEY (member_id, role)
);

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY,
  name           TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash  TEXT,
  role           TEXT NOT NULL DEFAULT 'styre' CHECK (role IN ('admin','styre','les')),
  phone          TEXT,
  member_id      INTEGER REFERENCES members(id) ON DELETE SET NULL,
  last_seen      INTEGER,
  active         INTEGER NOT NULL DEFAULT 1,
  invite_token   TEXT,
  invite_expires TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS sessions (
  sid     TEXT PRIMARY KEY,
  data    TEXT NOT NULL,
  expires INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS folders (
  id        INTEGER PRIMARY KEY,
  parent_id INTEGER REFERENCES folders(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  key       TEXT UNIQUE,                -- faste systemmapper, f.eks. 'styremoter'
  sort      INTEGER NOT NULL DEFAULT 0,
  UNIQUE (parent_id, name)
);

CREATE TABLE IF NOT EXISTS documents (
  id                 INTEGER PRIMARY KEY,
  title              TEXT NOT NULL,
  description        TEXT,
  folder_id          INTEGER REFERENCES folders(id) ON DELETE SET NULL,
  owner_id           INTEGER NOT NULL REFERENCES users(id),
  default_access     TEXT NOT NULL DEFAULT 'read' CHECK (default_access IN ('none','read','edit')),
  current_version_id INTEGER,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS document_versions (
  id            INTEGER PRIMARY KEY,
  document_id   INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  stored_name   TEXT NOT NULL,
  original_name TEXT NOT NULL,
  mime          TEXT,
  size          INTEGER NOT NULL,
  note          TEXT,
  uploaded_by   INTEGER REFERENCES users(id),
  uploaded_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS document_permissions (
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level       TEXT NOT NULL CHECK (level IN ('read','edit','owner')),
  PRIMARY KEY (document_id, user_id)
);

CREATE TABLE IF NOT EXISTS meetings (
  id         INTEGER PRIMARY KEY,
  type       TEXT NOT NULL DEFAULT 'styremote' CHECK (type IN ('styremote','arsmote')),
  title      TEXT NOT NULL,
  starts_at  TEXT NOT NULL,
  ends_at    TEXT,
  location   TEXT,
  meet_url   TEXT,
  folder_id  INTEGER REFERENCES folders(id) ON DELETE SET NULL,
  status     TEXT NOT NULL DEFAULT 'planlagt' CHECK (status IN ('planlagt','gjennomfort','avlyst')),
  notes      TEXT,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meeting_items (
  id          INTEGER PRIMARY KEY,
  meeting_id  INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  number      INTEGER NOT NULL,
  year        INTEGER NOT NULL,
  title       TEXT NOT NULL,
  description TEXT,
  decision    TEXT,
  sort        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS meeting_attendees (
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  member_id  INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  PRIMARY KEY (meeting_id, member_id)
);

CREATE TABLE IF NOT EXISTS meeting_documents (
  meeting_id  INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  PRIMARY KEY (meeting_id, document_id)
);

CREATE TABLE IF NOT EXISTS annual_items (
  id          INTEGER PRIMARY KEY,
  month       INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
  day         INTEGER CHECK (day BETWEEN 1 AND 31),
  title       TEXT NOT NULL,
  description TEXT,
  responsible TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id             INTEGER PRIMARY KEY,
  title          TEXT NOT NULL,
  description    TEXT,
  due_date       TEXT,
  assignee_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  status         TEXT NOT NULL DEFAULT 'apen' CHECK (status IN ('apen','pagar','ferdig')),
  annual_item_id INTEGER REFERENCES annual_items(id) ON DELETE SET NULL,
  year           INTEGER,
  meeting_id     INTEGER REFERENCES meetings(id) ON DELETE SET NULL,
  created_by     INTEGER REFERENCES users(id),
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS emails (
  id           INTEGER PRIMARY KEY,
  sender_id    INTEGER REFERENCES users(id),
  subject      TEXT NOT NULL,
  body         TEXT NOT NULL,
  recipients   TEXT NOT NULL,
  document_ids TEXT NOT NULL DEFAULT '[]',
  mode         TEXT NOT NULL DEFAULT 'vedlegg',
  status       TEXT NOT NULL,
  error        TEXT,
  sent_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Våpen og våpendeler
CREATE TABLE IF NOT EXISTS weapons (
  id               INTEGER PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('rifle','del')),
  part_type        TEXT,               -- for våpendeler: pipe, sluttstykke, kasse …
  manufacturer     TEXT,
  model            TEXT,
  caliber          TEXT,
  serial_number    TEXT,
  card_number      TEXT,               -- våpenkortnummer
  card_holder      TEXT,               -- registrert innehaver iht. våpenkort
  card_document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  storage          TEXT,               -- oppbevaringssted
  status           TEXT NOT NULL DEFAULT 'aktiv' CHECK (status IN ('aktiv','utlant','service','avhendet')),
  acquired_date    TEXT,
  notes            TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ammo_types (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL,
  caliber  TEXT,
  unit     TEXT NOT NULL DEFAULT 'skudd',
  price    REAL,                         -- standard salgspris per enhet
  min_stock INTEGER,
  active   INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS ammo_transactions (
  id           INTEGER PRIMARY KEY,
  ammo_type_id INTEGER NOT NULL REFERENCES ammo_types(id),
  kind         TEXT NOT NULL CHECK (kind IN ('kjop','salg','justering')),
  quantity     INTEGER NOT NULL,         -- positivt tall; fortegn utledes av kind (justering kan være negativ)
  unit_price   REAL,
  date         TEXT NOT NULL,
  member_id    INTEGER REFERENCES members(id) ON DELETE SET NULL,
  counterparty TEXT,                     -- leverandør, eller kjøper som ikke er medlem
  paid         INTEGER NOT NULL DEFAULT 0,
  note         TEXT,
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS loans (
  id          INTEGER PRIMARY KEY,
  weapon_id   INTEGER NOT NULL REFERENCES weapons(id),
  member_id   INTEGER NOT NULL REFERENCES members(id),
  from_date   TEXT NOT NULL,
  to_date     TEXT,
  purpose     TEXT,
  text        TEXT NOT NULL,             -- ferdig utfylt erklæring (kan redigeres)
  status      TEXT NOT NULL DEFAULT 'aktiv' CHECK (status IN ('aktiv','returnert')),
  returned_at TEXT,
  emailed_at  TEXT,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Treninger og stevner
CREATE TABLE IF NOT EXISTS trainings (
  id          INTEGER PRIMARY KEY,
  title       TEXT NOT NULL,
  date        TEXT NOT NULL,
  start_time  TEXT,
  end_time    TEXT,
  location    TEXT,
  discipline  TEXT,
  leader      TEXT,                      -- skyteleder
  notes       TEXT,
  series      TEXT                       -- felles id for gjentakende treninger
);

CREATE TABLE IF NOT EXISTS competitions (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  date        TEXT NOT NULL,
  end_date    TEXT,
  location    TEXT,
  organizer   TEXT,
  own_event   INTEGER NOT NULL DEFAULT 0,
  signup_deadline TEXT,
  url         TEXT,
  notes       TEXT
);

CREATE TABLE IF NOT EXISTS competition_participants (
  competition_id INTEGER NOT NULL REFERENCES competitions(id) ON DELETE CASCADE,
  member_id      INTEGER NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  class          TEXT,
  result         TEXT,
  PRIMARY KEY (competition_id, member_id)
);

-- Stillingsinstrukser: sjekklister per verv
CREATE TABLE IF NOT EXISTS checklists (
  id    INTEGER PRIMARY KEY,
  role  TEXT NOT NULL,
  title TEXT NOT NULL,
  sort  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS checklist_items (
  id           INTEGER PRIMARY KEY,
  checklist_id INTEGER NOT NULL REFERENCES checklists(id) ON DELETE CASCADE,
  text         TEXT NOT NULL,
  sort         INTEGER NOT NULL DEFAULT 0,
  done_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  done_at      TEXT
);

CREATE TABLE IF NOT EXISTS activity_log (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action     TEXT NOT NULL,
  details    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_docs_folder ON documents(folder_id);
CREATE INDEX IF NOT EXISTS idx_versions_doc ON document_versions(document_id);
CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_items_meeting ON meeting_items(meeting_id);
`;

// [key, navn, foreldernøkkel]. Systemmapper med nøkkel brukes av appen og kan ikke slettes.
const DEFAULT_FOLDERS = [
  ['styremoter', 'Styremøter', null],
  ['storre-saker', 'Større saker', null],
  ['referat-eksterne', 'Møtereferat, eksterne', null],
  ['arsmoter', 'Årsmøter', null],
  ['innkallinger', 'Innkallinger', 'arsmoter'],
  ['arsrapport', 'Årsrapport', null],
  ['arsmeldinger', 'Årsmeldinger', null],
  ['vapenkort', 'Våpenkort', null],
  ['utlan', 'Utlånserklæringer', null],
  ['stillingsinstrukser', 'Stillingsinstrukser', null],
  ['okonomi', 'Økonomi', null],
  ['lover', 'Lover og vedtekter', null],
  ['annet', 'Annet', null],
];

// Forslag til årshjul. Frister varierer mellom lag/kretser og over tid –
// styret bør kontrollere mot lagets lov, kretsens og DFS' gjeldende frister.
const DEFAULT_ANNUAL = [
  [1, null, 'Forberede årsmøtet', 'Årsberetning, regnskap, budsjett og innkomne saker. Kontroller frist for innkalling i lagets lov.', 'Leder / sekretær'],
  [1, null, 'Avslutte regnskapet for fjoråret', 'Klargjøre regnskap for revisjon.', 'Kasserer'],
  [1, null, 'Medlemskontingent', 'Sende ut kontingent og oppdatere medlemsregisteret.', 'Kasserer'],
  [2, null, 'Revisjon av regnskap', 'Revisor gjennomgår regnskapet før årsmøtet.', 'Kasserer'],
  [2, null, 'Årsmøte', 'Gjennomføre årsmøtet etter lagets lov. Protokoll signeres og arkiveres.', 'Leder'],
  [3, null, 'Konstituering av nytt styre', 'Første styremøte: fordele roller, signaturrett og tilganger i appen.', 'Leder'],
  [3, null, 'Oppdatere Brønnøysundregistrene', 'Melde endringer i styre og signaturrett etter årsmøtet.', 'Sekretær'],
  [3, null, 'Rapportere til krets/DFS', 'Årsrapport, tillitsvalgte og medlemstall iht. frister fra krets/DFS.', 'Sekretær'],
  [4, null, 'Banedugnad og klargjøring av skytebanen', 'Klargjøre skiver, standplass og anlegg for utendørssesongen.', 'Baneansvarlig'],
  [4, null, 'Sikkerhetsgjennomgang av skytebanen', 'Gå gjennom baneinstruks, sikkerhetsrutiner og skyteledere.', 'Baneansvarlig'],
  [5, null, 'Sesongstart utendørs', 'Terminliste, treningstider og skyteledere publiseres.', 'Leder'],
  [6, null, 'Påmelding til stevner', 'Følge opp påmelding til kretsstevner og Landsskytterstevnet.', 'Stevneansvarlig'],
  [8, null, 'Momskompensasjon', 'Levere grunnlag for momskompensasjon iht. frist fra DFS/krets.', 'Kasserer'],
  [9, null, 'Søknader om tilskudd', 'Kommunale/regionale tilskudd, Grasrotandelen m.m.', 'Kasserer'],
  [10, null, 'Innendørssesong', 'Planlegge innendørssesongen og ungdomsarbeid.', 'Leder'],
  [10, null, 'Valgkomiteen starter arbeidet', 'Valgkomiteen kartlegger hvem som er på valg.', 'Valgkomité'],
  [11, null, 'Budsjett og aktivitetsplan for neste år', 'Utkast til budsjett og plan til behandling i styret.', 'Kasserer / leder'],
  [12, null, 'Ferdighetsmerker og resultater', 'Registrere og rapportere resultater/ferdighetsmerker for sesongen.', 'Sekretær'],
  [12, null, 'Årsavslutning', 'Premieutdeling og oppsummering av året.', 'Styret'],
];

// Standardmal for utlånserklæring. Laget bør erstatte denne med gjeldende mal fra
// MittDFS (Administrasjon → Innstillinger → Utlånsmal), slik at ordlyden er oppdatert.
const DEFAULT_LOAN_TEMPLATE = `ERKLÆRING OM UTLÅN AV VÅPEN

Utlåner: {lag}

Låntaker
Navn: {navn}
Fødselsdato: {fodselsdato}
Skytter-ID: {skytterid}
Adresse: {adresse}

Våpen/våpendel
Type: {vapentype}
Fabrikat/modell: {fabrikat}
Kaliber: {kaliber}
Serienummer: {serienummer}
Våpenkortnummer: {vapenkort}

Utlånsperiode: {fra} – {til}
Formål: {formal}

Låntaker bekrefter å ha lest og forstått gjeldende regler for oppbevaring, transport og bruk av
skytevåpen, og at våpenet kun skal brukes til det formålet som er oppgitt. Våpenet skal oppbevares
forsvarlig og leveres tilbake til utlåner innen utlånsperiodens slutt.

Sted/dato: ______________________ {dato}

______________________________          ______________________________
Utlåner ({lag})                          Låntaker ({navn})
`;

function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  seed(db);
  return db;
}

function seed(db) {
  const hasFolders = db.prepare('SELECT COUNT(*) AS n FROM folders').get().n;
  if (!hasFolders) {
    const ins = db.prepare('INSERT INTO folders (key, name, parent_id, sort) VALUES (?, ?, ?, ?)');
    DEFAULT_FOLDERS.forEach(([key, name, parent], i) => {
      const parentId = parent ? db.prepare('SELECT id FROM folders WHERE key = ?').get(parent).id : null;
      ins.run(key, name, parentId, i);
    });
  }
  if (!db.prepare('SELECT 1 FROM ammo_types LIMIT 1').get()) {
    const ins = db.prepare('INSERT INTO ammo_types (name, caliber, unit) VALUES (?, ?, ?)');
    ins.run('6,5×55 (DFS-patron)', '6,5×55', 'skudd');
    ins.run('.22 LR', '.22 LR', 'skudd');
  }
  if (getSetting(db, 'loan_template') == null) setSetting(db, 'loan_template', DEFAULT_LOAN_TEMPLATE);
  const hasAnnual = db.prepare('SELECT COUNT(*) AS n FROM annual_items').get().n;
  if (!hasAnnual) {
    const ins = db.prepare('INSERT INTO annual_items (month, day, title, description, responsible) VALUES (?, ?, ?, ?, ?)');
    for (const row of DEFAULT_ANNUAL) ins.run(...row);
  }
}

/** Kjør fn inne i en transaksjon. */
function tx(db, fn) {
  db.exec('BEGIN');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

function getSetting(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function setSetting(db, key, value) {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value == null ? null : String(value));
}

function logActivity(db, userId, action, details) {
  db.prepare('INSERT INTO activity_log (user_id, action, details) VALUES (?, ?, ?)')
    .run(userId ?? null, action, details ?? null);
}

function folderIdByKey(db, key) {
  const f = db.prepare('SELECT id FROM folders WHERE key = ?').get(key);
  return f ? f.id : null;
}

/** Finn eller opprett undermappe med gitt navn under systemmappen parentKey. */
function ensureSubfolder(db, parentKey, name) {
  const parentId = folderIdByKey(db, parentKey);
  const existing = db.prepare('SELECT id FROM folders WHERE parent_id IS ? AND name = ?').get(parentId, name);
  if (existing) return existing.id;
  const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM folders WHERE parent_id IS ?').get(parentId).n;
  return Number(db.prepare('INSERT INTO folders (parent_id, name, sort) VALUES (?, ?, ?)').run(parentId, name, sort).lastInsertRowid);
}

module.exports = { openDb, tx, getSetting, setSetting, logActivity, folderIdByKey, ensureSubfolder, DEFAULT_LOAN_TEMPLATE };
