'use strict';
const { fullName } = require('./helpers');

const TYPES = {
  styremote: { label: 'Styremøte', cls: 'ev-mote' },
  arsmote: { label: 'Årsmøte', cls: 'ev-arsmote' },
  trening: { label: 'Trening', cls: 'ev-trening' },
  stevne: { label: 'Stevne', cls: 'ev-stevne' },
  frist: { label: 'Frist', cls: 'ev-frist' },
};

/** Alle hendelser mellom from og to (inklusive, YYYY-MM-DD), sortert. */
function eventsBetween(db, from, to, { types } = {}) {
  const want = (t) => !types || types.includes(t);
  const ev = [];
  if (want('styremote') || want('arsmote')) {
    for (const m of db.prepare("SELECT * FROM meetings WHERE substr(starts_at,1,10) BETWEEN ? AND ? AND status != 'avlyst'").all(from, to)) {
      if (!want(m.type)) continue;
      ev.push({ date: m.starts_at.slice(0, 10), time: m.starts_at.slice(11, 16), title: m.title, type: m.type,
        url: `/${m.type === 'arsmote' ? 'arsmoter' : 'moter'}/${m.id}`, meet: m.meet_url });
    }
  }
  if (want('trening')) {
    for (const t of db.prepare('SELECT * FROM trainings WHERE date BETWEEN ? AND ?').all(from, to)) {
      ev.push({ date: t.date, time: t.start_time, title: t.title, type: 'trening', url: `/treninger/${t.id}` });
    }
  }
  if (want('stevne')) {
    for (const c of db.prepare('SELECT * FROM competitions WHERE date <= ? AND COALESCE(end_date, date) >= ?').all(to, from)) {
      // Flerdagersstevner vises hver dag
      let d = c.date < from ? from : c.date;
      const end = (c.end_date || c.date) > to ? to : (c.end_date || c.date);
      while (d <= end) {
        ev.push({ date: d, time: null, title: c.name, type: 'stevne', url: `/stevner/${c.id}` });
        d = addDays(d, 1);
      }
    }
    for (const c of db.prepare('SELECT * FROM competitions WHERE signup_deadline BETWEEN ? AND ?').all(from, to)) {
      ev.push({ date: c.signup_deadline, time: null, title: `Påmeldingsfrist: ${c.name}`, type: 'frist', url: `/stevner/${c.id}` });
    }
  }
  if (want('frist')) {
    for (const t of db.prepare(`SELECT t.*, u.name AS assignee FROM tasks t LEFT JOIN users u ON u.id = t.assignee_id
                                WHERE t.status != 'ferdig' AND t.due_date BETWEEN ? AND ?`).all(from, to)) {
      ev.push({ date: t.due_date, time: null, title: t.title + (t.assignee ? ` (${t.assignee})` : ''), type: 'frist', url: '/oppgaver' });
    }
  }
  return ev.sort((a, b) => (a.date + (a.time || '')).localeCompare(b.date + (b.time || '')));
}

function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Bygger månedsrutenett (uker som starter mandag) med hendelser per dag. */
function monthGrid(db, year, month, opts) {
  const first = `${year}-${String(month).padStart(2, '0')}-01`;
  const dow = (new Date(`${first}T12:00:00Z`).getUTCDay() + 6) % 7; // 0 = mandag
  const start = addDays(first, -dow);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;
  const endDow = (new Date(`${last}T12:00:00Z`).getUTCDay() + 6) % 7;
  const end = addDays(last, 6 - endDow);
  const events = eventsBetween(db, start, end, opts);
  const weeks = [];
  let d = start;
  while (d <= end) {
    const week = [];
    for (let i = 0; i < 7; i++) {
      week.push({ date: d, day: Number(d.slice(8, 10)), inMonth: Number(d.slice(5, 7)) === month, events: events.filter((e) => e.date === d) });
      d = addDays(d, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

// ---- Google Kalender / ICS ------------------------------------------------

function compact(localIso) {
  // "2026-11-20T18:00" -> "20261120T180000"
  return localIso.replace(/[-:]/g, '').slice(0, 13) + '00';
}

function defaultEnd(startsAt, endsAt, hours = 2) {
  if (endsAt) return endsAt;
  const [date, time] = startsAt.split('T');
  const [h, m] = time.split(':').map(Number);
  const total = h * 60 + m + hours * 60;
  const endDate = total >= 1440 ? addDays(date, 1) : date;
  const t = total % 1440;
  return `${endDate}T${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/**
 * Lenke som åpner «Ny hendelse» i Google Kalender med tid, sted, beskrivelse og gjester ferdig utfylt.
 * I Google Kalender kan man så trykke «Legg til videokonferanse i Google Meet» og lagre – gjestene får invitasjon.
 */
function googleCalendarUrl({ title, startsAt, endsAt, location, details, guests }) {
  const p = new URLSearchParams({
    action: 'TEMPLATE',
    text: title,
    dates: `${compact(startsAt)}/${compact(defaultEnd(startsAt, endsAt))}`,
    ctz: 'Europe/Oslo',
  });
  if (location) p.set('location', location);
  if (details) p.set('details', details);
  if (guests && guests.length) p.set('add', guests.join(','));
  return `https://calendar.google.com/calendar/render?${p.toString()}`;
}

function icsEscape(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/[,;]/g, (c) => `\\${c}`);
}
function fold(line) {
  const out = [];
  while (line.length > 74) { out.push(line.slice(0, 74)); line = ' ' + line.slice(74); }
  out.push(line);
  return out.join('\r\n');
}

/** iCalendar-fil (.ics) for ett møte, med deltakere. Kan importeres i Outlook, Apple og Google Kalender. */
function meetingIcs({ uid, title, startsAt, endsAt, location, details, url, organizer, attendees }) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Skytterlag styreapp//NO', 'CALSCALE:GREGORIAN', 'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${stamp}`,
    `DTSTART;TZID=Europe/Oslo:${compact(startsAt)}`,
    `DTEND;TZID=Europe/Oslo:${compact(defaultEnd(startsAt, endsAt))}`,
    `SUMMARY:${icsEscape(title)}`,
  ];
  if (location) lines.push(`LOCATION:${icsEscape(location)}`);
  if (details) lines.push(`DESCRIPTION:${icsEscape(details)}`);
  if (url) lines.push(`URL:${url}`);
  if (organizer) lines.push(`ORGANIZER;CN=${icsEscape(organizer.name)}:mailto:${organizer.email}`);
  for (const a of attendees || []) {
    lines.push(`ATTENDEE;CN=${icsEscape(a.name)};ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${a.email}`);
  }
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

function attendeeList(db, meetingId) {
  return db.prepare(`SELECT m.* FROM members m JOIN meeting_attendees a ON a.member_id = m.id
                     WHERE a.meeting_id = ? ORDER BY m.last_name, m.first_name`).all(meetingId)
    .map((m) => ({ ...m, name: fullName(m) }));
}

module.exports = { TYPES, eventsBetween, monthGrid, addDays, googleCalendarUrl, meetingIcs, defaultEnd, attendeeList };
