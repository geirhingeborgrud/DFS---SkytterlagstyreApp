'use strict';

/** Dekoder bytes som UTF-8, og faller tilbake til Windows-1252 (typisk Excel-eksport). */
function decode(buf) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^﻿/, '');
  } catch {
    return new TextDecoder('windows-1252').decode(buf);
  }
}

/** Enkel CSV-parser med støtte for anførselstegn. Oppdager ; , eller tab som skilletegn. */
function parseCsv(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const counts = [';', ',', '\t'].map((d) => [d, firstLine.split(d).length]);
  const delim = counts.sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

function norm(h) {
  return h.toLowerCase().replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'a').replace(/[^a-z0-9]/g, '');
}

const HEADER_MAP = {
  shooter_id: ['skytterid', 'skytternr', 'skytternummer', 'medlemsnr', 'medlemsnummer', 'personid', 'id'],
  first_name: ['fornavn'],
  last_name: ['etternavn'],
  name: ['navn', 'fulltnavn'],
  birth_date: ['fodselsdato', 'fodt', 'fodselsdag'],
  email: ['epost', 'epostadresse', 'email', 'mail'],
  phone: ['mobil', 'mobilnr', 'telefon', 'tlf', 'mobiltelefon'],
  address: ['adresse', 'gateadresse'],
  postal_code: ['postnr', 'postnummer'],
  city: ['poststed', 'sted'],
  class: ['klasse', 'skytterklasse'],
};

function toIsoDate(s) {
  if (!s) return null;
  s = s.trim();
  let m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return null;
}

/**
 * Gjør om en medlemsliste (CSV eksportert fra MittDFS eller regneark) til medlemsobjekter.
 * Returnerer { members, unknownHeaders }.
 */
function membersFromCsv(buf) {
  const rows = parseCsv(decode(buf));
  if (rows.length < 2) return { members: [], unknownHeaders: [] };
  const headers = rows[0].map(norm);
  const col = {};
  const unknownHeaders = [];
  headers.forEach((h, i) => {
    const key = Object.keys(HEADER_MAP).find((k) => HEADER_MAP[k].includes(h));
    if (key && col[key] === undefined) col[key] = i;
    else if (!key) unknownHeaders.push(rows[0][i]);
  });
  const get = (r, k) => (col[k] !== undefined ? (r[col[k]] || '').trim() || null : null);
  const members = [];
  for (const r of rows.slice(1)) {
    let first = get(r, 'first_name');
    let last = get(r, 'last_name');
    const name = get(r, 'name');
    if ((!first || !last) && name) {
      if (name.includes(',')) { [last, first] = name.split(',').map((s) => s.trim()); }
      else { const p = name.split(/\s+/); last = p.length > 1 ? p.pop() : ''; first = p.join(' '); }
    }
    if (!first && !last) continue;
    members.push({
      shooter_id: get(r, 'shooter_id'),
      first_name: first || '',
      last_name: last || '',
      birth_date: toIsoDate(get(r, 'birth_date')),
      email: get(r, 'email'),
      phone: get(r, 'phone'),
      address: get(r, 'address'),
      postal_code: get(r, 'postal_code'),
      city: get(r, 'city'),
      class: get(r, 'class'),
    });
  }
  return { members, unknownHeaders };
}

module.exports = { parseCsv, membersFromCsv, toIsoDate, decode };
