// Safe loading of saved reminders and settings.
//
// The rule behind everything here: bad data must never crash the app and must
// never be silently lost. So loading works like this:
//
//   1. Read what is stored and check every reminder on its own.
//   2. Keep the good ones, set aside ("quarantine") the ones that can't be
//      understood, and fix harmless problems (like a time written as "9:05").
//   3. If anything was wrong, FIRST save the untouched original text under a
//      new, timestamped key, and only then save the repaired list.
//   4. Tell the user what happened (a notice that stays until dismissed).
//   5. If the original can't be backed up or the repair can't be written,
//      switch saving OFF for the session so a bad load can never overwrite
//      good data.
//
// Pure of Capacitor: the storage object ("prefs") is passed in, so tests use a
// fake one. Existing storage keys are never renamed; only new keys are added.

import {
  normalizeReminderColor,
  GRACE_PERIOD_OPTIONS,
  DEFAULT_QUIET_HOURS,
  DEFAULT_REMINDER_DEFAULTS,
} from './settings.js';

// ---- New keys (the existing 'tally-*' keys are untouched) ----
export const CURRENT_SCHEMA_VERSION = 1;
export const SCHEMA_VERSION_KEY = 'tally-schema-version';
export const BACKUP_KEY_PREFIX = 'tally-reminders-backup-';
export const SETTINGS_BACKUP_KEY_PREFIX = 'tally-settings-backup-';
export const QUARANTINE_KEY = 'tally-reminders-quarantine';
export const NOTICE_KEY = 'tally-recovery-notice';

// Notification IDs are built as reminderId * 16 + slot (see the Phase 2 scheme)
// and must stay below 2^31, so a reminder id can't exceed this. Stored ids
// above it are given a fresh one rather than dropped.
export const MAX_REMINDER_ID = Math.floor((2 ** 31 - 1) / 16);

// ---- Small validators ----
const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isCount = v => Number.isSafeInteger(v) && v >= 0;

export function isValidDateKey(value) {
  if (typeof value !== 'string') return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1900 || y > 2999) return false;
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

// "9:05" -> "09:05"; anything that isn't a real clock time -> null.
export function normalizeTime(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const [h, min] = [Number(m[1]), Number(m[2])];
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

// A missing recurrence is a legitimate old-format reminder and means "daily"
// (that is how the app has always read it). A present but unusable one can't be
// guessed at, so the reminder is set aside instead.
function checkRecurrence(rec) {
  if (rec === undefined) return { ok: true, value: { type: 'daily' } };
  if (!isPlainObject(rec)) return { ok: false, reason: 'invalid_recurrence' };
  switch (rec.type) {
    case 'daily':
      return { ok: true, value: { type: 'daily' } };
    case 'daysOfWeek': {
      const days = rec.daysOfWeek;
      if (!Array.isArray(days) || days.length === 0 || !days.every(d => Number.isInteger(d) && d >= 0 && d <= 6)) {
        return { ok: false, reason: 'invalid_recurrence' };
      }
      return { ok: true, value: { type: 'daysOfWeek', daysOfWeek: [...new Set(days)].sort((a, b) => a - b) } };
    }
    case 'monthlyDate':
      return Number.isInteger(rec.dayOfMonth) && rec.dayOfMonth >= 1 && rec.dayOfMonth <= 31
        ? { ok: true, value: { type: 'monthlyDate', dayOfMonth: rec.dayOfMonth } }
        : { ok: false, reason: 'invalid_recurrence' };
    case 'once':
      return isValidDateKey(rec.date)
        ? { ok: true, value: { type: 'once', date: rec.date } }
        : { ok: false, reason: 'invalid_recurrence' };
    default:
      return { ok: false, reason: 'invalid_recurrence' };
  }
}

// Steps (subtasks) are optional extras on a reminder. Bad individual steps are
// dropped and counted; the reminder itself is always kept.
function cleanSubtasks(value) {
  if (!Array.isArray(value)) return null;
  const seen = new Set();
  const list = [];
  let dropped = 0;
  for (const item of value) {
    const ok = isPlainObject(item) && Number.isSafeInteger(item.id) && item.id >= 1 && !seen.has(item.id)
      && typeof item.title === 'string' && item.title.trim() !== ''
      && (item.done === undefined || typeof item.done === 'boolean');
    if (!ok) { dropped++; continue; }
    seen.add(item.id);
    list.push({ ...item, done: item.done === true });
  }
  return { list, dropped };
}

// -> { ok: true, record, repairs: [field names], idOk } | { ok: false, reason }
// A reminder is set aside only when its name, time or schedule can't be
// understood. Everything else is repaired to a safe value and reported.
export function validateReminderRecord(raw) {
  if (!isPlainObject(raw)) return { ok: false, reason: 'not_an_object' };
  if (typeof raw.name !== 'string' || raw.name.trim() === '') return { ok: false, reason: 'missing_name' };
  const time = normalizeTime(raw.time);
  if (time === null) return { ok: false, reason: 'invalid_time' };
  const recurrence = checkRecurrence(raw.recurrence);
  if (!recurrence.ok) return { ok: false, reason: recurrence.reason };

  const repairs = [];
  const record = { ...raw, name: raw.name, time, recurrence: recurrence.value };

  for (const field of ['takenDate', 'lastCompletedDate']) {
    const v = raw[field];
    if (v === undefined || v === null) record[field] = null;
    else if (!isValidDateKey(v)) { record[field] = null; repairs.push(field); }
  }
  for (const field of ['currentStreak', 'longestStreak']) {
    const v = raw[field];
    if (v === undefined) record[field] = 0;
    else if (!isCount(v)) { record[field] = 0; repairs.push(field); }
  }
  if (raw.notes === undefined) record.notes = '';
  else if (typeof raw.notes !== 'string') { record.notes = ''; repairs.push('notes'); }

  record.color = normalizeReminderColor(raw.color); // unknown colors have always quietly meant "none"

  if ('importance' in raw && raw.importance !== 'high' && raw.importance !== 'low') {
    delete record.importance;
    repairs.push('importance');
  }
  if ('subtasks' in raw) {
    const cleaned = cleanSubtasks(raw.subtasks);
    if (cleaned === null) { delete record.subtasks; repairs.push('subtasks'); }
    else { record.subtasks = cleaned.list; if (cleaned.dropped) repairs.push('subtasks'); }
  }

  const idOk = Number.isSafeInteger(raw.id) && raw.id >= 1 && raw.id <= MAX_REMINDER_ID;
  return { ok: true, record, repairs, idOk };
}

function parseStoredNextId(raw) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return 0;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= 1 ? n : 0;
}

