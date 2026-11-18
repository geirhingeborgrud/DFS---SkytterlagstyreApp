'use strict';
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const session = require('express-session');

const { getSetting } = require('./db');
const { SqliteStore } = require('./session-store');
const auth = require('./auth');
const helpers = require('./helpers');
const { LEVEL_LABELS } = require('./permissions');

/**
 * @param {object} opts
 * @param {import('node:sqlite').DatabaseSync} opts.db
 * @param {ReturnType<import('./mailer').createMailer>} opts.mailer
 * @param {string} opts.uploadDir
 * @param {string} [opts.sessionSecret]
 * @param {string} [opts.baseUrl]  Offentlig adresse, brukes i lenker i e-post
 * @param {boolean} [opts.secureCookies]
 */
function createApp({ db, mailer, uploadDir, sessionSecret, baseUrl, secureCookies = false }) {
  fs.mkdirSync(uploadDir, { recursive: true });
  const app = express();
  app.locals.ctx = { db, mailer, uploadDir, baseUrl };

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'same-origin');
    res.set('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'");
    next();
  });

  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  app.use(session({
    store: new SqliteStore(db),
    secret: sessionSecret || crypto.randomBytes(32).toString('hex'),
    name: 'styreapp.sid',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: secureCookies, maxAge: 1000 * 60 * 60 * 24 * 14 },
  }));

  // Last inn innlogget bruker og felles visningsvariabler
  app.use((req, res, next) => {
    req.user = null;
    if (req.session.userId) {
      const u = db.prepare('SELECT id, name, email, role, phone, active, member_id, last_seen FROM users WHERE id = ?').get(req.session.userId);
      if (u && u.active) {
        u.boardRoles = u.member_id
          ? db.prepare('SELECT role FROM member_roles WHERE member_id = ?').all(u.member_id).map((r) => r.role)
          : [];
        // Oppdater «sist sett» maks én gang i minuttet (brukes for «pålogget nå»)
        if (!u.last_seen || Date.now() - u.last_seen > 60 * 1000) {
          db.prepare('UPDATE users SET last_seen = ? WHERE id = ?').run(Date.now(), u.id);
        }
        req.user = u;
      } else delete req.session.userId;
    }
    Object.assign(res.locals, helpers, {
      currentUser: req.user,
      canWrite: auth.canWrite(req.user),
      hasBoardRole: (...roles) => auth.hasBoardRole(req.user, ...roles),
      clubName: getSetting(db, 'club_name', 'Skytterlaget'),
      hasLogo: !!getSetting(db, 'logo_file'),
      logoVersion: getSetting(db, 'logo_file', '').slice(0, 8),
      path: req.path,
      LEVEL_LABELS,
      flash: req.session.flash || null,
      csrfToken: () => auth.csrfToken(req),
      title: '',
    });
    delete req.session.flash;
    req.flash = (type, text) => { req.session.flash = { type, text }; };
    next();
  });

  // Lagets logo (offentlig, vises på innloggingssiden)
  app.get('/logo', (req, res) => {
    const file = getSetting(db, 'logo_file');
    if (!file) return res.status(404).end();
    res.set('Cache-Control', 'public, max-age=300');
    res.sendFile(path.join(uploadDir, file), { headers: { 'Content-Type': getSetting(db, 'logo_mime', 'image/png') } });
  });

  // Første gangs oppsett: ingen brukere => send til /oppsett
  app.use((req, res, next) => {
    const hasUsers = db.prepare('SELECT 1 FROM users LIMIT 1').get();
    if (!hasUsers && !req.path.startsWith('/oppsett')) return res.redirect('/oppsett');
    next();
  });

  // CSRF for vanlige skjema (multipart-ruter sjekker selv etter opplasting)
  app.use((req, res, next) => {
    if (req.is('multipart/form-data')) return next();
    return auth.verifyCsrf(req, res, next);
  });

  app.use(require('./routes/auth'));
  app.use(require('./routes/dashboard'));
  app.use('/dokumenter', require('./routes/documents'));
  app.use('/kalender', require('./routes/calendar'));
  app.use('/moter', require('./routes/meetings')('styremote'));
  app.use('/arsmoter', require('./routes/meetings')('arsmote'));
  app.use('/arsdokumenter', require('./routes/yearly'));
  app.use('/arshjul', require('./routes/annual'));
  app.use('/oppgaver', require('./routes/tasks'));
  app.use('/epost', require('./routes/email'));
  app.use('/styret', require('./routes/board'));
  app.use('/medlemmer', require('./routes/members'));
  app.use('/vapen', require('./routes/weapons'));
  app.use('/treninger', require('./routes/trainings'));
  app.use('/stevner', require('./routes/competitions'));
  app.use('/stillinger', require('./routes/positions'));
  app.use('/admin', require('./routes/admin'));

  app.use((req, res) => {
    res.status(404).render('error', { title: 'Ikke funnet', message: 'Siden finnes ikke.' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).render('error', { title: 'For stor fil', message: 'Filen er for stor (maks 25 MB).' });
    }
    console.error(err);
    res.status(500).render('error', { title: 'Feil', message: 'Noe gikk galt. Prøv igjen.' });
  });

  return app;
}

module.exports = { createApp };
