import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTasks, bucketFor } from './parser.js';

// Wednesday 30 Sep 2026, 12:00 local. Week = Mon 28 Sep … Sun 4 Oct.
const NOW = new Date(2026, 8, 30, 12, 0, 0);
const one = (text, now = NOW) => {
  const r = parseTasks(text, now);
  assert.equal(r.length, 1, `expected 1 task for ${JSON.stringify(text)}, got ${JSON.stringify(r)}`);
  return r[0];
};
const T = (title, due = null, time = null) => ({ title, due, time });

test('the full example brain dump', () => {
  const text =
    'buy milk tomorrow, call mum Friday, submit report by 5 Oct, dentist next Tuesday at 3pm and renew passport end of month';
  assert.deepEqual(parseTasks(text, NOW), [
    T('Buy milk', '2026-10-01'),
    T('Call mum', '2026-10-02'),
    T('Submit report', '2026-10-05'),
    T('Dentist', '2026-10-06', '15:00'),
    T('Renew passport', '2026-09-30'),
  ]);
});

test('empty / whitespace / non-string input gives []', () => {
  assert.deepEqual(parseTasks('', NOW), []);
  assert.deepEqual(parseTasks('  \n , ; ', NOW), []);
  assert.deepEqual(parseTasks(undefined, NOW), []);
});

test('no date => due null, title capitalised', () => {
  assert.deepEqual(one('water the plants'), T('Water the plants'));
});

test('today', () => assert.deepEqual(one('pay rent today'), T('Pay rent', '2026-09-30')));

test('tonight implies pm for bare hours', () =>
  assert.deepEqual(one('movie tonight at 8'), T('Movie', '2026-09-30', '20:00')));

test('tomorrow', () => assert.deepEqual(one('Tomorrow: file taxes'), T('File taxes', '2026-10-01')));

test('weekday: bare, this, on', () => {
  assert.deepEqual(one('call mum Friday'), T('Call mum', '2026-10-02'));
  assert.deepEqual(one('gym this Saturday'), T('Gym', '2026-10-03'));
  assert.deepEqual(one('haircut on monday'), T('Haircut', '2026-10-05'));
});

test('weekday same as today means today; "next" same weekday means next week', () => {
  assert.deepEqual(one('standup wednesday'), T('Standup', '2026-09-30'));
  assert.deepEqual(one('standup next wednesday'), T('Standup', '2026-10-07'));
});

test('next <weekday> is in next Mon–Sun week', () => {
  assert.equal(one('review next Monday').due, '2026-10-05');
  assert.equal(one('review next Friday').due, '2026-10-09');
  assert.equal(one('review next Tuesday').due, '2026-10-06');
});

test('abbreviated weekday with lead word', () =>
  assert.deepEqual(one('lunch on fri'), T('Lunch', '2026-10-02')));

test('in N days / weeks / months, incl. word numbers', () => {
  assert.deepEqual(one('gym in 3 days'), T('Gym', '2026-10-03'));
  assert.deepEqual(one('send invoice in 2 weeks'), T('Send invoice', '2026-10-14'));
  assert.deepEqual(one('follow up in a month'), T('Follow up', '2026-10-30'));
  assert.deepEqual(one('call back in two days'), T('Call back', '2026-10-02'));
});

test('in 1 month clamps to month end', () =>
  assert.equal(one('x in 1 month', new Date(2026, 0, 31)).due, '2026-02-28'));

test('next week => Monday; next month => the 1st', () => {
  assert.deepEqual(one('plan trip next week'), T('Plan trip', '2026-10-05'));
  assert.deepEqual(one('review budget next month'), T('Review budget', '2026-10-01'));
});

test('next month from mid-month', () =>
  assert.equal(one('x next month', new Date(2026, 9, 15)).due, '2026-11-01'));

test('end of week => Friday; end of month; end of next month', () => {
  assert.deepEqual(one('finish deck end of week'), T('Finish deck', '2026-10-02'));
  assert.deepEqual(one('renew passport end of month'), T('Renew passport', '2026-09-30'));
  assert.equal(one('x end of the month', new Date(2026, 1, 3)).due, '2026-02-28');
  assert.equal(one('x end of next month').due, '2026-10-31');
});

test('end of week on a weekend does not go into the past', () =>
  assert.equal(one('x end of week', new Date(2026, 9, 3)).due, '2026-10-03'));

test('month-name dates: 5 Oct, Oct 5, October 5th, 5th of October', () => {
  assert.deepEqual(one('submit report by 5 Oct'), T('Submit report', '2026-10-05'));
  assert.deepEqual(one('Oct 5 submit report'), T('Submit report', '2026-10-05'));
  assert.deepEqual(one('submit report October 5th'), T('Submit report', '2026-10-05'));
  assert.deepEqual(one('submit report on the 5th of October'), T('Submit report', '2026-10-05'));
});

test('month-name date with explicit year; comma not treated as split', () => {
  assert.deepEqual(parseTasks('wedding Dec 12, 2027', NOW), [T('Wedding', '2027-12-12')]);
});

