// parser.js — turn a free-form brain dump into tasks.
// Pure, dependency-free ES module; works in the browser and in Node.
//
//   parseTasks(text, now = new Date()) -> [{ title, due: 'YYYY-MM-DD'|null, time: 'HH:MM'|null }]
//   bucketFor(dueISO, now = new Date()) -> 'overdue'|'today'|'tomorrow'|'this-week'|'next-week'|'later'|'no-date'
//
// "Today" is taken from the *local* calendar fields of `now` (the user is in
// America/New_York, so the browser's local time is the right clock). Weeks run
// Monday–Sunday. Numeric dates are US month/day.

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

// Common task-leading verbs. Used to decide whether " and X" starts a new task
// ("buy milk and call mum" splits; "salt and pepper" / "mac and cheese" don't).
const VERBS = [
  'add', 'apply', 'ask', 'attend', 'back', 'bake', 'book', 'bring', 'build', 'buy', 'call', 'cancel',
  'change', 'charge', 'check', 'clean', 'clear', 'collect', 'complete', 'confirm', 'contact', 'cook',
  'create', 'cut', 'declutter', 'deliver', 'deploy', 'do', 'donate', 'download', 'draft', 'drop',
  'email', 'empty', 'feed', 'file', 'fill', 'find', 'finish', 'fix', 'fold', 'follow', 'get', 'go',
  'grab', 'iron', 'install', 'invite', 'join', 'learn', 'look', 'mail', 'make', 'meet', 'message',
  'mow', 'order', 'organise', 'organize', 'pack', 'paint', 'pay', 'phone', 'pick', 'plan', 'post',
  'practice', 'practise', 'prep', 'prepare', 'print', 'publish', 'put', 'read', 'recycle', 'refill',
  'register', 'remember', 'remind', 'renew', 'replace', 'reply', 'research', 'reschedule', 'respond',
  'return', 'review', 'ring', 'schedule', 'sell', 'send', 'set', 'setup', 'sign', 'sort', 'start',
  'study', 'submit', 'take', 'talk', 'tell', 'test', 'text', 'thank', 'tidy', 'throw', 'trim',
  'update', 'upload', 'vacuum', 'visit', 'walk', 'wash', 'watch', 'water', 'wrap', 'write',
];
const VERB_ALT = VERBS.join('|');
const AND_SPLIT_RE = new RegExp(`\\s+and\\s+(?=(?:${VERB_ALT})\\b)`, 'i');
const THEN_SPLIT_RE = /(?:^|[\s,])(?:and\s+then|then|after\s+that|afterwards)(?=\s|$)/i;
const STARTS_WITH_VERB_RE = new RegExp(`^(?:${VERB_ALT})\\b`, 'i');
// Shopping-style heads whose following bare nouns are list items: "buy milk, eggs, bread".
const LIST_HEAD_RE = /^(?:buy|get|grab|order|pick\s+up|pack|bring|need)\b/i;

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
    // next week -> Monday of next week; next month -> 1st of next month
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
    re: /\b(?:(this|next|last)\s+|(?:due|on|by|before|until|till)\s+)(mon|tues|tue|wed|thurs|thur|thu|fri|sat|sun)\b\.?/gi,
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
  else if (mode === 'next') date = addDays(mondayOf(today), 7 + target); // that weekday in next Mon–Sun week
  else date = addDays(today, (target - mondayIdx(today) + 7) % 7); // upcoming; today if same day
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
    re: new RegExp(`${TLEAD}\\b(\\d{1,2})(?::(\\d{2}))?\\s*([ap])\\.?m\\b\\.?`, 'gi'),
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

const BULLET_RE = /^\s*(?:(?:[-*+>–—]\s+)|(?:[•·▪●◦]\s*)|(?:\d{1,3}[.)]\s+)|(?:\[[ xX]?\]\s*))+/;

function splitCommas(part) {
  // split on commas followed by whitespace/end, but not "Oct 5, 2026" or "1,000"
  return part.split(/,(?=\s|$)(?!\s*\d{4}\b)/);
}

// Words whose trailing "." does not end a sentence.
const ABBREV_RE = /^(?:mr|mrs|ms|dr|prof|sr|jr|st|mt|vs|e\.g|i\.e|a\.m|p\.m|am|pm|approx|no|inc|ltd|co|[A-Za-z])$/;