// -> {
//   status: 'empty' | 'ok' | 'recovered' | 'unreadable',
//   reason, reminders, quarantined: [{ index, reason, record }],
//   repaired: [{ id, fields }], nextId, nextIdChanged
// }
// Never throws, whatever the input.
export function parseStoredReminders(rawValue, rawNextId) {
  const storedNext = parseStoredNextId(rawNextId);
  const base = { reminders: [], quarantined: [], repaired: [], nextId: Math.max(storedNext, 1) };
  // Only rewrite the saved counter when it was missing-but-needed or unusable/too small.
  const counterPresent = rawNextId !== null && rawNextId !== undefined && rawNextId !== '';
  const finish = (extra) => {
    const nextId = extra.nextId ?? base.nextId;
    return { ...base, ...extra, nextIdChanged: counterPresent ? String(rawNextId).trim() !== String(nextId) : nextId > 1 };
  };

  if (rawValue === null || rawValue === undefined || rawValue === '') return finish({ status: 'empty' });

  let data;
  try {
    data = JSON.parse(rawValue);
  } catch {
    return finish({ status: 'unreadable', reason: 'invalid_json' });
  }
  if (!Array.isArray(data)) return finish({ status: 'unreadable', reason: 'not_a_list' });

  const checked = data.map((item, index) => ({ index, item, result: validateReminderRecord(item) }));

  // Largest id seen anywhere, including set-aside records, so a restored
  // record can never collide with a newly created one.
  let maxSeen = 0;
  for (const { item, result } of checked) {
    const id = result.ok ? result.record.id : (isPlainObject(item) ? item.id : undefined);
    if (Number.isSafeInteger(id) && id >= 1 && id <= MAX_REMINDER_ID) maxSeen = Math.max(maxSeen, id);
  }

  const used = new Set();
  const reminders = [];
  const quarantined = [];
  const repaired = [];
  let nextFree = maxSeen + 1;

  for (const { index, item, result } of checked) {
    if (!result.ok) { quarantined.push({ index, reason: result.reason, record: item }); continue; }
    const { record, repairs, idOk } = result;
    const fields = [...repairs];
    if (!idOk || used.has(record.id)) {
      // Keep the reminder, give it a fresh id (a duplicate id means two
      // reminders would share one notification slot).
      if (nextFree > MAX_REMINDER_ID) { quarantined.push({ index, reason: 'no_free_id', record: item }); continue; }
      record.id = nextFree++;
      fields.push('id');
    }
    used.add(record.id);
    reminders.push(record);
    if (fields.length) repaired.push({ id: record.id, fields });
  }

  const highest = Math.max(maxSeen, ...reminders.map(r => r.id), 0);
  const nextId = Math.max(storedNext, highest + 1, nextFree, 1);
  const status = quarantined.length || repaired.length ? 'recovered' : 'ok';
  return finish({ status, reminders, quarantined, repaired, nextId });
}

