// parser.js — turn a free-form brain dump into tasks.
// Pure, dependency-free ES module; works in the browser and in Node.
//
//   parseTasks(text, now = new Date()) -> [{ title, due: 'YYYY-MM-DD'|null, time: 'HH:MM'|null, tags: string[] }]
//   bucketFor(dueISO, now = new Date()) -> 'overdue'|'today'|'tomorrow'|'this-week'|'next-week'|'later'|'no-date'
//
// "Today" is taken from the *local* calendar fields of `now` (the user is in
// America/New_York, so the browser's local time is the right clock). Weeks run
// Monday–Sunday. Numeric dates are US month/day.
//
// Weekdays:
//   "Wednesday", "this Wednesday", "on Wednesday", "by Wednesday"
//       the upcoming one. Today counts when today is that weekday.
//   "next Wednesday" (also "next wed", "by next Wednesday")
//       that weekday in the next Mon–Sun week, not "next week".
//       "next" is never thrown away so the date can fall back to Monday.
//       Friday 2 Oct 2026 → Wednesday 7 Oct 2026 (week of Mon 5–Sun 11 Oct).
//       Wednesday 14 Oct is the week after that.
//   "next week" with no weekday → Monday of next week, on purpose.
//   "next week" plus a weekday ("next week on Wednesday") → that weekday.
//
// Tasks are split only at a sentence-ending full stop. Commas, semicolons,
// "and" / "then" / "also", bullets, dashes, "?" / "!", and line breaks do not
// split (a line break is a space). A "." inside a decimal, a time (3.30pm,
// 10.15), an abbreviation (Dr. Mr. Mrs. St. etc. e.g. i.e. a.m. p.m.), an
// initial, a URL, an email, a file name, or an ellipsis ("...") is not a
// sentence end. Text with no final full stop is still one task. Empty chunks
// are dropped. Inside a chunk, only the recognised date/time phrase is removed.
// A #word (letters, digits, - or _, and at least one letter) is a tag: it is
// taken off the title, lowercased, and returned in tags. #1 / #123 are not tags.
// A # that is not at the start or after a space (URLs, emails, C#) is left as-is.

const DAY_MS = 86400000;

/* ───────────────────────── date helpers (UTC-midnight Dates) ───────────────────────── */

const pad = (n) => String(n).padStart(2, '0');
const toISO = (d) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const utc = (y, m, d) => new Date(Date.UTC(y, m, d)); // m is 0-based
const todayOf = (now) => utc(now.getFullYear(), now.getMonth(), now.getDate());
const addDays = (d, n) => new Date(d.getTime() + n * DAY_MS);
const mondayIdx = (d) => (d.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
const mondayOf = (d) => addDays(d, -mondayIdx(d));
const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

function addMonths(d, n) {
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + n;
  const y = Math.floor(total / 12);
  const m = total % 12;
  return utc(y, m, Math.min(d.getUTCDate(), daysInMonth(y, m)));
}

function validYMD(y, m, d) {
  if (m < 0 || m > 11 || d < 1) return false;
  return d <= daysInMonth(y, m);
}

function parseISODate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  if (!m) return null;
  const y = +m[1], mo = +m[2] - 1, d = +m[3];
  return validYMD(y, mo, d) ? utc(y, mo, d) : null;
}

/**
 * Month/day without a year. Upcoming dates use this year; dates that just
 * passed (earlier this month, or within ~14 days) stay in the past (overdue);
 * anything older rolls to next year. Early January "Dec 28" means last year.
 */
function inferYear(today, m, d) {
  const y = today.getUTCFullYear();
  const cand = (yy) => (validYMD(yy, m, d) ? utc(yy, m, d) : null);
  const cur = cand(y);
  if (cur) {
    if (cur >= today) {
      const prev = cand(y - 1);
      if (prev && (today - prev) / DAY_MS <= 14) return prev;
      return cur;
    }
    if ((today - cur) / DAY_MS <= 14 || cur.getUTCMonth() === today.getUTCMonth()) return cur;
  }
  return cand(y + 1) || cur; // e.g. Feb 29 in a non-leap year
}

