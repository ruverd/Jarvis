import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { SAFE, checkLink } from './safety.mjs';
import { runInput } from './secrets.mjs';
import { JarvisError } from './jarvis-work.mjs';

const email = /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9](?:[A-Z0-9.-]*[A-Z0-9])?\.[A-Z]{2,63}$/i;
const rcpts = (value) => value.split(',').map((s) => s.trim()).filter(Boolean);

export function mailDraft(raw) {
  const spoken = /^(.+?)\s*[,;]?\s+(?:assunto|subject)\s*[:;,]?\s+(.+?)\s*[,;]?\s+(?:mensagem|corpo|message|body)\s*[:;,]?\s+([\s\S]+)$/iu.exec(raw);
  const [to, subject, ...parts] = (spoken ? spoken.slice(1) : raw.split('|')).map((s) => s.trim());
  const body = parts.join(' | ');
  const recipients = rcpts(to.replace(/\s+(?:arroba|at)\s+/giu, '@').replace(/\s+(?:ponto|dot)\s+/giu, '.'));
  if (!recipients.length || recipients.length > 10 || recipients.some((s) => !email.test(s)) || !subject || /[\r\n]/.test(subject) || !body) return null;
  const url = 'mailto:' + recipients.map((s) => encodeURIComponent(s).replace('%40', '@')).join(',') + '?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
  return checkLink(url).level === SAFE ? { recipients, subject, body, url } : null;
}

function hourOf(value) {
  const m = /^(\d{1,2})(?:[:h](\d{2}))?\s*(am|pm)?$/i.exec(value);
  if (!m) return null;
  let hour = Number(m[1]), minute = Number(m[2] || '0');
  if (m[3]) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (m[3].toLowerCase() === 'pm' ? 12 : 0);
  }
  return hour > 23 || minute > 59 ? null : [hour, minute];
}

export function calendarDraft(raw, now = new Date()) {
  const [line, guests = ''] = raw.split('|', 2).map((s) => s.trim());
  const attendees = rcpts(guests);
  if (attendees.length > 15 || attendees.some((s) => !email.test(s))) return null;
  let m = /^(\d{4}-\d{2}-\d{2}|amanh[aã]|hoje|tomorrow|today)\s+(\d{1,2}(?:[:h]\d{2})?(?:\s*[ap]m)?)(?:\s+(\d+)m)?\s*:\s+(.+)$/iu.exec(line);
  let title, date, time, duration;
  if (m) [, date, time, duration, title] = m;
  else {
    m = /^(.+?)\s+(amanh[aã]|hoje|tomorrow|today|\d{4}-\d{2}-\d{2})\s+(?:[àa]s|at)\s+(\d{1,2}(?:[:h]\d{2})?(?:\s*[ap]m)?)\s*[.!?]?$/iu.exec(line);
    if (!m) return null;
    [, title, date, time] = m;
  }
  const timeParts = hourOf(time);
  if (!timeParts || !title || /[\r\n]/.test(title)) return null;
  const [h, min] = timeParts;
  const day = new Date(now);
  if (/^\d/.test(date)) {
    const [y, mon, d] = date.split('-').map(Number);
    day.setFullYear(y, mon - 1, d);
    if (day.getFullYear() !== y || day.getMonth() !== mon - 1 || day.getDate() !== d) return null;
  } else if (/^(?:amanh[aã]|tomorrow)$/iu.test(date)) day.setDate(day.getDate() + 1);
  day.setHours(h, min, 0, 0);
  if (day.getHours() !== h || day.getMinutes() !== min || day <= now) return null;
  duration = duration ? Number(duration) : 30;
  if (duration < 5 || duration > 720) return null;
  return { title: title.trim(), start: day.toISOString(), end: new Date(+day + duration * 60_000).toISOString(), zone: Intl.DateTimeFormat().resolvedOptions().timeZone, attendees };
}

const icsEscape = (s) => s.replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/[,;]/g, (c) => '\\' + c);
const icsDate = (s) => new Date(s).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
export function calendarFile(event) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Jarvis//Calendar//EN', 'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT', 'UID:' + randomUUID() + '@jarvis.local', 'DTSTAMP:' + icsDate(Date.now()),
    'DTSTART:' + icsDate(event.start), 'DTEND:' + icsDate(event.end), 'SUMMARY:' + icsEscape(event.title),
    ...event.attendees.map((address) => 'ATTENDEE:mailto:' + address), 'END:VEVENT', 'END:VCALENDAR', '',
  ].join('\r\n');
}

export async function createCalendarEntry(event, { hands, open }) {
  if (hands && !event.attendees.length) {
    const response = await runInput(hands, ['calendar-create'], JSON.stringify(event), 35_000);
    // A timeout or lost receipt can mean the save succeeded. The caller must not create a second copy.
    if (response.code !== 0) throw new JarvisError('O Calendário não confirmou a criação. Confira o evento antes de tentar de novo.', 'Calendar did not confirm creation. Check for the event before retrying.');
    const answer = JSON.parse(response.stdout.trim());
    if (answer.ok && answer.identifier) return { saved: true };
    if (!answer.permission) throw new JarvisError('O Calendário não conseguiu salvar o evento.', 'Calendar could not save the event.');
  }
  const folder = await mkdtemp(path.join(os.tmpdir(), 'jarvis-calendar-'));
  try {
    const file = path.join(folder, 'Evento Jarvis.ics');
    await writeFile(file, calendarFile(event), { mode: 0o600 });
    await open(file);
    setTimeout(() => { rm(folder, { recursive: true, force: true }).catch(() => {}); }, 600_000).unref();
    return { saved: false };
  } catch (error) { await rm(folder, { recursive: true, force: true }); throw error; }
}