// ---- Settings: bad values fall back to defaults instead of freezing startup ----

function parseJsonObject(raw) {
  if (raw === null || raw === undefined || raw === '') return { present: false };
  try {
    const value = JSON.parse(raw);
    return isPlainObject(value) ? { present: true, value } : { present: true, bad: true };
  } catch {
    return { present: true, bad: true };
  }
}

// -> { value, reset } where reset means "something stored was unusable"
export function parseQuietHours(raw) {
  const parsed = parseJsonObject(raw);
  const value = { ...DEFAULT_QUIET_HOURS };
  if (!parsed.present) return { value, reset: false };
  if (parsed.bad) return { value, reset: true };
  let reset = false;
  if (typeof parsed.value.enabled === 'boolean') value.enabled = parsed.value.enabled;
  else if ('enabled' in parsed.value) reset = true;
  for (const field of ['start', 'end']) {
    const t = normalizeTime(parsed.value[field]);
    if (t) value[field] = t;
    else if (field in parsed.value) reset = true;
  }
  return { value, reset };
}

export function parseReminderDefaults(raw) {
  const parsed = parseJsonObject(raw);
  const value = { ...DEFAULT_REMINDER_DEFAULTS };
  if (!parsed.present) return { value, reset: false };
  if (parsed.bad) return { value, reset: true };
  let reset = false;
  const p = parsed.value;
  if (GRACE_PERIOD_OPTIONS.includes(p.gracePeriodHours)) value.gracePeriodHours = p.gracePeriodHours;
  else if ('gracePeriodHours' in p) reset = true;
  if (typeof p.soundEnabled === 'boolean') value.soundEnabled = p.soundEnabled;
  else if ('soundEnabled' in p) reset = true;
  value.defaultColor = normalizeReminderColor(p.defaultColor);
  return { value, reset };
}

// ---- The notice shown to the user ----

export function describeNotice(notice) {
  if (!notice || typeof notice !== 'object') return '';
  const parts = [];
  if (notice.kind === 'storage_unreadable' || notice.kind === 'recovery_failed') {
    return "Tickmark couldn't safely read or repair your saved reminders, so it is leaving them untouched and won't save changes until this is fixed.";
  }
  if (notice.unreadable) {
    parts.push("Your saved reminders couldn't be read, so Tickmark started with an empty list. Your original data was saved first.");
  } else if (notice.quarantined || notice.repaired || notice.recovered) {
    const kept = `Recovered ${notice.recovered} reminder${notice.recovered === 1 ? '' : 's'}`;
    const aside = notice.quarantined ? ` and set aside ${notice.quarantined} that couldn't be read` : '';
    parts.push(`${kept}${aside}. Your original data was saved first.`);
  }
  if (Array.isArray(notice.settingsReset) && notice.settingsReset.length) {
    parts.push('A saved setting was invalid and was reset to its default.');
  }
  return parts.join(' ');
}

function parseNotice(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    const value = JSON.parse(raw);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

function parseVersion(raw) {
  const n = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw) : 0;
  return Number.isSafeInteger(n) ? n : 0;
}

const stamp = date => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