function fullYear(y) {
  y = +y;
  return y < 100 ? 2000 + y : y;
}

/* ───────────────────────── vocabulary ───────────────────────── */

const MONTH_RE =
  'january|february|march|april|may|june|july|august|september|october|november|december|' +
  'jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec';
const MONTHS = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
const monthIndex = (s) => MONTHS[s.slice(0, 3).toLowerCase()];

const WEEKDAY_FULL = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const WEEKDAY_FULL_RE = WEEKDAY_FULL.join('|');
// Short names need a lead word ("next wed", "by thu") so "sat down" is not a date.
const WEEKDAY_ABBR_RE = 'mon|tues|tue|wed|thurs|thur|thu|fri|sat|sun';
const WEEKDAY_ANY_RE = `${WEEKDAY_FULL_RE}|${WEEKDAY_ABBR_RE}`;
// Mon=0 … Sun=6
const weekdayIndex = (s) => {
  const p = s.slice(0, 3).toLowerCase();
  return ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].indexOf(p);
};

const NUM_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8,
  nine: 9, ten: 10, eleven: 11, twelve: 12,
};
const NUM_RE = '\\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve';
const toNum = (s) => (/^\d+$/.test(s) ? parseInt(s, 10) : NUM_WORDS[s.toLowerCase()]);

// Leading preposition(s) that belong to a date phrase and get stripped with it.
const LEAD = '(?:\\bdue\\s+)?(?:\\b(?:by|on|before|until|till|for)\\s+)?';
const TOD = '(?:\\s+(morning|afternoon|evening|night))?';
const pmWord = (w) => !!w && /^(afternoon|evening|night)$/i.test(w);

/* ───────────────────────── date phrase rules ───────────────────────── */
// Each rule: a regex (global, case-insensitive) and fn(match, ctx) -> {date, pm?} | null.

const fridayOfWeek = (today, next) => {
  const f = addDays(mondayOf(today), 4 + (next ? 7 : 0));
  return !next && f < today ? today : f;
};

