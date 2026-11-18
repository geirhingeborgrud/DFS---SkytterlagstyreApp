'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');

/** Starter appen på tilfeldig port med tom database og simulert e-post. */
async function startApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'styreapp-test-'));
  const db = openDb(path.join(dir, 'test.db'));
  const sent = [];
  const mailer = {
    configured: true,
    from: 'test@example.com',
    async send(msg) { sent.push(msg); return { status: 'sendt' }; },
  };
  const app = createApp({ db, mailer, uploadDir: path.join(dir, 'uploads'), sessionSecret: 'test' });
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    db, sent, base, dir,
    close: () => new Promise((r) => server.close(() => { fs.rmSync(dir, { recursive: true, force: true }); r(); })),
  };
}

/** Minimal nettleser: holder på cookie og CSRF-token. */
class Client {
  constructor(base) { this.base = base; this.cookie = ''; this.csrf = null; }
  async req(method, url, body, { multipart } = {}) {
    const headers = { cookie: this.cookie };
    let payload;
    if (body && multipart) {
      payload = new FormData();
      for (const [k, v] of Object.entries({ _csrf: this.csrf, ...body })) {
        if (v && v.blob) payload.append(k, v.blob, v.name);
        else if (Array.isArray(v)) v.forEach((x) => payload.append(k, String(x)));
        else if (v != null) payload.append(k, String(v));
      }
    } else if (body) {
      const p = new URLSearchParams();
      for (const [k, v] of Object.entries({ _csrf: this.csrf, ...body })) {
        if (Array.isArray(v)) v.forEach((x) => p.append(k, String(x)));
        else if (v != null) p.append(k, String(v));
      }
      payload = p;
    }
    const res = await fetch(this.base + url, { method, headers, body: payload, redirect: 'manual' });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const text = await res.text();
    const m = /name="_csrf" value="([^"]+)"/.exec(text);
    if (m) this.csrf = m[1];
    return { status: res.status, location: res.headers.get('location'), text, headers: res.headers };
  }
  get(url) { return this.req('GET', url); }
  post(url, body, opts) { return this.req('POST', url, body, opts); }
  /** POST og følg redirect med GET. */
  async submit(url, body, opts) {
    const r = await this.post(url, body, opts);
    if (r.status === 302) return { ...(await this.get(r.location)), redirectedTo: r.location };
    return r;
  }
}

module.exports = { startApp, Client };
