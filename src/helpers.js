'use strict';

const MONTHS = ['januar', 'februar', 'mars', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'desember'];
const ROLE_LABELS = { admin: 'Administrator', styre: 'Styremedlem', les: 'Kun lesetilgang' };
const TASK_STATUS = { apen: 'Åpen', pagar: 'Pågår', ferdig: 'Ferdig' };
const MEETING_STATUS = { planlagt: 'Planlagt', gjennomfort: 'Gjennomført', avlyst: 'Avlyst' };
// Verv i laget. Et medlem kan ha flere.
const BOARD_ROLES = {
  styreleder: 'Styreleder',
  nestleder: 'Nestleder',
  sekretar: 'Sekretær',
  kasserer: 'Kasserer',
  ungdomsleder: 'Ungdomsleder',
  vapenansvarlig: 'Våpenansvarlig',
  baneansvarlig: 'Baneansvarlig',
  styremedlem: 'Styremedlem',
  varamedlem: 'Varamedlem',
  revisor: 'Revisor',
  valgkomite: 'Valgkomité',
};
// Verv som regnes som en del av styret (vises i styreoversikten og inviteres til styremøter)
const BOARD_CORE = ['styreleder', 'nestleder', 'sekretar', 'kasserer', 'ungdomsleder', 'vapenansvarlig', 'baneansvarlig', 'styremedlem', 'varamedlem'];
const WEAPON_STATUS = { aktiv: 'På lager', utlant: 'Utlånt', service: 'Til service', avhendet: 'Avhendet' };
const AMMO_KIND = { kjop: 'Innkjøp', salg: 'Salg', justering: 'Justering' };

function parseDate(s) {
  if (!s) return null;
  // SQLite datetime('now') gir "YYYY-MM-DD HH:MM:SS" i UTC
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? s.replace(' ', 'T') + 'Z' : s;
  const d = new Date(iso);
  return isNaN(d) ? null : d;
}

const TZ = 'Europe/Oslo';
function fmtDate(s) {
  const d = parseDate(s);
  if (!d) return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(0, 4)}`;
  return d.toLocaleDateString('nb-NO', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric' });
}
function fmtDateTime(s) {
  const d = parseDate(s);
  if (!d) return '';
  return d.toLocaleString('nb-NO', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
/** Møtetidspunkt lagres som lokal tid "YYYY-MM-DDTHH:MM" (fra datetime-local). */
function fmtLocal(s) {
  if (!s) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(s);
  if (!m) return s;
  return `${m[3]}.${m[2]}.${m[1]} kl. ${m[4]}:${m[5]}`;
}
function fileSize(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} kB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
function today() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: TZ }); // YYYY-MM-DD
}
function str(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}
function int(v) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
}
function asArray(v) {
  if (v == null) return [];
  return Array.isArray(v) ? v : [v];
}
const WEEKDAYS = ['man', 'tir', 'ons', 'tor', 'fre', 'lør', 'søn'];
function fullName(m) { return m ? `${m.first_name} ${m.last_name}`.trim() : ''; }
function ageOn(birth, date) {
  if (!birth || !/^\d{4}-\d{2}-\d{2}/.test(birth)) return null;
  const [y, m, d] = birth.split('-').map(Number);
  const [Y, M, D] = date.split('-').map(Number);
  return Y - y - (M < m || (M === m && D < d) ? 1 : 0);
}
function money(n) {
  if (n == null) return '';
  return Number(n).toLocaleString('nb-NO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' kr';
}
const ONLINE_MS = 5 * 60 * 1000;
function isOnline(u) { return !!(u && u.last_seen && Date.now() - u.last_seen < ONLINE_MS); }
function caseNo(item) {
  return `${item.number}/${String(item.year).slice(-2)}`;
}

module.exports = {
  MONTHS, ROLE_LABELS, TASK_STATUS, MEETING_STATUS, BOARD_ROLES, BOARD_CORE, WEAPON_STATUS, AMMO_KIND,
  fullName, ageOn, money, isOnline, WEEKDAYS,
  fmtDate, fmtDateTime, fmtLocal, fileSize, today, str, int, asArray, caseNo,
};
