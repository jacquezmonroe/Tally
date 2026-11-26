import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVoiceInput } from './voice.js';

test('explicit am time + "remind me to" prefix', () => {
  const result = parseVoiceInput('Remind me to take vitamins at 8am');
  assert.deepEqual(result, {
    name: 'Take vitamins',
    time: { hour: 8, minute: 0, matchedText: '8am' },
    recurrence: { type: 'once', matchedText: [] },
  });
});

test('explicit pm time rolls into 24h + literal "every day"', () => {
  const result = parseVoiceInput('Take medication every day at 9pm');
  assert.deepEqual(result, {
    name: 'Take medication',
    time: { hour: 21, minute: 0, matchedText: '9pm' },
    recurrence: { type: 'daily', matchedText: ['every day'] },
  });
});

test('"every <period>" implies daily with a vague default hour', () => {
  const result = parseVoiceInput('Stretch every morning');
  assert.deepEqual(result, {
    name: 'Stretch',
    time: { hour: 8, minute: 0, vague: true },
    recurrence: { type: 'daily', matchedText: ['every morning'] },
  });
});

test('a bare hour with no am/pm is a vague guess, not a blank time', () => {
  const result = parseVoiceInput('Take vitamins at 8');
  assert.deepEqual(result, {
    name: 'Take vitamins',
    time: { hour: 8, minute: 0, matchedText: '8', vague: true },
    recurrence: { type: 'once', matchedText: [] },
  });
});

test('a bare hour:minute with no am/pm is a vague guess', () => {
  const result = parseVoiceInput('Meeting at 8:30');
  assert.deepEqual(result, {
    name: 'Meeting',
    time: { hour: 8, minute: 30, matchedText: '8:30', vague: true },
    recurrence: { type: 'once', matchedText: [] },
  });
});

test('"in the <period>" is vague but does not imply daily', () => {
  const result = parseVoiceInput('Take a break in the afternoon');
  assert.deepEqual(result, {
    name: 'Take a break',
    time: { hour: 14, minute: 0, vague: true },
    recurrence: { type: 'once', matchedText: [] },
  });
});

test('multiple weekday names produce daysOfWeek recurrence', () => {
  const result = parseVoiceInput('Call mom on Sunday and Wednesday');
  assert.deepEqual(result, {
    name: 'Call mom',
    time: null,
    recurrence: { type: 'daysOfWeek', daysOfWeek: [0, 3], matchedText: ['sunday', 'wednesday'] },
  });
});

test('"on the Nth" produces monthlyDate recurrence', () => {
  const result = parseVoiceInput('Pay rent on the 1st');
  assert.deepEqual(result, {
    name: 'Pay rent',
    time: null,
    recurrence: { type: 'monthlyDate', dayOfMonth: 1, matchedText: ['on the 1st'] },
  });
});

test('"noon" keyword resolves to 12:00', () => {
  const result = parseVoiceInput('Meeting at noon');
  assert.deepEqual(result, {
    name: 'Meeting',
    time: { hour: 12, minute: 0, matchedText: 'noon' },
    recurrence: { type: 'once', matchedText: [] },
  });
});

test('"midnight" keyword resolves to 0:00', () => {
  const result = parseVoiceInput('Lights out at midnight');
  assert.deepEqual(result, {
    name: 'Lights out',
    time: { hour: 0, minute: 0, matchedText: 'midnight' },
    recurrence: { type: 'once', matchedText: [] },
  });
});

test('"remember to" prefix + minutes + literal "daily" keyword', () => {
  const result = parseVoiceInput('Remember to walk the dog daily at 6:30am');
  assert.deepEqual(result, {
    name: 'Walk the dog',
    time: { hour: 6, minute: 30, matchedText: '6:30am' },
    recurrence: { type: 'daily', matchedText: ['daily'] },
  });
});

test('no recurrence phrase defaults to "once", never guesses daily', () => {
  const result = parseVoiceInput('Water the plants');
  assert.equal(result.recurrence.type, 'once');
});

// Known/accepted limitation (see voice.js): a dangling connector word left
// after stripping matched phrases gets removed globally, which can eat a
// word that was actually part of the task name.
test('accepted limitation: dangling "on" gets stripped from the name', () => {
  const result = parseVoiceInput('check on the invoice');
  assert.deepEqual(result, {
    name: 'Check the invoice',
    time: null,
    recurrence: { type: 'once', matchedText: [] },
  });
});