test('month/day already past this year rolls to next year', () =>
  assert.deepEqual(one('birthday party 3 Mar'), T('Birthday party', '2027-03-03')));

test('today as month-day stays this year', () =>
  assert.equal(one('x Sep 30').due, '2026-09-30'));

test('numeric dates are US month/day', () => {
  assert.deepEqual(one('rent due 10/5'), T('Rent', '2026-10-05'));
  assert.deepEqual(one('party 12/25/2026'), T('Party', '2026-12-25'));
  assert.deepEqual(one('x 1/2'), T('X', '2027-01-02'));
});

test('times: 3pm, 3:30pm, 15:00, noon, midnight, 12am', () => {
  assert.equal(one('call at 3pm tomorrow').time, '15:00');
  assert.equal(one('call 3:30 PM tomorrow').time, '15:30');
  assert.equal(one('call tomorrow at 15:00').time, '15:00');
  assert.equal(one('lunch tomorrow at noon').time, '12:00');
  assert.equal(one('x tomorrow 12am').time, '00:00');
  assert.equal(one('x tomorrow 12pm').time, '12:00');
});

test('time is stripped from title along with its preposition', () =>
  assert.deepEqual(one('dentist next Tuesday at 3pm'), T('Dentist', '2026-10-06', '15:00')));

test('time with no date means today if still ahead, tomorrow if passed', () => {
  assert.deepEqual(one('call dentist at 3pm'), T('Call dentist', '2026-09-30', '15:00'));
  assert.deepEqual(one('call dentist at 9am'), T('Call dentist', '2026-10-01', '09:00'));
});

test('split on newlines, bullets and numbers', () => {
  const text = '- buy milk\n* call mum Friday\n1. pay rent\n2) walk dog\n• water plants';
  assert.deepEqual(parseTasks(text, NOW).map((t) => t.title), [
    'Buy milk', 'Call mum', 'Pay rent', 'Walk dog', 'Water plants',
  ]);
  assert.equal(parseTasks(text, NOW)[1].due, '2026-10-02');
});

test('split on semicolons and commas', () => {
  assert.deepEqual(parseTasks('call mum; email Bob, book flights', NOW).map((t) => t.title), [
    'Call mum', 'Email Bob', 'Book flights',
  ]);
});

test('split on " and " + verb, and on "then"', () => {
  assert.deepEqual(parseTasks('walk the dog and feed the cat', NOW).map((t) => t.title), [
    'Walk the dog', 'Feed the cat',
  ]);
  assert.deepEqual(parseTasks('email boss then book flights', NOW).map((t) => t.title), [
    'Email boss', 'Book flights',
  ]);
});

test("don't split 'salt and pepper' style titles", () => {
  assert.deepEqual(one('buy salt and pepper'), T('Buy salt and pepper'));
  assert.deepEqual(one('mac and cheese for dinner tomorrow'), T('Mac and cheese for dinner', '2026-10-01'));
  assert.deepEqual(one('call mum and dad on Friday'), T('Call mum and dad', '2026-10-02'));
});

test('shopping lists with commas stay as one task', () =>
  assert.deepEqual(one('buy milk, eggs, bread tomorrow'), T('Buy milk, eggs, bread', '2026-10-01')));

test('dangling date fragment attaches to previous task', () =>
  assert.deepEqual(parseTasks('dentist, next Tuesday at 3pm', NOW), [T('Dentist', '2026-10-06', '15:00')]));

test('each task gets its own date', () => {
  const r = parseTasks('call mum tomorrow; pay rent 10/5\nbook flights', NOW);
  assert.deepEqual(r, [T('Call mum', '2026-10-01'), T('Pay rent', '2026-10-05'), T('Book flights')]);
});

test('filler words are stripped from the start', () =>
  assert.deepEqual(one('remind me to call mum tomorrow'), T('Call mum', '2026-10-01')));

test('year boundary: tomorrow on Dec 31', () =>
  assert.equal(one('x tomorrow', new Date(2026, 11, 31)).due, '2027-01-01'));

test('Sunday belongs to the week that started the previous Monday', () => {
  const sun = new Date(2026, 9, 4, 9, 0); // Sun 4 Oct
  assert.equal(one('x monday', sun).due, '2026-10-05');
  assert.equal(one('x next week', sun).due, '2026-10-05');
});

test('bucketFor: each bucket', () => {
  assert.equal(bucketFor('2026-09-29', NOW), 'overdue');
  assert.equal(bucketFor('2025-01-01', NOW), 'overdue');
  assert.equal(bucketFor('2026-09-30', NOW), 'today');
  assert.equal(bucketFor('2026-10-01', NOW), 'tomorrow');
  assert.equal(bucketFor('2026-10-03', NOW), 'this-week');
  assert.equal(bucketFor('2026-10-04', NOW), 'this-week'); // Sunday
  assert.equal(bucketFor('2026-10-05', NOW), 'next-week'); // Monday
  assert.equal(bucketFor('2026-10-11', NOW), 'next-week');
  assert.equal(bucketFor('2026-10-12', NOW), 'later');
  assert.equal(bucketFor(null, NOW), 'no-date');
  assert.equal(bucketFor('', NOW), 'no-date');
  assert.equal(bucketFor('garbage', NOW), 'no-date');
});