const RULES = [
  {
    // 2026-10-05
    re: new RegExp(`${LEAD}\\b(\\d{4})-(\\d{2})-(\\d{2})\\b`, 'gi'),
    fn: (m) => {
      const y = +m[1], mo = +m[2] - 1, d = +m[3];
      return validYMD(y, mo, d) ? { date: utc(y, mo, d) } : null;
    },
  },
  {
    // [Friday,] October 5th[, 2026]
    re: new RegExp(
      `${LEAD}(?:\\b(?:${WEEKDAY_FULL_RE}),?\\s+)?\\b(${MONTH_RE})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?![\\d:/]|\\s*[ap]\\.?m\\b)(?:,?\\s+(\\d{4})\\b)?`,
      'gi'
    ),
    fn: (m, { today }) => {
      const mo = monthIndex(m[1]), d = +m[2];
      if (m[3]) {
        const y = +m[3];
        return validYMD(y, mo, d) ? { date: utc(y, mo, d) } : null;
      }
      const dt = inferYear(today, mo, d);
      return dt ? { date: dt } : null;
    },
  },
  {
    // [Friday,] [the] 5th [of] October[, 2026]
    re: new RegExp(
      `${LEAD}(?:\\b(?:${WEEKDAY_FULL_RE}),?\\s+)?(?:\\bthe\\s+)?\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTH_RE})\\b\\.?(?:,?\\s+(\\d{4})\\b)?`,
      'gi'
    ),
    fn: (m, { today }) => {
      const d = +m[1], mo = monthIndex(m[2]);
      if (m[3]) {
        const y = +m[3];
        return validYMD(y, mo, d) ? { date: utc(y, mo, d) } : null;
      }
      const dt = inferYear(today, mo, d);
      return dt ? { date: dt } : null;
    },
  },
  {
    // 10/5, 10/5/26, 10/5/2026 (US month/day)
    re: new RegExp(`${LEAD}(?<![\\d/])(\\d{1,2})/(\\d{1,2})(?:/(\\d{4}|\\d{2}))?(?![\\d/])`, 'gi'),
    fn: (m, { today }) => {
      let mo = +m[1] - 1, d = +m[2];
      if (mo > 11 && d >= 1 && d <= 12) [mo, d] = [d - 1, mo + 1]; // 25/12 is unambiguous
      if (m[3]) {
        const y = fullYear(m[3]);
        return validYMD(y, mo, d) ? { date: utc(y, mo, d) } : null;
      }
      if (mo < 0 || mo > 11) return null;
      const dt = inferYear(today, mo, d);
      return dt ? { date: dt } : null;
    },
  },
  {
    // "on the 1st", "the 15th", "by 3rd": next occurrence of that day of the month
    re: /(?:\b(?:due\s+)?(?:by|on|before|until|till|for)\s+(?:the\s+)?|\bthe\s+)\b(\d{1,2})(?:st|nd|rd|th)\b(?!\s+of\b)/gi,
    fn: (m, { today }) => {
      const d = +m[1];
      if (d < 1 || d > 31) return null;
      let y = today.getUTCFullYear(), mo = today.getUTCMonth();
      for (let i = 0; i < 14; i++) {
        if (validYMD(y, mo, d)) {
          const dt = utc(y, mo, d);
          if (dt >= today) return { date: dt };
        }
        if (++mo > 11) { mo = 0; y++; }
      }
      return null;
    },
  },
  {
    re: new RegExp(`${LEAD}\\bday\\s+after\\s+tomorrow\\b`, 'gi'),
    fn: (m, { today }) => ({ date: addDays(today, 2) }),
  },
  {
    re: new RegExp(`${LEAD}\\b(?:yesterday|yesterady|last\\s+night)\\b`, 'gi'),
    fn: (m, { today }) => ({ date: addDays(today, -1), pm: /night/i.test(m[0]) }),
  },
  {
    re: new RegExp(`${LEAD}\\b(?:tomorrow|tomorow|tmrw|tmr)\\b${TOD}`, 'gi'),
    fn: (m, { today }) => ({ date: addDays(today, 1), pm: pmWord(m[1]) }),
  },
  {
    re: new RegExp(`${LEAD}\\b(?:(today|tonight|tonite)|this\\s+(morning|afternoon|evening))\\b`, 'gi'),
    fn: (m, { today }) => ({
      date: today,
      pm: /^toni/i.test(m[1] || '') || pmWord(m[2]),
    }),
  },
  {
    // in 3 days / in 2 weeks / in a month
    re: new RegExp(`${LEAD}\\bin\\s+(${NUM_RE})\\s+(day|week|month|year)s?\\b`, 'gi'),
    fn: (m, { today }) => relative(today, toNum(m[1]), m[2]),
  },
  {
    // 3 days from now
    re: new RegExp(`${LEAD}\\b(${NUM_RE})\\s+(day|week|month|year)s?\\s+from\\s+(?:now|today)\\b`, 'gi'),
    fn: (m, { today }) => relative(today, toNum(m[1]), m[2]),
  },
  {
    // end of (the) (next) week/month/year/day, eow/eom/eod
    re: new RegExp(
      `${LEAD}(?:\\b(?:the\\s+)?end\\s+of\\s+(?:the\\s+)?(?:(next|this)\\s+)?(week|month|year|day)\\b|\\b(eow|eom|eoy|eod|cob)\\b)`,
      'gi'
    ),
    fn: (m, { today }) => {
      const unit = (m[2] || { eow: 'week', eom: 'month', eoy: 'year', eod: 'day', cob: 'day' }[m[3].toLowerCase()]).toLowerCase();
      const next = (m[1] || '').toLowerCase() === 'next';
      if (unit === 'day') return { date: today };
      if (unit === 'week') return { date: fridayOfWeek(today, next) };
      if (unit === 'month') {
        const base = addMonths(utc(today.getUTCFullYear(), today.getUTCMonth(), 1), next ? 1 : 0);
        return { date: utc(base.getUTCFullYear(), base.getUTCMonth(), daysInMonth(base.getUTCFullYear(), base.getUTCMonth())) };
      }
      return { date: utc(today.getUTCFullYear() + (next ? 1 : 0), 11, 31) };
    },
  },
  {
    // this weekend / next weekend / the weekend  -> Saturday
    re: new RegExp(`${LEAD}\\b(this|next|the)\\s+weekend\\b`, 'gi'),
    fn: (m, { today }) => {
      const next = m[1].toLowerCase() === 'next';
      const sat = addDays(mondayOf(today), 5 + (next ? 7 : 0));
      return { date: !next && sat < today ? today : sat };
    },
  },
  {
    // "next week on Wednesday" / "Wednesday next week" / "by next week wed".
    // The weekday wins. This stays above the plain "next week" rule so "next"
    // is not consumed and the date does not fall back to Monday.
    re: new RegExp(
      `${LEAD}\\b(?:next\\s+week(?:\\s*,)?(?:\\s+on)?\\s+(${WEEKDAY_ANY_RE})|(${WEEKDAY_ANY_RE})\\s*,?\\s*next\\s+week)\\b${TOD}`,
      'gi'
    ),
    fn: (m, { today }) => weekdayDate(today, m[1] || m[2], 'next', m[3]),
  },
  {
    // next week -> Monday of next week; next month -> 1st of next month.
    // Only the word "week"/"month". "next Wednesday" does not match here.
    re: new RegExp(`${LEAD}\\bnext\\s+(week|month)\\b`, 'gi'),
    fn: (m, { today }) => {
      if (m[1].toLowerCase() === 'week') return { date: addDays(mondayOf(today), 7) };
      return { date: addMonths(utc(today.getUTCFullYear(), today.getUTCMonth(), 1), 1) };
    },
  },
  {
    // this week -> Friday; this month -> last day
    re: new RegExp(`${LEAD}\\bthis\\s+(week|month)\\b`, 'gi'),
    fn: (m, { today }) => {
      if (m[1].toLowerCase() === 'week') return { date: fridayOfWeek(today, false) };
      const y = today.getUTCFullYear(), mo = today.getUTCMonth();
      return { date: utc(y, mo, daysInMonth(y, mo)) };
    },
  },
  {
    // [this|next] [coming] Friday [evening]
    re: new RegExp(
      `${LEAD}\\b(?:(this|next|last)\\s+)?(?:(?:coming|upcoming)\\s+)?(${WEEKDAY_FULL_RE})\\b${TOD}`,
      'gi'
    ),
    fn: (m, { today }) => weekdayDate(today, m[2], (m[1] || '').toLowerCase(), m[3]),
  },
  {
    // abbreviated weekdays only with a clear lead word: "on fri", "next tue", "by thu"
    re: new RegExp(`\\b(?:(this|next|last)\\s+|(?:due|on|by|before|until|till)\\s+)(${WEEKDAY_ABBR_RE})\\b\\.?`, 'gi'),
    fn: (m, { today }) => weekdayDate(today, m[2], (m[1] || '').toLowerCase(), null),
  },
];

