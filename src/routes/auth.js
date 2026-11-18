'use strict';
const express = require('express');
const { setSetting, logActivity, tx } = require('../db');
const auth = require('../auth');
const { str } = require('../helpers');

const router = express.Router();

function baseUrl(req) {
  return req.app.locals.ctx.baseUrl || `${req.protocol}://${req.get('host')}`;
}

/** Lager invitasjons-/tilbakestillingslenke (gyldig i 7 dager). */
function issueInvite(db, userId) {
  const token = auth.newToken();
  const expires = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  db.prepare('UPDATE users SET invite_token = ?, invite_expires = ? WHERE id = ?').run(token, expires, userId);
  return token;
}

// ---- Første gangs oppsett -------------------------------------------------

router.get('/oppsett', (req, res) => {
  const { db } = req.app.locals.ctx;
  if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) return res.redirect('/');
  res.render('setup', { title: 'Oppsett', values: {} });
});

router.post('/oppsett', (req, res) => {
  const { db } = req.app.locals.ctx;
  if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) return res.redirect('/');
  const values = { club: str(req.body.club), name: str(req.body.name), email: str(req.body.email) };
  const pwErr = auth.validatePassword(req.body.password);
  let error = null;
  if (!values.club || !values.name || !values.email) error = 'Fyll ut alle felt.';
  else if (pwErr) error = pwErr;
  else if (req.body.password !== req.body.password2) error = 'Passordene er ikke like.';
  if (error) return res.status(400).render('setup', { title: 'Oppsett', values, error });

  const id = tx(db, () => {
    setSetting(db, 'club_name', values.club);
    const parts = values.name.split(/\s+/);
    const last = parts.length > 1 ? parts.pop() : '';
    const m = db.prepare('INSERT INTO members (first_name, last_name, email) VALUES (?, ?, ?)').run(parts.join(' '), last, values.email);
    const r = db.prepare("INSERT INTO users (name, email, password_hash, role, member_id) VALUES (?, ?, ?, 'admin', ?)")
      .run(values.name, values.email, auth.hashPassword(req.body.password), m.lastInsertRowid);
    return Number(r.lastInsertRowid);
  });
  logActivity(db, id, 'oppsett', `Opprettet ${values.club}`);
  req.session.regenerate(() => {
    req.session.userId = id;
    req.flash('ok', `Velkommen! ${values.club} er satt opp. Importer medlemmer under «Medlemmer», sett verv og gi styret tilgang under «Styret».`);
    res.redirect('/');
  });
});

// ---- Innlogging -----------------------------------------------------------

router.get('/logg-inn', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { title: 'Logg inn', email: '' });
});

router.post('/logg-inn', (req, res) => {
  const { db } = req.app.locals.ctx;
  const email = str(req.body.email) || '';
  const key = `${req.ip}|${email.toLowerCase()}`;
  if (auth.tooManyAttempts(key)) {
    return res.status(429).render('login', { title: 'Logg inn', email, error: 'For mange forsøk. Vent 15 minutter og prøv igjen.' });
  }
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !user.active || !auth.verifyPassword(req.body.password || '', user.password_hash)) {
    auth.registerFailure(key);
    return res.status(401).render('login', { title: 'Logg inn', email, error: 'Feil e-post eller passord.' });
  }
  auth.clearFailures(key);
  const returnTo = req.session.returnTo;
  req.session.regenerate(() => {
    req.session.userId = user.id;
    logActivity(db, user.id, 'innlogging', null);
    res.redirect(returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : '/');
  });
});

router.post('/logg-ut', (req, res) => {
  req.session.destroy(() => res.redirect('/logg-inn'));
});

// ---- Glemt passord ----------------------------------------------------------

router.get('/glemt-passord', (req, res) => {
  res.render('forgot', { title: 'Glemt passord' });
});

