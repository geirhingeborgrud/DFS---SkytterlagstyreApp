'use strict';
const path = require('node:path');
const fs = require('node:fs');

// Enkel .env-støtte uten ekstra avhengigheter
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

const { openDb } = require('./db');
const { createMailer } = require('./mailer');
const { createApp } = require('./app');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const db = openDb(path.join(dataDir, 'styreapp.db'));
const mailer = createMailer();

if (!process.env.SESSION_SECRET) {
  console.warn('ADVARSEL: SESSION_SECRET er ikke satt. Brukere logges ut ved omstart. Sett SESSION_SECRET i .env.');
}
if (!mailer.configured) {
  console.warn('Merk: SMTP er ikke konfigurert – e-post blir kun simulert og logget i appen.');
}

const app = createApp({
  db,
  mailer,
  uploadDir: path.join(dataDir, 'uploads'),
  sessionSecret: process.env.SESSION_SECRET,
  baseUrl: process.env.BASE_URL,
  secureCookies: String(process.env.SECURE_COOKIES || '').toLowerCase() === 'true',
});

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`Styreappen kjører på http://localhost:${port}`);
});
