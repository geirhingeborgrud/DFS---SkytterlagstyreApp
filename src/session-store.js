'use strict';
const session = require('express-session');

/** Sesjonslager i SQLite slik at innlogginger overlever omstart. */
class SqliteStore extends session.Store {
  constructor(db) {
    super();
    this.db = db;
    this.lastCleanup = 0;
  }
  cleanup() {
    const now = Date.now();
    if (now - this.lastCleanup < 60 * 60 * 1000) return;
    this.lastCleanup = now;
    this.db.prepare('DELETE FROM sessions WHERE expires < ?').run(now);
  }
  expiry(sess) {
    const maxAge = sess && sess.cookie && sess.cookie.maxAge;
    return Date.now() + (typeof maxAge === 'number' ? maxAge : 86400000);
  }
  get(sid, cb) {
    try {
      this.cleanup();
      const row = this.db.prepare('SELECT data, expires FROM sessions WHERE sid = ?').get(sid);
      if (!row || row.expires < Date.now()) return cb(null, null);
      cb(null, JSON.parse(row.data));
    } catch (e) { cb(e); }
  }
  set(sid, sess, cb) {
    try {
      this.db.prepare(`INSERT INTO sessions (sid, data, expires) VALUES (?, ?, ?)
                       ON CONFLICT(sid) DO UPDATE SET data = excluded.data, expires = excluded.expires`)
        .run(sid, JSON.stringify(sess), this.expiry(sess));
      cb && cb(null);
    } catch (e) { cb && cb(e); }
  }
  touch(sid, sess, cb) {
    try {
      this.db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?').run(this.expiry(sess), sid);
      cb && cb(null);
    } catch (e) { cb && cb(e); }
  }
  destroy(sid, cb) {
    try {
      this.db.prepare('DELETE FROM sessions WHERE sid = ?').run(sid);
      cb && cb(null);
    } catch (e) { cb && cb(e); }
  }
}

module.exports = { SqliteStore };