// ---- clock times that are not real (stabilization finding 5) ----
import { extractExplicitTime } from './voice.js';

test('"3 30 pm" (colon dropped by speech recognition) is 15:30', () => {
  assert.deepEqual(extractExplicitTime('pick up at 3 30 pm'), { hour: 15, minute: 30, matchedText: '3 30 pm' });
});

test('REGRESSION: "30 pm" is not 42:00; numbers that cannot be an hour are skipped', () => {
  assert.equal(extractExplicitTime('at 30 pm'), null);
  assert.equal(extractExplicitTime('at 9:75 am'), null);
  assert.equal(extractExplicitTime('at 30'), null);
  for (const said of ['at 13 pm', 'at 0 am', 'at 99', 'at 24:00', 'at 7:60', 'at 8 99 pm']) {
    const time = extractExplicitTime(said);
    assert.ok(time === null || (time.hour >= 0 && time.hour <= 23 && time.minute >= 0 && time.minute <= 59), `${said} -> ${JSON.stringify(time)}`);
  }
});

test('a later valid time is still found after an invalid number', () => {
  assert.equal(extractExplicitTime('room 30 pm then at 4 pm').hour, 16);
});

test('plain times are unchanged', () => {
  assert.equal(extractExplicitTime('at 8am').hour, 8);
  assert.equal(extractExplicitTime('at 12 am').hour, 0);
  assert.equal(extractExplicitTime('at 12 pm').hour, 12);
  assert.deepEqual(extractExplicitTime('at 9:05 pm'), { hour: 21, minute: 5, matchedText: '9:05 pm' });
});

// "every day" wins over a weekday name that is just part of the title.
test('"every day" with a weekday word in the title stays daily, and the weekday stays in the name', () => {
  const r = parseVoiceInput('buy Friday paper every day at 9 am');
  assert.deepEqual(r.recurrence.type, 'daily');
  assert.equal(r.name, 'Buy Friday paper');
});

test('"daily" with a weekday word in the title stays daily', () => {
  assert.equal(parseVoiceInput('check the Monday report daily at 8 am').recurrence.type, 'daily');
});

test('a weekday that is itself the schedule still wins ("every Monday", "on Monday")', () => {
  assert.deepEqual(parseVoiceInput('every day stretch, and every Monday weigh in at 9 am').recurrence.daysOfWeek, [1]);
  assert.deepEqual(parseVoiceInput('take pills on Monday at 9 am').recurrence.daysOfWeek, [1]);
  assert.deepEqual(parseVoiceInput('water plants every Monday at 9 am').recurrence.daysOfWeek, [1]);
});

// A bare "at H:MM" that can only be 24-hour time is not vague.
test('"at 0:30", "at 13:30" and "at 21" are unambiguous 24-hour times', () => {
  assert.deepEqual(extractExplicitTime('take pills at 0:30'), { hour: 0, minute: 30, matchedText: '0:30' });
  assert.deepEqual(extractExplicitTime('take pills at 13:30'), { hour: 13, minute: 30, matchedText: '13:30' });
  assert.deepEqual(extractExplicitTime('take pills at 21'), { hour: 21, minute: 0, matchedText: '21' });
  assert.equal(extractExplicitTime('take pills at 8').vague, true); // 8 could be AM or PM
  assert.equal(extractExplicitTime('take pills at 12:30').vague, true);
});

// ---- Monthly phrases leave nothing behind in the name ----
// "on the 31st of every month" used to become "Pills of month".
for (const [said, day] of [
  ['pills on the 31st of every month at 9am', 31],
  ['pills on the 15th of each month at 9am', 15],
  ['pills on the 1st of the month at 9am', 1],
  ['pills on the 15th every month at 9am', 15],
  ['pills every month on the 15th at 9am', 15],
  ['pills on the 2nd monthly at 9am', 2],
]) {
  test(`monthly: "${said}" is day ${day} with the name "Pills"`, () => {
    const r = parseVoiceInput(said);
    assert.equal(r.recurrence.type, 'monthlyDate');
    assert.equal(r.recurrence.dayOfMonth, day);
    assert.equal(r.name, 'Pills');
  });
}

test('monthly: a plain "on the 15th" still works, and "month" in a real title is kept', () => {
  assert.equal(parseVoiceInput('pills on the 15th at 9am').name, 'Pills');
  assert.equal(parseVoiceInput('pay the month end bill on the 28th at 9am').name, 'Pay the month end bill');
});