test('bucketFor: tomorrow on a Sunday is next-week-Monday => "tomorrow" wins', () =>
  assert.equal(bucketFor('2026-10-05', new Date(2026, 9, 4)), 'tomorrow'));

test('bucketFor ignores time of day', () => {
  assert.equal(bucketFor('2026-09-30', new Date(2026, 8, 30, 23, 59)), 'today');
  assert.equal(bucketFor('2026-09-30', new Date(2026, 8, 30, 0, 0)), 'today');
});

test('works under another process timezone (local calendar day is used)', () => {
  const r = parseTasks('x tomorrow', new Date(2026, 5, 15, 23, 30));
  assert.equal(r[0].due, '2026-06-16');
});

/* ───────── follow-up: sentences, yesterday/last <weekday>, day-of-month, recent past dates ───────── */

test('sentences split into separate tasks, no trailing period, no over-split on "and"', () => {
  const r = parseTasks(
    'Send out the email to Grok. Upload all the fellows to one list in Outlook and bundle them under a list so I can easily text them.',
    NOW
  );
  assert.deepEqual(r, [
    T('Send out the email to Grok'),
    T('Upload all the fellows to one list in Outlook and bundle them under a list so I can easily text them'),
  ]);
});

test('! and ? also end a sentence', () => {
  assert.deepEqual(parseTasks('Call mum! Book flights? Pay rent', NOW).map((t) => t.title), [
    'Call mum', 'Book flights', 'Pay rent',
  ]);
});

test('sentence split keeps each sentence\'s own date', () => {
  assert.deepEqual(parseTasks('Buy milk tomorrow. Call mum Friday.', NOW), [
    T('Buy milk', '2026-10-01'), T('Call mum', '2026-10-02'),
  ]);
});

test('no sentence split on a.m./p.m., Mr., decimals, times, initials', () => {
  assert.deepEqual(one('Meet Mr. Smith at 9 a.m. tomorrow'), T('Meet Mr. Smith', '2026-10-01', '09:00'));
  assert.deepEqual(one('Pay the 3.30 fee'), T('Pay the 3.30 fee'));
  assert.deepEqual(one('Email Dr. Jones about v2.0 release'), T('Email Dr. Jones about v2.0 release'));
  assert.deepEqual(one('Call J. Doe'), T('Call J. Doe'));
  assert.deepEqual(one('Ship it e.g. today'), T('Ship it e.g.', '2026-09-30'));
});

test('yesterday is overdue', () => {
  const t = one('pay rent yesterday');
  assert.deepEqual(t, T('Pay rent', '2026-09-29'));
  assert.equal(bucketFor(t.due, NOW), 'overdue');
});

test('last <weekday> is the most recent past one', () => {
  assert.deepEqual(one('call Bob last Friday'), T('Call Bob', '2026-09-25'));
  assert.equal(one('x last wednesday').due, '2026-09-23'); // same weekday as today -> a week ago
  assert.equal(one('x last tuesday').due, '2026-09-29');
  assert.equal(bucketFor(one('x last monday').due, NOW), 'overdue');
});

test('"on the 1st" / "the 15th" -> next occurrence of that day of month', () => {
  assert.deepEqual(one('dentist on the 1st'), T('Dentist', '2026-10-01'));
  assert.deepEqual(one('haircut the 15th'), T('Haircut', '2026-10-15'));
  assert.deepEqual(one('pay bill by the 30th'), T('Pay bill', '2026-09-30')); // today counts
  assert.deepEqual(one('rent on the 29th'), T('Rent', '2026-10-29'));      // 29th already passed
});

test('day-of-month skips months that lack the day', () =>
  assert.equal(one('x on the 31st', new Date(2026, 8, 30)).due, '2026-10-31'));

test('"5th of October" still wins over day-of-month rule', () =>
  assert.deepEqual(one('report on the 5th of October'), T('Report', '2026-10-05')));

test('recent past numeric/month dates stay in the current year (overdue)', () => {
  assert.deepEqual(one('call bank 9/20'), T('Call bank', '2026-09-20'));
  assert.deepEqual(one('send form Sep 10'), T('Send form', '2026-09-10'));
  assert.deepEqual(one('x 1 Sep').due, '2026-09-01'); // earlier this month
  assert.equal(bucketFor('2026-09-20', NOW), 'overdue');
});

test('older month/day (not this month, >14 days ago) still rolls to next year', () => {
  assert.equal(one('x 3 Mar').due, '2027-03-03');
  assert.equal(one('x 8/1').due, '2027-08-01');
});

test('early January: a late-December date is last year (overdue)', () =>
  assert.equal(one('x Dec 28', new Date(2027, 0, 5)).due, '2026-12-28'));
