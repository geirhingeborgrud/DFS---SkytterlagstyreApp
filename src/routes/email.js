'use strict';
const express = require('express');
const path = require('node:path');
const { logActivity } = require('../db');
const { requireLogin, requireRole } = require('../auth');
const { hasLevel, visibleDocuments } = require('../permissions');
const { str, int, asArray, fmtLocal, caseNo } = require('../helpers');
const { baseUrl } = require('./auth');

const router = express.Router();
router.use(requireLogin, requireRole('styre'));

const MAX_ATTACH = 20 * 1024 * 1024;
const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/**
 * Mulige mottakere: aktive medlemmer med e-post (styret først) og brukere som ikke er koblet til et medlem.
 * Nøkkel er «m:<id>» for medlem og «u:<id>» for bruker.
 */
function recipientOptions(db) {
  const members = db.prepare(`SELECT m.id, m.first_name || ' ' || m.last_name AS name, m.email,
                                     (SELECT GROUP_CONCAT(role) FROM member_roles r WHERE r.member_id = m.id) AS roles
                              FROM members m WHERE m.active = 1 AND m.email IS NOT NULL
                              ORDER BY roles IS NULL, m.last_name, m.first_name`).all()
    .map((m) => ({ key: `m:${m.id}`, name: m.name, email: m.email, roles: m.roles ? m.roles.split(',') : [], board: !!m.roles }));
  const users = db.prepare('SELECT id, name, email FROM users WHERE active = 1 AND member_id IS NULL ORDER BY name').all()
    .map((u) => ({ key: `u:${u.id}`, name: u.name, email: u.email, roles: [], board: true }));
  return [...members.filter((m) => m.board), ...users, ...members.filter((m) => !m.board)];
}

function meetingTemplate(db, meetingId, type, clubName) {
  const m = db.prepare('SELECT * FROM meetings WHERE id = ?').get(meetingId);
  if (!m) return null;
  const items = db.prepare('SELECT * FROM meeting_items WHERE meeting_id = ? ORDER BY sort, number').all(m.id);
  const docIds = db.prepare(`SELECT document_id FROM meeting_documents WHERE meeting_id = ?
                             UNION SELECT id FROM documents WHERE folder_id = ?`).all(m.id, m.folder_id).map((r) => r.document_id);
  const attendees = db.prepare('SELECT member_id FROM meeting_attendees WHERE meeting_id = ?').all(m.id).map((r) => `m:${r.member_id}`);
  const meet = m.meet_url ? `Google Meet: ${m.meet_url}\n` : '';
  const when = fmtLocal(m.starts_at);
  if (type === 'protokoll') {
    const lines = items.map((it) => `Sak ${caseNo(it)} ${it.title}\n${it.description ? it.description + '\n' : ''}Vedtak: ${it.decision || '–'}\n`);
    return {
      subject: `Protokoll fra ${m.title.toLowerCase()} ${when.split(' ')[0]}`,
      body: `Hei,\n\nVedlagt følger protokoll fra ${m.title.toLowerCase()} ${when}${m.location ? ', ' + m.location : ''}.\n\n${lines.join('\n')}\nMed vennlig hilsen\n${clubName}`,
      docIds, attendees,
    };
  }
  const lines = items.map((it) => `Sak ${caseNo(it)} ${it.title}${it.description ? '\n   ' + it.description.replace(/\n/g, '\n   ') : ''}`);
  return {
    subject: `Innkalling til ${m.title.toLowerCase()} ${when.split(' ')[0]}`,
    body: `Hei,\n\nStyret innkalles til ${m.title.toLowerCase()}.\n\nTid: ${when}\nSted: ${m.location || (m.meet_url ? 'Digitalt' : 'Avklares')}\n${meet}\nSaksliste:\n${lines.join('\n') || '(kommer)'}\n\nEventuelle forfall meldes til leder.\n\nMed vennlig hilsen\n${clubName}`,
    docIds, attendees,
  };
}

router.get('/', (req, res) => {
  const { db } = req.app.locals.ctx;
  const emails = db.prepare(`SELECT e.*, u.name AS sender_name FROM emails e LEFT JOIN users u ON u.id = e.sender_id
                             ORDER BY e.sent_at DESC LIMIT 200`).all()
    .map((e) => ({ ...e, recipients: JSON.parse(e.recipients), document_ids: JSON.parse(e.document_ids) }));
  res.render('email/list', { title: 'E-post til styret', emails });
});

router.get('/ny', (req, res) => {
  const { db, mailer } = req.app.locals.ctx;
  const recipients = recipientOptions(db);
  const docs = visibleDocuments(db, req.user);
  let form = { subject: '', body: '', docIds: asArray(req.query.dok).map(Number), keys: recipients.filter((r) => r.board).map((r) => r.key), mode: 'vedlegg', extra: '' };
  const meetingId = int(req.query.mote);
  if (meetingId) {
    const t = meetingTemplate(db, meetingId, req.query.type, res.locals.clubName);
    if (t) form = { ...form, subject: t.subject, body: t.body, docIds: t.docIds, keys: t.attendees.length ? t.attendees : form.keys };
  }
  res.render('email/compose', { title: 'Send e-post', recipients, docs, form, smtp: mailer.configured });
});