// ---- The store ----
// prefs: { get(key) -> string | null, set(key, value), remove(key) }
// keys:  { reminders, nextId }: the EXISTING keys, passed in so they are never renamed here.
export function createReminderStorage({ prefs, keys, now = () => new Date() }) {
  let saveAllowed = true;

  async function uniqueKey(prefix) {
    const base = `${prefix}${stamp(now())}`;
    let key = base;
    for (let n = 2; (await prefs.get(key)) != null; n++) key = `${base}-${n}`;
    return key;
  }

  async function mergeNotice(patch) {
    const existing = parseNotice(await prefs.get(NOTICE_KEY)) || {};
    const merged = { ...existing, ...patch };
    if (patch.settingsReset) {
      merged.settingsReset = [...new Set([...(existing.settingsReset || []), ...patch.settingsReset])];
    }
    await prefs.set(NOTICE_KEY, JSON.stringify(merged));
    return merged;
  }

  async function appendQuarantine(entries) {
    const existingRaw = await prefs.get(QUARANTINE_KEY);
    let existing = [];
    if (typeof existingRaw === 'string' && existingRaw !== '') {
      try {
        const value = JSON.parse(existingRaw);
        if (Array.isArray(value)) existing = value;
        else throw new Error('not a list');
      } catch {
        // Never overwrite something we can't read: keep it under its own key first.
        await prefs.set(await uniqueKey(`${QUARANTINE_KEY}-unreadable-`), existingRaw);
      }
    }
    const at = now().toISOString();
    await prefs.set(QUARANTINE_KEY, JSON.stringify([...existing, ...entries.map(e => ({ at, reason: e.reason, record: e.record }))]));
  }

  // -> { reminders, nextId, saveAllowed, notice }
  async function load() {
    let rawValue, rawNext, rawVersion, rawNotice;
    try {
      [rawValue, rawNext, rawVersion, rawNotice] = await Promise.all([
        prefs.get(keys.reminders), prefs.get(keys.nextId), prefs.get(SCHEMA_VERSION_KEY), prefs.get(NOTICE_KEY),
      ]);
    } catch {
      saveAllowed = false;
      return { reminders: [], nextId: 1, saveAllowed: false, notice: { kind: 'storage_unreadable' } };
    }

    const parsed = parseStoredReminders(rawValue, rawNext);
    const version = parseVersion(rawVersion);
    let notice = parseNotice(rawNotice);
    const damaged = parsed.status === 'recovered' || parsed.status === 'unreadable';

    try {
      if (damaged) {
        // 1. The untouched original goes to its own key BEFORE anything is repaired.
        let backupKey = null;
        if (typeof rawValue === 'string' && rawValue !== '') {
          backupKey = await uniqueKey(BACKUP_KEY_PREFIX);
          await prefs.set(backupKey, rawValue);
        }
        // 2. Records that couldn't be understood are kept, set aside, not deleted.
        if (parsed.quarantined.length) {
          try { await appendQuarantine(parsed.quarantined); } catch { /* the backup above already holds them */ }
        }
        // 3. Only now is the repaired list saved.
        await prefs.set(keys.reminders, JSON.stringify(parsed.reminders));
        await prefs.set(keys.nextId, String(parsed.nextId));
        if (version < CURRENT_SCHEMA_VERSION) await prefs.set(SCHEMA_VERSION_KEY, String(CURRENT_SCHEMA_VERSION));
        notice = await mergeNotice({
          v: 1,
          at: now().toISOString(),
          kind: parsed.status,
          unreadable: parsed.status === 'unreadable',
          recovered: parsed.reminders.length,
          quarantined: parsed.quarantined.length,
          repaired: parsed.repaired.length,
          backupKey,
        });
      } else {
        if (parsed.nextIdChanged) await prefs.set(keys.nextId, String(parsed.nextId)); // a bad counter is harmless to fix
        if (version < CURRENT_SCHEMA_VERSION) await prefs.set(SCHEMA_VERSION_KEY, String(CURRENT_SCHEMA_VERSION));
      }
    } catch {
      // Could not secure the original or write the repair: change nothing more and stop saving.
      saveAllowed = false;
      return { reminders: parsed.reminders, nextId: parsed.nextId, saveAllowed: false, notice: { kind: 'recovery_failed' } };
    }
    return { reminders: parsed.reminders, nextId: parsed.nextId, saveAllowed, notice };
  }

  async function write(key, value) {
    if (!saveAllowed) return { saved: false, reason: 'blocked' };
    try {
      await prefs.set(key, value);
      return { saved: true };
    } catch (error) {
      return { saved: false, reason: 'write_failed', error };
    }
  }

  // Reads one settings value with a validator; an unusable value is backed up
  // and replaced by defaults (in memory), and the user is told.
  async function loadSetting(key, parser) {
    let raw = null;
    try { raw = await prefs.get(key); } catch { return { value: parser(null).value, reset: false }; }
    const { value, reset } = parser(raw);
    if (reset) {
      try {
        if (typeof raw === 'string' && raw !== '') await prefs.set(await uniqueKey(SETTINGS_BACKUP_KEY_PREFIX), raw);
        await prefs.set(key, JSON.stringify(value)); // original is safe above; write the defaults so this doesn't repeat every launch
        await mergeNotice({ v: 1, at: now().toISOString(), settingsReset: [key] });
      } catch { /* defaults still apply in memory */ }
    }
    return { value, reset };
  }

  return {
    load,
    loadSetting,
    saveReminders: (list) => write(keys.reminders, JSON.stringify(list)),
    saveNextId: (n) => write(keys.nextId, String(n)),
    dismissNotice: async () => { try { await prefs.remove(NOTICE_KEY); } catch { /* it will simply show again */ } },
    getNotice: async () => parseNotice(await prefs.get(NOTICE_KEY)),
    // Emergency stop for callers that hit an unexpected failure while loading.
    blockSaving: () => { saveAllowed = false; },
    get saveAllowed() { return saveAllowed; },
  };
}