router.post('/glemt-passord', async (req, res, next) => {
  try {
    const { db, mailer } = req.app.locals.ctx;
    const email = str(req.body.email);
    const user = email && db.prepare('SELECT * FROM users WHERE email = ? AND active = 1').get(email);
    if (user) {
      const token = issueInvite(db, user.id);
      const link = `${baseUrl(req)}/invitasjon/${token}`;
      await mailer.send({
        to: user.email,
        subject: `${res.locals.clubName}: tilbakestill passord`,
        text: `Hei ${user.name}!\n\nBruk lenken under for å velge nytt passord (gyldig i 7 dager):\n${link}\n\nHar du ikke bedt om dette, kan du se bort fra e-posten.`,
      });
      logActivity(db, user.id, 'glemt-passord', null);
    }
    // Samme svar uansett, så man ikke kan sjekke hvilke adresser som finnes
    req.flash('ok', 'Hvis adressen er registrert, er det sendt en lenke for å velge nytt passord. Kontakt administrator hvis du ikke mottar den.');
    res.redirect('/logg-inn');
  } catch (e) { next(e); }
});

// ---- Invitasjon / sett passord --------------------------------------------

function findInvite(db, token) {
  if (!token) return null;
  const u = db.prepare('SELECT * FROM users WHERE invite_token = ? AND active = 1').get(token);
  if (!u || !u.invite_expires || new Date(u.invite_expires) < new Date()) return null;
  return u;
}

router.get('/invitasjon/:token', (req, res) => {
  const u = findInvite(req.app.locals.ctx.db, req.params.token);
  if (!u) return res.status(404).render('error', { title: 'Ugyldig lenke', message: 'Lenken er ugyldig eller utløpt. Be administrator om en ny.' });
  res.render('set-password', { title: 'Velg passord', invitee: u, token: req.params.token });
});

router.post('/invitasjon/:token', (req, res) => {
  const { db } = req.app.locals.ctx;
  const u = findInvite(db, req.params.token);
  if (!u) return res.status(404).render('error', { title: 'Ugyldig lenke', message: 'Lenken er ugyldig eller utløpt. Be administrator om en ny.' });
  const err = auth.validatePassword(req.body.password) || (req.body.password !== req.body.password2 ? 'Passordene er ikke like.' : null);
  if (err) return res.status(400).render('set-password', { title: 'Velg passord', invitee: u, token: req.params.token, error: err });
  db.prepare('UPDATE users SET password_hash = ?, invite_token = NULL, invite_expires = NULL WHERE id = ?')
    .run(auth.hashPassword(req.body.password), u.id);
  logActivity(db, u.id, 'passord-satt', null);
  req.session.regenerate(() => {
    req.session.userId = u.id;
    req.flash('ok', 'Passordet er lagret. Velkommen!');
    res.redirect('/');
  });
});

// ---- Min profil -----------------------------------------------------------

router.get('/profil', auth.requireLogin, (req, res) => {
  res.render('profile', { title: 'Min profil' });
});

router.post('/profil', auth.requireLogin, (req, res) => {
  const { db } = req.app.locals.ctx;
  const name = str(req.body.name);
  if (!name) { req.flash('error', 'Navn kan ikke være tomt.'); return res.redirect('/profil'); }
  db.prepare('UPDATE users SET name = ?, phone = ? WHERE id = ?').run(name, str(req.body.phone), req.user.id);
  req.flash('ok', 'Profilen er oppdatert.');
  res.redirect('/profil');
});

router.post('/profil/passord', auth.requireLogin, (req, res) => {
  const { db } = req.app.locals.ctx;
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (!auth.verifyPassword(req.body.current || '', row.password_hash)) {
    req.flash('error', 'Nåværende passord er feil.'); return res.redirect('/profil');
  }
  const err = auth.validatePassword(req.body.password) || (req.body.password !== req.body.password2 ? 'Passordene er ikke like.' : null);
  if (err) { req.flash('error', err); return res.redirect('/profil'); }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(req.body.password), req.user.id);
  logActivity(db, req.user.id, 'passord-endret', null);
  req.flash('ok', 'Passordet er endret.');
  res.redirect('/profil');
});

module.exports = router;
module.exports.issueInvite = issueInvite;
module.exports.baseUrl = baseUrl;