router.post('/ny', async (req, res, next) => {
  const { db, mailer, uploadDir } = req.app.locals.ctx;
  try {
    const options = recipientOptions(db);
    const keys = asArray(req.body.recipients);
    const docIds = asArray(req.body.docs).map(Number);
    const extra = (str(req.body.extra) || '').split(/[\s,;]+/).filter(Boolean);
    const mode = req.body.mode === 'lenke' ? 'lenke' : 'vedlegg';
    const form = { subject: str(req.body.subject) || '', body: str(req.body.body) || '', docIds, keys, mode, extra: extra.join(', ') };
    const fail = (error) => res.status(400).render('email/compose', {
      title: 'Send e-post', recipients: options, docs: visibleDocuments(db, req.user), form, smtp: mailer.configured, error,
    });

    const recipients = options.filter((o) => keys.includes(o.key)).map((o) => ({ name: o.name, email: o.email }));
    const badExtra = extra.filter((e) => !EMAIL_RE.test(e));
    if (badExtra.length) return fail(`Ugyldig e-postadresse: ${badExtra.join(', ')}`);
    for (const e of extra) if (!recipients.some((r) => r.email.toLowerCase() === e.toLowerCase())) recipients.push({ name: null, email: e });
    if (!recipients.length) return fail('Velg minst én mottaker.');
    if (!form.subject || !form.body) return fail('Fyll ut emne og tekst.');

    const docs = [];
    for (const id of docIds) {
      const d = db.prepare(`SELECT d.*, v.stored_name, v.original_name, v.size, v.mime FROM documents d
                            LEFT JOIN document_versions v ON v.id = d.current_version_id WHERE d.id = ?`).get(id);
      if (!d || !hasLevel(db, req.user, d, 'read')) return fail('Du har ikke tilgang til ett av de valgte dokumentene.');
      docs.push(d);
    }

    let text = form.body;
    let attachments;
    if (docs.length && mode === 'vedlegg') {
      const total = docs.reduce((s, d) => s + (d.size || 0), 0);
      if (total > MAX_ATTACH) return fail('Vedleggene er til sammen over 20 MB. Velg «Send som lenker» i stedet.');
      attachments = docs.map((d) => ({ filename: d.original_name, path: path.join(uploadDir, d.stored_name), contentType: d.mime || undefined }));
    } else if (docs.length) {
      const base = baseUrl(req);
      text += `\n\nDokumenter (krever innlogging):\n${docs.map((d) => `- ${d.title}: ${base}/dokumenter/${d.id}`).join('\n')}`;
    }

    let status; let error = null;
    try {
      const r = await mailer.send({
        to: recipients.map((r) => (r.name ? { name: r.name, address: r.email } : r.email)),
        subject: form.subject,
        text,
        attachments,
        replyTo: { name: req.user.name, address: req.user.email },
        fromName: `${req.user.name} – ${res.locals.clubName}`,
      });
      status = r.status;
    } catch (e) {
      status = 'feilet';
      error = e.message;
    }
    const r = db.prepare('INSERT INTO emails (sender_id, subject, body, recipients, document_ids, mode, status, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(req.user.id, form.subject, text, JSON.stringify(recipients), JSON.stringify(docIds), mode, status, error);
    logActivity(db, req.user.id, 'epost', `${form.subject} (${status})`);
    if (status === 'feilet') req.flash('error', `Sending feilet: ${error}`);
    else if (status === 'simulert') req.flash('ok', 'E-posten er registrert, men SMTP er ikke konfigurert – ingenting ble faktisk sendt.');
    else req.flash('ok', `E-posten er sendt til ${recipients.length} mottaker(e).`);
    res.redirect(`/epost/${r.lastInsertRowid}`);
  } catch (e) { next(e); }
});

router.get('/:id', (req, res) => {
  const { db } = req.app.locals.ctx;
  const e = db.prepare(`SELECT e.*, u.name AS sender_name FROM emails e LEFT JOIN users u ON u.id = e.sender_id WHERE e.id = ?`).get(int(req.params.id));
  if (!e) return res.status(404).render('error', { title: 'Ikke funnet', message: 'E-posten finnes ikke.' });
  const ids = JSON.parse(e.document_ids);
  const docs = ids.length
    ? db.prepare(`SELECT * FROM documents WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
      .map((d) => ({ ...d, readable: hasLevel(db, req.user, d, 'read') }))
    : [];
  res.render('email/show', { title: e.subject, email: { ...e, recipients: JSON.parse(e.recipients) }, docs });
});

module.exports = router;