function relative(today, n, unit) {
  if (!n) return null;
  unit = unit.toLowerCase();
  if (unit === 'day') return { date: addDays(today, n) };
  if (unit === 'week') return { date: addDays(today, 7 * n) };
  if (unit === 'month') return { date: addMonths(today, n) };
  return { date: addMonths(today, 12 * n) };
}

function weekdayDate(today, name, mode, tod) {
  const target = weekdayIndex(name);
  if (target < 0) return null;
  let date;
  if (mode === 'last') date = addDays(today, -(((mondayIdx(today) - target + 6) % 7) + 1)); // most recent past one
  else if (mode === 'next') date = addDays(mondayOf(today), 7 + target); // that weekday in the next Mon–Sun week
  else date = addDays(today, (target - mondayIdx(today) + 7) % 7); // upcoming; today if same day (bare/this/on/by)
  return { date, pm: pmWord(tod) };
}

function findDate(text, ctx) {
  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags);
    let m;
    while ((m = re.exec(text))) {
      const r = rule.fn(m, ctx);
      if (r && r.date) return { start: m.index, end: m.index + m[0].length, date: r.date, pm: !!r.pm };
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return null;
}

/* ───────────────────────── time phrase rules ───────────────────────── */

const TLEAD = '(?:(?:\\bat|\\bby|\\baround|\\bbefore|\\buntil|\\bfrom)\\s*|@\\s*)?';