// Split "Do this. Then that! Really?" into sentences, leaving "a.m.", "Mr.",
// "3.30", "J. Smith" alone.
function splitSentences(part) {
  const out = [];
  const re = /[.!?]+(?=\s+\S)/g;
  let start = 0, m;
  while ((m = re.exec(part))) {
    const end = m.index + m[0].length;
    if (m[0] === '.') {
      const word = /(\S+)$/.exec(part.slice(start, m.index))?.[1] || '';
      const w = word.replace(/^[("'\[]+/, '');
      if (ABBREV_RE.test(w.toLowerCase()) && (w.length > 1 || /[A-Z]/.test(w) || /^[ap]$/i.test(w))) {
        // "no." only counts as an abbreviation before a digit ("no. 5")
        if (!(/^no$/i.test(w) && !/^\s+\d/.test(part.slice(end)))) continue;
      }
    }
    out.push(part.slice(start, end));
    start = end;
  }
  out.push(part.slice(start));
  return out;
}

function splitDump(text) {
  const out = [];
  const lines = String(text).split(/\r?\n+/);
  for (let line of lines) {
    line = line.replace(BULLET_RE, '');
    for (const part of line.split(';').flatMap(splitSentences)) {
      let pieces = splitCommas(part).map((s) => s.trim()).filter(Boolean);
      pieces = joinListItems(pieces);
      for (const piece of pieces) {
        // split on "then" / "and then" / "after that"
        for (const chunk of piece.split(THEN_SPLIT_RE)) {
          // split on " and <verb>"
          for (const sub of chunk.split(AND_SPLIT_RE)) {
            const s = sub.trim();
            if (s) out.push(s);
          }
        }
      }
    }
  }
  return out;
}

// "buy milk, eggs, bread" -> one task, not three. Applies only when the head
// starts with a shopping-style verb and the following bits are short, verb-less
// and (unless the list is already under way) undated.
function joinListItems(pieces) {
  const ctx = { today: utc(2000, 0, 1) };
  const res = [];
  for (const p of pieces) {
    const prev = res[res.length - 1];
    const words = p.split(/\s+/).length;
    if (
      prev &&
      LIST_HEAD_RE.test(prev.replace(BULLET_RE, '')) &&
      words <= 3 &&
      !STARTS_WITH_VERB_RE.test(p) &&
      !/^(?:and|then|also|after)\b/i.test(p) &&
      // a date/time may ride on the last item of a list that already has 2+ items
      (prev.includes(',') || (!findDate(p, ctx) && !findTime(p, false)))
    ) {
      res[res.length - 1] = `${prev}, ${p}`;
    } else {
      res.push(p);
    }
  }
  return res;
}

/* ───────────────────────── single-task parsing ───────────────────────── */

const LEADING_FILLER_RE =
  /^(?:(?:and\s+then|and|then|also|plus|after\s+that)\s+)+|^(?:(?:please\s+)?remind\s+me\s+to|i\s+(?:need|have|got|want)\s+to|(?:we\s+)?need\s+to|don'?t\s+forget\s+to|remember\s+to|to-?do:?|todo:?)\s+/i;
const TRAILING_DANGLE_RE = /(?:\s+|^)(?:on|at|by|due|before|until|till|around|the|this|next|and|then|also)$/i;

function cleanTitle(s) {
  let t = s.replace(/\s+/g, ' ');
  for (let i = 0; i < 4; i++) {
    const before = t;
    t = t.replace(/\s+([,.;:!?])/g, '$1');
    t = t.replace(/^[\s,;:.\-–—]+|[\s,;:!?\-–—]+$/g, '');
    t = t.replace(/^[(\[]\s*[)\]]|[(\[]\s*[)\]]$/g, '').trim();
    t = t.replace(LEADING_FILLER_RE, '');
    t = t.replace(TRAILING_DANGLE_RE, '');
    t = t.replace(/,\s*,/g, ',');
    if (t === before) break;
  }
  t = t.replace(/[.]+$/, (m) => (/\b\w\.$/.test(t) ? m : '')).trim(); // drop sentence-final dots
  if (!/[\p{L}\p{N}]/u.test(t)) return '';
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function parsePiece(piece, ctx) {
  let text = piece;
  const d = findDate(text, ctx);
  if (d) text = text.slice(0, d.start) + ' ' + text.slice(d.end);
  const t = findTime(text, d ? d.pm : false);
  if (t) text = text.slice(0, t.start) + ' ' + text.slice(t.end);
  return {
    title: cleanTitle(text),
    due: d ? toISO(d.date) : null,
    time: t ? t.time : null,
  };
}

/* ───────────────────────── public API ───────────────────────── */

/**
 * Parse a free-form brain dump into tasks.
 * @param {string} text
 * @param {Date} [now]
 * @returns {{title: string, due: string|null, time: string|null}[]}
 */
export function parseTasks(text, now = new Date()) {
  if (typeof text !== 'string' || !text.trim()) return [];
  if (!(now instanceof Date) || isNaN(now)) now = new Date();
  const ctx = { today: todayOf(now) };
  const tasks = [];

  for (const piece of splitDump(text)) {
    const p = parsePiece(piece, ctx);
    if (p.title) {
      tasks.push(p);
    } else if (tasks.length && (p.due || p.time)) {
      // A fragment like "Friday" / "at 3pm" after a comma belongs to the previous task.
      const prev = tasks[tasks.length - 1];
      if (p.due && !prev.due) prev.due = p.due;
      if (p.time && !prev.time) prev.time = p.time;
    }
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
