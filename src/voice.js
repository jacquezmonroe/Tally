// Pure voice-transcript parsing logic, kept free of DOM/Capacitor so it can
// be imported directly in tests. Turns a raw speech transcript into a
// best-guess { name, time, recurrence } — always reviewed/edited by the user
// in the add/edit form before anything is saved, so these heuristics don't
// need to be perfect.

export function extractExplicitTime(text) {
  // "9 am", "9:30 pm", and "3 30 pm" (speech often drops the colon). Only a
  // real clock time counts: "30 pm" is not 42:00, so numbers that can't be an
  // hour or minute are skipped.
  for (const found of text.matchAll(/(\d{1,2})(?:[:\s](\d{2}))?\s*(am|pm)\b/gi)) {
    let hour = parseInt(found[1]);
    const minute = found[2] ? parseInt(found[2]) : 0;
    if (hour < 1 || hour > 12 || minute > 59) continue;
    const isPM = found[3].toLowerCase() === 'pm';
    if (isPM && hour !== 12) hour += 12;
    if (!isPM && hour === 12) hour = 0;
    return { hour, minute, matchedText: found[0] };
  }
  let match;
  if (/\bnoon\b/i.test(text)) return { hour: 12, minute: 0, matchedText: 'noon' };
  if (/\bmidnight\b/i.test(text)) return { hour: 0, minute: 0, matchedText: 'midnight' };
  // A bare "at <hour>[:<minute>]" with no am/pm said at all — very common in
  // natural speech ("take vitamins at 8", "meeting at 8:30"). We can't tell
  // which half of the day is meant, so the hour is taken as-is and marked
  // vague, same as a period phrase — better than leaving the time silently
  // blank with no indication anything was missed.
  match = text.match(/\bat\s+(\d{1,2}(:\d{2})?)\b/i);
  if (match) {
    const [hourStr, minuteStr] = match[1].split(':');
    const hour = parseInt(hourStr);
    const minute = minuteStr ? parseInt(minuteStr) : 0;
    // "at 30" or "at 9:75" is not a time: say nothing rather than invent one.
    if (hour > 23 || minute > 59) return null;
    // 0 and 13-23 can only be 24-hour clock times, so they aren't vague.
    if (hour === 0 || hour >= 13) return { hour, minute, matchedText: match[1] };
    return { hour, minute, matchedText: match[1], vague: true };
  }
  return null;
}

export function extractDailyPeriodPhrase(text) {
  const match = text.match(/\b(every|in the)\s+(morning|afternoon|evening|night)\b/i);
  if (!match) return null;
  const period = match[2].toLowerCase();
  const hours = { morning: 8, afternoon: 14, evening: 19, night: 21 };
  return {
    matchedText: match[0],
    defaultHour: hours[period],
    impliesDaily: match[1].toLowerCase() === 'every',
  };
}

export function extractRecurrence(text, periodPhrase) {
  const dayMap = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
  const foundDays = [], foundNames = [];
  for (const [name, num] of Object.entries(dayMap)) {
    if (new RegExp(`\\b${name}\\b`, 'i').test(text)) { foundDays.push(num); foundNames.push(name); }
  }
  // With "every day" / "daily" also said, a weekday only sets the schedule
  // when it is said as one ("every Monday", "on Monday", "each Monday");
  // otherwise it is part of the title ("buy Friday paper every day").
  const saysDaily = /\bevery ?day\b|\bdaily\b/i.test(text);
  const asSchedule = (name) => new RegExp(`\\b(every|on|each)\\s+${name}\\b`, 'i').test(text);
  if (foundDays.length > 0 && (!saysDaily || foundNames.some(asSchedule))) {
    return { type: 'daysOfWeek', daysOfWeek: foundDays, matchedText: foundNames };
  }

  if (saysDaily) {
    return { type: 'daily', matchedText: [text.match(/every ?day|daily/i)[0]] };
  }
  if (periodPhrase?.impliesDaily) {
    return { type: 'daily', matchedText: [periodPhrase.matchedText] };
  }
  let match = text.match(/on the (\d{1,2})(st|nd|rd|th)/i);
  if (match) {
    // "of every month", "every month", "of the month", "monthly" only repeat
    // what the day already says, so they are stripped from the name as well.
    const monthly = text.match(/\bof\s+(?:every|each|the)\s+month\b|\b(?:every|each)\s+month\b|\bmonthly\b/i);
    return { type: 'monthlyDate', dayOfMonth: parseInt(match[1]), matchedText: monthly ? [match[0], monthly[0]] : [match[0]] };
  }

  return { type: 'once', matchedText: [] };
}

export function extractName(text, explicitTime, periodPhrase, recurrenceMatch) {
  let cleaned = text;
  cleaned = cleaned.replace(/^remind me to\s*/i, '');
  cleaned = cleaned.replace(/^remember to\s*/i, '');

  const phrasesToStrip = [];
  if (explicitTime?.matchedText) phrasesToStrip.push(`at\\s*${explicitTime.matchedText}`, explicitTime.matchedText);
  if (periodPhrase?.matchedText) phrasesToStrip.push(periodPhrase.matchedText);
  if (recurrenceMatch?.matchedText?.length) {
    for (const phrase of recurrenceMatch.matchedText) {
      phrasesToStrip.push(`on (the )?${phrase}`, `every\\s*${phrase}`, phrase);
    }
  }

  for (const phrase of phrasesToStrip) {
    const esc = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\ /g, '\\s*');
    cleaned = cleaned.replace(new RegExp(`\\b${esc}\\b`, 'i'), '');
  }

  cleaned = cleaned.replace(/\b(and|on|at|every)\b/gi, ' ');
  cleaned = cleaned.replace(/\s+/g, ' ').trim();
  cleaned = cleaned.replace(/^\b(and|on|at|,)\b\s*/i, '').replace(/\s*\b(and|on|at|,)\b$/i, '');
  cleaned = cleaned.trim();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

export function parseVoiceInput(text) {
  const explicitTime = extractExplicitTime(text);
  const periodPhrase = extractDailyPeriodPhrase(text);
  const recurrence = extractRecurrence(text, periodPhrase);
  const name = extractName(text, explicitTime, periodPhrase, recurrence);
  const time = explicitTime || (periodPhrase ? { hour: periodPhrase.defaultHour, minute: 0, vague: true } : null);
  return { name, time, recurrence };
}