const TIME_RULES = [
  {
    re: new RegExp(`${TLEAD}\\b(noon|midday|midnight)\\b`, 'gi'),
    fn: (m) => (/^midnight$/i.test(m[1]) ? '00:00' : '12:00'),
  },
  {
    re: new RegExp(`${TLEAD}\\b(\\d{1,2})(?:[:.](\\d{2}))?\\s*([ap])\\.?m\\b\\.?`, 'gi'),
    fn: (m) => {
      let h = +m[1];
      const min = m[2] ? +m[2] : 0;
      if (h < 1 || h > 12 || min > 59) return null;
      if (/^p$/i.test(m[3])) h = h === 12 ? 12 : h + 12;
      else h = h === 12 ? 0 : h;
      return `${pad(h)}:${pad(min)}`;
    },
  },
  {
    re: new RegExp(`${TLEAD}\\b(\\d{1,2}):(\\d{2})\\b(?!\\s*[ap]\\.?m\\b)`, 'gi'),
    fn: (m) => {
      const h = +m[1], min = +m[2];
      return h > 23 || min > 59 ? null : `${pad(h)}:${pad(min)}`;
    },
  },
  {
    // bare "at 5": 1–6 -> pm, 7–11 -> am, 12 -> noon (pm if the day phrase said evening/tonight)
    re: /\bat\s+(\d{1,2})\b(?![:/\d.]|\s*[A-Za-z])/gi,
    fn: (m, pm) => {
      let h = +m[1];
      if (h < 1 || h > 23) return null;
      if (h <= 12) {
        if (pm && h < 12) h += 12;
        else if (!pm && h >= 1 && h <= 6) h += 12;
      }
      return `${pad(h)}:00`;
    },
  },
];

function findTime(text, pm) {
  for (const rule of TIME_RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags);
    let m;
    while ((m = re.exec(text))) {
      const t = rule.fn(m, pm);
      if (t) return { start: m.index, end: m.index + m[0].length, time: t };
      if (m[0].length === 0) re.lastIndex++;
    }
  }
  return null;
}

/* ───────────────────────── splitting ───────────────────────── */
// Titles like Dr./Mr./Mrs./St. The dotted forms e.g. / i.e. / a.m. / p.m.
// are handled too: the letter immediately before that final dot is one character.

const ABBREV = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'etc']);

/** True when the "." at index i ends a sentence, not a token. */
function isSentenceEnd(text, i) {
  if (text[i] !== '.') return false;
  if (text[i - 1] === '.' || text[i + 1] === '.') return false; // ellipsis, "..", "..."
  const next = text[i + 1];
  // Decimals (3.30), times (10.15), URLs, emails and file names keep their dot
  // inside the token, so it is not followed by whitespace.
  if (next !== undefined && !/\s/.test(next)) return false;
  const token = /([^\s.]*)$/.exec(text.slice(0, i))?.[1] || '';
  if (!token) return true; // a stray "." between spaces is an empty chunk boundary
  if (/^[A-Za-z]$/.test(token)) return false; // initial, or the last letter of e.g. / a.m.
  if (/^\d{1,3}$/.test(token)) return false; // "1." list marker, not a sentence
  if (ABBREV.has(token.toLowerCase())) return false;
  return true;
}

function hasWords(s) {
  return /[\p{L}\p{N}]/u.test(s);
}

