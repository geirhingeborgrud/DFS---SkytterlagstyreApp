'use strict';
const crypto = require('node:crypto');

const KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, KEYLEN).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  if (!stored || typeof password !== 'string') return false;
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = crypto.scryptSync(password, salt, expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

function validatePassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Passordet må ha minst 10 tegn.';
  return null;
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/** Enkel begrensning av innloggingsforsøk (per IP + e-post), i minnet. */
const attempts = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 8;

function tooManyAttempts(key) {
  const a = attempts.get(key);
  if (!a) return false;
  if (Date.now() - a.first > WINDOW_MS) { attempts.delete(key); return false; }
  return a.count >= MAX_ATTEMPTS;
}
function registerFailure(key) {
  const a = attempts.get(key);
  if (!a || Date.now() - a.first > WINDOW_MS) attempts.set(key, { first: Date.now(), count: 1 });
  else a.count++;
}
function clearFailures(key) { attempts.delete(key); }

// ---- Middleware -----------------------------------------------------------

function requireLogin(req, res, next) {
  if (req.user) return next();
  req.session.returnTo = req.originalUrl;
  return res.redirect('/logg-inn');
}

/** Globale roller: admin > styre > les */
const ROLE_RANK = { les: 1, styre: 2, admin: 3 };

function requireRole(role) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/logg-inn');
    if (ROLE_RANK[req.user.role] >= ROLE_RANK[role]) return next();
    return res.status(403).render('error', { title: 'Ingen tilgang', message: 'Du har ikke tilgang til denne funksjonen.' });
  };
}

/** Administrator, eller styremedlem med ett av de angitte vervene (f.eks. 'vapenansvarlig'). */
function hasBoardRole(user, ...roles) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  if (user.role === 'les') return false;
  return (user.boardRoles || []).some((r) => roles.includes(r));
}
function requireBoardRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/logg-inn');
    if (hasBoardRole(req.user, ...roles)) return next();
    const { BOARD_ROLES } = require('./helpers');
    return res.status(403).render('error', { title: 'Ingen tilgang', message: `Dette krever administrator eller vervet ${roles.map((r) => BOARD_ROLES[r]).join(' / ')}.` });
  };
}

function canWrite(user) { return !!user && ROLE_RANK[user.role] >= ROLE_RANK.styre; }

// ---- CSRF -----------------------------------------------------------------

function csrfToken(req) {
  if (!req.session.csrf) req.session.csrf = newToken();
  return req.session.csrf;
}

function verifyCsrf(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const sent = (req.body && req.body._csrf) || req.get('x-csrf-token');
  const expected = req.session && req.session.csrf;
  if (sent && expected && sent.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected))) return next();
  return res.status(403).render('error', { title: 'Ugyldig skjema', message: 'Skjemaet var utløpt eller ugyldig. Gå tilbake, last siden på nytt og prøv igjen.' });
}

module.exports = {
  hashPassword, verifyPassword, validatePassword, newToken,
  tooManyAttempts, registerFailure, clearFailures,
  requireLogin, requireRole, canWrite, ROLE_RANK, hasBoardRole, requireBoardRole,
  csrfToken, verifyCsrf,
};
