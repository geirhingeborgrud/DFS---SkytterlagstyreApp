'use strict';
const express = require('express');
const { tx, logActivity, ensureSubfolder } = require('../db');
const { requireLogin, requireRole } = require('../auth');
const { hasLevel, visibleDocuments } = require('../permissions');
const { str, int, today, asArray, BOARD_CORE, caseNo } = require('../helpers');
const { googleCalendarUrl, meetingIcs, attendeeList } = require('../calendar');
const { baseUrl } = require('./auth');

const STATUSES = ['planlagt', 'gjennomfort', 'avlyst'];
const MEET_RE = /^https:\/\/meet\.google\.com\/[a-z0-9-]+(\?.*)?$/i;

/**
 * Møtemodul. Brukes både for styremøter (/moter) og årsmøter (/arsmoter).
 * Hvert møte får en egen dokumentmappe: «Styremøter/2026-11-20 Styremøte» eller «Årsmøter/Årsmøte 2027».
 */
module.exports = function meetingsRouter(type) {
  const router = express.Router();
  router.use(requireLogin);

  const base = type === 'arsmote' ? '/arsmoter' : '/moter';
  const cfg = type === 'arsmote'
    ? { list: 'Årsmøter', one: 'Årsmøte', defaultTitle: 'Årsmøte', parentKey: 'arsmoter' }
    : { list: 'Styremøter', one: 'Styremøte', defaultTitle: 'Styremøte', parentKey: 'styremoter' };

  function folderName(m) {
    return type === 'arsmote' ? `${m.title} ${m.starts_at.slice(0, 4)}`.replace(/(\d{4}) \1$/, '$1') : `${m.starts_at.slice(0, 10)} ${m.title}`;
  }

  function loadMeeting(req, res) {
    const m = req.app.locals.ctx.db.prepare('SELECT * FROM meetings WHERE id = ? AND type = ?').get(int(req.params.id), type);
    if (!m) res.status(404).render('error', { title: 'Ikke funnet', message: 'Møtet finnes ikke.' });
    return m;
  }

  function meetingData(db, user, m) {
    const items = db.prepare('SELECT * FROM meeting_items WHERE meeting_id = ? ORDER BY sort, number').all(m.id);
    const linked = db.prepare(`SELECT d.* FROM documents d JOIN meeting_documents md ON md.document_id = d.id
                               WHERE md.meeting_id = ? ORDER BY d.title`).all(m.id);
    const inFolder = m.folder_id ? db.prepare('SELECT * FROM documents WHERE folder_id = ? ORDER BY title').all(m.folder_id) : [];
    const seen = new Set();
    const all = [...inFolder, ...linked].filter((d) => (seen.has(d.id) ? false : seen.add(d.id)));
    const docs = all.filter((d) => hasLevel(db, user, d, 'read')).map((d) => ({ ...d, inFolder: d.folder_id === m.folder_id }));
    const hiddenDocs = all.length - docs.length;
    const tasks = db.prepare(`SELECT t.*, u.name AS assignee_name FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
                              WHERE t.meeting_id = ? ORDER BY t.due_date`).all(m.id);
    const attendees = attendeeList(db, m.id);
    return { items, docs, hiddenDocs, tasks, attendees };
  }

  function calendarDetails(req, m, items) {
    const lines = [];
    if (m.meet_url) lines.push(`Google Meet: ${m.meet_url}`, '');
    if (items.length) lines.push('Saksliste:', ...items.map((it) => `Sak ${caseNo(it)} ${it.title}`), '');
    lines.push(`Sakspapirer: ${baseUrl(req)}${base}/${m.id}`);
    return lines.join('\n');
  }

  router.get('/', (req, res) => {
    const { db } = req.app.locals.ctx;
    const now = today();
    const upcoming = db.prepare("SELECT * FROM meetings WHERE type = ? AND substr(starts_at,1,10) >= ? AND status != 'gjennomfort' ORDER BY starts_at").all(type, now);
    const past = db.prepare("SELECT * FROM meetings WHERE type = ? AND NOT (substr(starts_at,1,10) >= ? AND status != 'gjennomfort') ORDER BY starts_at DESC").all(type, now);
    const extra = {};
    if (type === 'styremote') {
      extra.sharedFolders = db.prepare("SELECT * FROM folders WHERE key IN ('storre-saker','referat-eksterne','annet') ORDER BY sort").all();
    } else {
      extra.sharedFolders = db.prepare("SELECT * FROM folders WHERE key = 'innkallinger'").all();
    }
    res.render('meetings/list', { title: cfg.list, upcoming, past, base, cfg, ...extra });
  });

  router.get('/ny', requireRole('styre'), (req, res) => {
    res.render('meetings/form', { title: `Nytt ${cfg.one.toLowerCase()}`, meeting: { title: cfg.defaultTitle, status: 'planlagt' }, base, cfg });
  });

  router.post('/ny', requireRole('styre'), (req, res) => {
    const { db } = req.app.locals.ctx;
    const startsAt = str(req.body.starts_at);
    if (!startsAt || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(startsAt)) {
      return res.status(400).render('meetings/form', { title: `Nytt ${cfg.one.toLowerCase()}`, meeting: req.body, base, cfg, error: 'Oppgi dato og klokkeslett.' });
    }
    const meetUrl = str(req.body.meet_url);
    if (meetUrl && !MEET_RE.test(meetUrl)) {
      return res.status(400).render('meetings/form', { title: `Nytt ${cfg.one.toLowerCase()}`, meeting: req.body, base, cfg, error: 'Google Meet-lenken må starte med https://meet.google.com/' });
    }
    const id = tx(db, () => {
      const m = { title: str(req.body.title) || cfg.defaultTitle, starts_at: startsAt };
      const folderId = ensureSubfolder(db, cfg.parentKey, folderName(m));
      const r = db.prepare('INSERT INTO meetings (type, title, starts_at, ends_at, location, meet_url, notes, folder_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(type, m.title, startsAt, str(req.body.ends_at), str(req.body.location), meetUrl, str(req.body.notes), folderId, req.user.id);
      const mid = Number(r.lastInsertRowid);
      // Styremøter: inviter alle med styreverv som standard
      if (type === 'styremote') {
        const board = db.prepare(`SELECT DISTINCT m.id FROM members m JOIN member_roles r ON r.member_id = m.id
                                  WHERE m.active = 1 AND r.role IN (${BOARD_CORE.map(() => '?').join(',')})`).all(...BOARD_CORE);
        for (const b of board) db.prepare('INSERT INTO meeting_attendees (meeting_id, member_id) VALUES (?, ?)').run(mid, b.id);
      }
      return mid;
    });
    logActivity(db, req.user.id, `${type}-opprettet`, startsAt);
    req.flash('ok', `${cfg.one} er opprettet med egen dokumentmappe. Legg til saker, deltakere og Google Meet, og send innkalling.`);
    res.redirect(`${base}/${id}`);
  });

  router.get('/:id', (req, res) => {
    const { db } = req.app.locals.ctx;
    const m = loadMeeting(req, res);
    if (!m) return;
    const data = meetingData(db, req.user, m);
    const shownIds = new Set(data.docs.map((d) => d.id));
    const availableDocs = res.locals.canWrite ? visibleDocuments(db, req.user).filter((d) => !shownIds.has(d.id)) : [];
    const users = db.prepare('SELECT id, name FROM users WHERE active = 1 ORDER BY name').all();
    const attendeeIds = new Set(data.attendees.map((a) => a.id));
    const members = res.locals.canWrite
      ? db.prepare(`SELECT m.id, m.first_name, m.last_name, m.email, EXISTS(SELECT 1 FROM member_roles r WHERE r.member_id = m.id) AS has_role
                    FROM members m WHERE m.active = 1 ORDER BY has_role DESC, m.last_name, m.first_name`).all()
        .filter((mm) => !attendeeIds.has(mm.id))
      : [];
    const gcal = googleCalendarUrl({
      title: `${m.title} – ${res.locals.clubName}`,
      startsAt: m.starts_at, endsAt: m.ends_at,
      location: m.meet_url || m.location,
      details: calendarDetails(req, m, data.items),
      guests: data.attendees.filter((a) => a.email).map((a) => a.email),
    });
    const folder = m.folder_id ? db.prepare('SELECT * FROM folders WHERE id = ?').get(m.folder_id) : null;
    res.render('meetings/show', { title: m.title, meeting: m, ...data, availableDocs, users, members, gcal, folder, base, cfg });
  });

  router.get('/:id/kalender.ics', (req, res) => {
    const { db } = req.app.locals.ctx;
    const m = loadMeeting(req, res);
    if (!m) return;
    const { items, attendees } = meetingData(db, req.user, m);
    const ics = meetingIcs({
      uid: `mote-${m.id}@styreapp`,
      title: `${m.title} – ${res.locals.clubName}`,
      startsAt: m.starts_at, endsAt: m.ends_at,
      location: [m.location, m.meet_url].filter(Boolean).join(' / '),
      details: calendarDetails(req, m, items),
      url: m.meet_url || `${baseUrl(req)}${base}/${m.id}`,
      organizer: { name: req.user.name, email: req.user.email },
      attendees: attendees.filter((a) => a.email),
    });
    res.set('Content-Type', 'text/calendar; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${type}-${m.starts_at.slice(0, 10)}.ics"`);
    res.send(ics);
  });

  router.get('/:id/protokoll', (req, res) => {
    const { db } = req.app.locals.ctx;
    const m = loadMeeting(req, res);
    if (!m) return;
    res.render('meetings/minutes', { title: `Protokoll – ${m.title}`, meeting: m, ...meetingData(db, req.user, m), base, cfg, print: true });
  });

  router.get('/:id/rediger', requireRole('styre'), (req, res) => {
    const m = loadMeeting(req, res);
    if (!m) return;
    res.render('meetings/form', { title: `Rediger ${cfg.one.toLowerCase()}`, meeting: m, base, cfg });
  });

  router.post('/:id/rediger', requireRole('styre'), (req, res) => {
    const { db } = req.app.locals.ctx;
    const m = loadMeeting(req, res);
    if (!m) return;
    const startsAt = str(req.body.starts_at) || m.starts_at;
    const status = STATUSES.includes(req.body.status) ? req.body.status : m.status;
    const meetUrl = str(req.body.meet_url);
    if (meetUrl && !MEET_RE.test(meetUrl)) {
      return res.status(400).render('meetings/form', { title: `Rediger ${cfg.one.toLowerCase()}`, meeting: { ...m, ...req.body }, base, cfg, error: 'Google Meet-lenken må starte med https://meet.google.com/' });
    }
    db.prepare('UPDATE meetings SET title = ?, starts_at = ?, ends_at = ?, location = ?, meet_url = ?, status = ?, notes = ? WHERE id = ?')
      .run(str(req.body.title) || m.title, startsAt, str(req.body.ends_at), str(req.body.location), meetUrl, status, str(req.body.notes), m.id);
    req.flash('ok', 'Møtet er oppdatert.');
    res.redirect(`${base}/${m.id}`);
  });

  router.post('/:id/meet', requireRole('styre'), (req, res) => {
    const { db } = req.app.locals.ctx;
    const m = loadMeeting(req, res);
    if (!m) return;
    const meetUrl = str(req.body.meet_url);
    if (meetUrl && !MEET_RE.test(meetUrl)) {
      req.flash('error', 'Lim inn en lenke som starter med https://meet.google.com/');
    } else {
      db.prepare('UPDATE meetings SET meet_url = ? WHERE id = ?').run(meetUrl, m.id);
      req.flash('ok', meetUrl ? 'Google Meet-lenken er lagret.' : 'Google Meet-lenken er fjernet.');
    }
    res.redirect(`${base}/${m.id}#deltakere`);
  });

  router.post('/:id/slett', requireRole('admin'), (req, res) => {
    const { db } = req.app.locals.ctx;
    const m = loadMeeting(req, res);
    if (!m) return;
    db.prepare('DELETE FROM meetings WHERE id = ?').run(m.id);
    logActivity(db, req.user.id, `${type}-slettet`, `${m.title} ${m.starts_at}`);
    req.flash('ok', 'Møtet er slettet. Dokumentmappen er beholdt.');
    res.redirect(base);
  });

  // ---- Deltakere ------------------------------------------------------------

  router.post('/:id/deltakere', requireRole('styre'), (req, res) => {
    const { db } = req.app.locals.ctx;
    const m = loadMeeting(req, res);
    if (!m) return;
    const ins = db.prepare('INSERT OR IGNORE INTO meeting_attendees (meeting_id, member_id) VALUES (?, ?)');
    for (const id of asArray(req.body.member_ids).map(Number)) {
      if (db.prepare('SELECT 1 FROM members WHERE id = ?').get(id)) ins.run(m.id, id);
    }
    res.redirect(`${base}/${m.id}#deltakere`);
  });

  router.post('/:id/deltakere/:memberId/fjern', requireRole('styre'), (req, res) => {
    const { db } = req.app.locals.ctx;
    const m = loadMeeting(req, res);
    if (!m) return;
    db.prepare('DELETE FROM meeting_attendees WHERE meeting_id = ? AND member_id = ?').run(m.id, int(req.params.memberId));
    res.redirect(`${base}/${m.id}#deltakere`);
  });

  // ---- Saker (saksnummer løper per år: 1/26, 2/26 …) -----------------------

  router.post('/:id/saker', requireRole('styre'), (req, res) => {
    const { db } = req.app.locals.ctx;
    const m = loadMeeting(req, res);
    if (!m) return;
    const title = str(req.body.title);
    if (!title) { req.flash('error', 'Saken må ha en tittel.'); return res.redirect(`${base}/${m.id}`); }
    const year = Number(m.starts_at.slice(0, 4));
    tx(db, () => {
      // Styresaker og årsmøtesaker nummereres hver for seg
      const number = db.prepare(`SELECT COALESCE(MAX(i.number), 0) + 1 AS n FROM meeting_items i JOIN meetings mm ON mm.id = i.meeting_id
                                 WHERE i.year = ? AND mm.type = ?`).get(year, type).n;
      const sort = db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS n FROM meeting_items WHERE meeting_id = ?').get(m.id).n;
      db.prepare('INSERT INTO meeting_items (meeting_id, number, year, title, description, sort) VALUES (?, ?, ?, ?, ?, ?)')
        .run(m.id, number, year, title, str(req.body.description), sort);
    });
    res.redirect(`${base}/${m.id}#saker`);
  });

  router.post('/:id/saker/:itemId', requireRole('styre'), (req, res) => {
    const { db } = req.app.locals.ctx;
    const m = loadMeeting(req, res);
    if (!m) return;
    const item = db.prepare('SELECT * FROM meeting_items WHERE id = ? AND meeting_id = ?').get(int(req.params.itemId), m.id);
    if (!item) return res.redirect(`${base}/${m.id}`);
    db.prepare('UPDATE meeting_items SET title = ?, description = ?, decision = ? WHERE id = ?')
      .run(str(req.body.title) || item.title, str(req.body.description), str(req.body.decision), item.id);
    req.flash('ok', `Sak ${caseNo(item)} er lagret.`);
    res.redirect(`${base}/${m.id}#sak-${item.id}`);
  });

  router.post('/:id/saker/:itemId/slett', requireRole('styre'), (req, res) => {
    const { db } = req.app.locals.ctx;
    const m = loadMeeting(req, res);
    if (!m) return;
    db.prepare('DELETE FROM meeting_items WHERE id = ? AND meeting_id = ?').run(int(req.params.itemId), m.id);
    res.redirect(`${base}/${m.id}#saker`);
  });

  // ---- Dokumenter og oppgaver ------------------------------------------------

  router.post('/:id/dokumenter', requireRole('styre'), (req, res) => {
    const { db } = req.app.locals.ctx;
    const m = loadMeeting(req, res);
    if (!m) return;
    const doc = db.prepare('SELECT * FROM documents WHERE id = ?').get(int(req.body.document_id));
    if (doc && hasLevel(db, req.user, doc, 'read')) {
      db.prepare('INSERT OR IGNORE INTO meeting_documents (meeting_id, document_id) VALUES (?, ?)').run(m.id, doc.id);
    }
    res.redirect(`${base}/${m.id}#dokumenter`);
  });

  router.post('/:id/dokumenter/:docId/fjern', requireRole('styre'), (req, res) => {
    const { db } = req.app.locals.ctx;
    const m = loadMeeting(req, res);
    if (!m) return;
    db.prepare('DELETE FROM meeting_documents WHERE meeting_id = ? AND document_id = ?').run(m.id, int(req.params.docId));
    res.redirect(`${base}/${m.id}#dokumenter`);
  });

  router.post('/:id/oppgaver', requireRole('styre'), (req, res) => {
    const { db } = req.app.locals.ctx;
    const m = loadMeeting(req, res);
    if (!m) return;
    const title = str(req.body.title);
    if (title) {
      db.prepare('INSERT INTO tasks (title, due_date, assignee_id, meeting_id, year, created_by) VALUES (?, ?, ?, ?, ?, ?)')
        .run(title, str(req.body.due_date), int(req.body.assignee_id), m.id, Number(m.starts_at.slice(0, 4)), req.user.id);
    }
    res.redirect(`${base}/${m.id}#oppgaver`);
  });

  return router;
};