function splitDump(text) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  if (!flat) return [];
  const parts = [];
  let start = 0;
  for (let i = 0; i < flat.length; i++) {
    if (!isSentenceEnd(flat, i)) continue;
    if (!/\S/.test(flat.slice(i + 1))) break; // no further sentence; keep this period for cleanup
    const chunk = flat.slice(start, i).trim();
    if (hasWords(chunk)) parts.push(chunk);
    start = i + 1;
  }
  const tail = flat.slice(start).trim();
  if (hasWords(tail)) parts.push(tail);
  return parts;
}

/* ───────────────────────── single-task parsing ───────────────────────── */

function cleanTitle(s) {
  let t = s.replace(/\s+/g, ' ').trim();
  // Drop a sentence-ending full stop only. Abbreviations, initials and "..." stay.
  if (t.endsWith('.') && isSentenceEnd(t, t.length - 1)) t = t.slice(0, -1).trim();
  t = t.replace(/\s+/g, ' ').trim();
  if (!hasWords(t)) return '';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

// #work, #uni-admin, #1a. Not #1 or #123. The character after the token must not
// continue the token, so a hyphen stays inside #uni-admin (a word boundary would not).
const HASH_TAG = /(^|\s)#([A-Za-z0-9_-]*[A-Za-z][A-Za-z0-9_-]*)(?![A-Za-z0-9_-])/g;

function takeTags(text) {
  const tags = [];
  const seen = new Set();
  const next = String(text).replace(HASH_TAG, (full, lead, raw) => {
    const name = raw.toLowerCase().slice(0, 40);
    if (!/[a-z]/.test(name)) return full;
    if (!seen.has(name)) {
      seen.add(name);
      tags.push(name);
    }
    return lead ? ' ' : '';
  });
  return { text: next, tags };
}

function parsePiece(piece, ctx) {
  const tagged = takeTags(piece);
  let text = tagged.text;
  const d = findDate(text, ctx);
  if (d) text = text.slice(0, d.start) + ' ' + text.slice(d.end);
  const t = findTime(text, d ? d.pm : false);
  if (t) text = text.slice(0, t.start) + ' ' + text.slice(t.end);
  return {
    title: cleanTitle(text),
    due: d ? toISO(d.date) : null,
    time: t ? t.time : null,
    tags: tagged.tags,
  };
}

/* ───────────────────────── public API ───────────────────────── */

/**
 * Parse a free-form brain dump into tasks.
 * @param {string} text
 * @param {Date} [now]
 * @returns {{title: string, due: string|null, time: string|null, tags: string[]}[]}
 */
export function parseTasks(text, now = new Date()) {
  if (typeof text !== 'string' || !text.trim()) return [];
  if (!(now instanceof Date) || isNaN(now)) now = new Date();
  const ctx = { today: todayOf(now) };
  const tasks = [];

  for (const piece of splitDump(text)) {
    const p = parsePiece(piece, ctx);
    if (p.title) tasks.push(p);
  }

  // A time with no date ("call dentist at 3pm") means today, or tomorrow if that time has passed.
  const nowMin = now.getHours() * 60 + now.getMinutes();
  for (const t of tasks) {
    if (t.time && !t.due) {
      const [h, m] = t.time.split(':').map(Number);
      t.due = toISO(h * 60 + m >= nowMin ? ctx.today : addDays(ctx.today, 1));
    }
  }
  return tasks;
}

/**
 * Which list bucket does a due date fall in? Weeks are Monday–Sunday.
 * @param {string|null|undefined} dueISO  'YYYY-MM-DD'
 * @param {Date} [now]
 * @returns {'overdue'|'today'|'tomorrow'|'this-week'|'next-week'|'later'|'no-date'}
 */
export function bucketFor(dueISO, now = new Date()) {
  const due = parseISODate(dueISO);
  if (!due) return 'no-date';
  if (!(now instanceof Date) || isNaN(now)) now = new Date();
  const today = todayOf(now);
  const diff = Math.round((due - today) / DAY_MS);
  if (diff < 0) return 'overdue';
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  const weekStart = mondayOf(today);
  if (due < addDays(weekStart, 7)) return 'this-week';
  if (due < addDays(weekStart, 14)) return 'next-week';
  return 'later';
}
