import { LocalNotifications } from '@capacitor/local-notifications';
import { Preferences } from '@capacitor/preferences';
import { Badge } from '@capawesome/capacitor-badge';
import { checkStaleStreaks, isOnGrace, isStreakEligible, todayKey, takeToday, untakeToday } from './streak.js';
import { isVoiceAvailable, ensureVoicePermissions, startListening } from './voiceInput.js';
import { getContextualGreeting, getEmptyStateMessage, isStreakMilestone, getMilestoneMessage, isStreakAcknowledgment, getStreakAcknowledgment, getStreakResetMessage } from './personalization.js';
import { getPendingToday, countBadge, isAllDoneToday, appliesToday, filterForView, nextOccurrence, describeDay, isOverdueOneTime, isCompletedOneTime, getOverdueOneTime, getCompletedOneTime, oneTimeDay, dateFromKey, isFinished, msUntilNextLocalMidnight } from './due.js';
import {
  ringProgress,
  ringDashOffset,
  staggerDelay,
  SWIPE_ACTION_WIDTH,
  clampSwipe,
  resolveSwipeSnap,
  clampCompleteSwipe,
  shouldCompleteOnRelease,
  isConfettiMilestone,
} from './motion.js';
import {
  ACCENT_THEMES,
  APPEARANCE_MODES,
  DEFAULT_APPEARANCE,
  normalizeAppearance,
  resolveScheme,
  DEFAULT_ACCENT_THEME,
  getAccentTheme,
  GREETING_STYLES,
  DEFAULT_GREETING_STYLE,
  normalizeGreetingStyle,
  GRACE_PERIOD_OPTIONS,
  DEFAULT_REMINDER_DEFAULTS,
  REMINDER_COLORS,
  normalizeReminderColor,
  getReminderColorHex,
  getReminderColorDarkHex,
  graceOccurrencesForHours,
  DEFAULT_QUIET_HOURS,
  rootFontSizeForSystemBody,
} from './settings.js';
import { intelligence } from './intelligence/default.js';
import { applyAnswer, reminderCount, numberedNames, timeValue } from './intelligence/understand.js';
import {
  windowFor,
  buildPlan,
  setBlockMinutes,
  moveBlock,
  removeBlock,
  addUnscheduled,
  planSummary,
  toStoredPlan,
  fromStoredPlan,
  formatMinutes,
  formatDuration,
  DURATION_OPTIONS,
} from './intelligence/planner.js';
import { rankFocus, focusSummary, withImportance, normalizeImportance, IMPORTANCE_LEVELS } from './intelligence/prioritizer.js';
import {
  getSubtasks,
  appendSubtasks,
  toggleSubtask,
  removeSubtask,
  subtaskProgress,
  buildReview,
  editReviewItem,
  toggleReviewItem,
  discardReviewItem,
  approvedSteps,
} from './subtasks.js';
import { classifyNotificationAction, resolveMarkTaken, creditPastDay } from './notificationActions.js';
import { createReminderStorage, parseQuietHours, parseReminderDefaults, describeNotice } from './storage.js';
import { createNotifier, SNOOZE_MINUTES } from './notifications.js';
import { createReminderActions } from './reminderActions.js';
import { summarizeAlerts, alertBannerText, alertBadgeText } from './alertStatus.js';
import './style.css';
import './alerts.css';
import './pastReminders.css';

const STORAGE_KEY = 'tally-reminders';
const NEXT_ID_KEY = 'tally-next-id';
const USER_NAME_KEY = 'tally-user-name';
const ONBOARDED_KEY = 'tally-onboarded';
const ACCENT_THEME_KEY = 'tally-accent-theme';
const APPEARANCE_KEY = 'tally-appearance';
const REMINDER_DEFAULTS_KEY = 'tally-reminder-defaults';
const QUIET_HOURS_KEY = 'tally-quiet-hours';
const PLAN_KEY = 'tally-plan';

// All loading and saving of reminders goes through this, which checks what it
// reads, backs up anything it has to repair, and refuses to save over data it
// could not safely read (see storage.js). The key names above are unchanged.
const prefsAdapter = {
  async get(key) { const { value } = await Preferences.get({ key }); return value; },
  set: (key, value) => Preferences.set({ key, value }),
  remove: (key) => Preferences.remove({ key }),
  async keys() { return (await Preferences.keys()).keys; },
};
const storage = createReminderStorage({
  prefs: prefsAdapter,
  keys: { reminders: STORAGE_KEY, nextId: NEXT_ID_KEY },
});

// Every phone alert is derived from the saved reminders and settings by ONE
// function (see notifications.js). Nothing else in this file schedules or
// cancels an alert: it saves, then asks for a sync. The getters read the
// variables below at call time.
const notifier = createNotifier({
  plugin: LocalNotifications,
  prefs: prefsAdapter,
  getReminders: () => reminders,
  getSettings: () => ({ soundEnabled: reminderDefaults.soundEnabled, quietHours }),
  getUserName: () => userName,
});
const actions = createReminderActions({
  state: {
    get reminders() { return reminders; },
    set reminders(value) { reminders = value; },
    get nextId() { return nextId; },
    set nextId(value) { nextId = value; },
  },
  storage,
  notifier,
});
let blockedNotice = null; // a notice that exists only for this session (nothing could be written)
const GREETING_STYLE_KEY = 'tally-greeting-style';

let reminders = [];
let nextId = 1;
let editingId = null;
let userName = null;
let accentTheme = DEFAULT_ACCENT_THEME;
let appearance = DEFAULT_APPEARANCE;
let greetingStyle = DEFAULT_GREETING_STYLE;
let reminderDefaults = { ...DEFAULT_REMINDER_DEFAULTS };
let quietHours = { ...DEFAULT_QUIET_HOURS };
let justTakenId = null; // only this row plays the checkmark draw-in
let justIncrementedStreakId = null; // only this row's streak ring plays the pop
let wasAllDoneToday = false; // tracks the *transition* into all-done, not just the state
let openSwipeId = null; // the row currently swiped open, if any
let activeSettingsTab = 'personal';
let activeView = 'today'; // Home tab: 'today' | 'upcoming' | 'done'
let detailId = null; // the reminder whose detail screen is open, if any
let understanding = null; // the add screen's current "Describe it" draft: its count and open questions
let understandBusy = false;
// Resolves once saved reminders and settings have been loaded. A notification
// action can reach the page before init() has finished (the plugin holds the
// event until a listener exists), so anything that changes reminders waits here.
let markAppReady;
const appReady = new Promise(resolve => { markAppReady = resolve; });
const ringProgressById = new Map(); // last-rendered ring fill, so changes can animate

const listEl = document.getElementById('reminderList');
const emptyStateEl = document.getElementById('emptyState');
const addForm = document.getElementById('addForm');
const nameInput = document.getElementById('nameInput');
const timeInput = document.getElementById('timeInput');
const recurrenceFieldsEl = document.getElementById('recurrenceFields');
const colorFieldsEl = document.getElementById('colorFields');
const defaultColorEl = document.getElementById('defaultColorSwatches');
const permissionBanner = document.getElementById('permissionBanner');
const enableNotifsBtn = document.getElementById('enableNotifsBtn');
const alertBannerEl = document.getElementById('alertBanner');
const alertBannerMessageEl = document.getElementById('alertBannerText');
const alertRetryBtn = document.getElementById('alertRetryBtn');
const overdueSectionEl = document.getElementById('overdueSection');
const overdueListEl = document.getElementById('overdueList');
const overdueCountEl = document.getElementById('overdueCount');
const completedSectionEl = document.getElementById('completedSection');
const completedListEl = document.getElementById('completedList');
const completedCountEl = document.getElementById('completedCount');
const completedToggleEl = document.getElementById('completedToggle');
const micBtn = document.getElementById('micBtn');
const importanceInput = document.getElementById('importanceInput');
const editImportanceInput = document.getElementById('editImportanceInput');
const focusBtn = document.getElementById('focusBtn');
const todayActions = document.getElementById('todayActions');
const planBtn = document.getElementById('planBtn');
const planScreen = document.getElementById('planScreen');
const planBackBtn = document.getElementById('planBackBtn');
const planScopesEl = document.getElementById('planScopes');
const planStartInput = document.getElementById('planStart');
const planEndInput = document.getElementById('planEnd');
const planSummaryEl = document.getElementById('planSummary');
const planSourceEl = document.getElementById('planSource');
const planBlocksEl = document.getElementById('planBlocks');
const planUnscheduledEl = document.getElementById('planUnscheduled');
const planUnscheduledListEl = document.getElementById('planUnscheduledList');
const planSaveBtn = document.getElementById('planSaveBtn');
const planDiscardBtn = document.getElementById('planDiscardBtn');
const focusScreen = document.getElementById('focusScreen');
const focusBackBtn = document.getElementById('focusBackBtn');
const focusSummaryEl = document.getElementById('focusSummary');
const focusSourceEl = document.getElementById('focusSource');
const focusListEl = document.getElementById('focusList');
const recoveryBanner = document.getElementById('recoveryBanner');
const recoveryBannerText = document.getElementById('recoveryBannerText');
const recoveryDismissBtn = document.getElementById('recoveryDismissBtn');
const recoveryExportEl = document.getElementById('recoveryExport');
const recoveryCopyBtn = document.getElementById('recoveryCopyBtn');
const nlInput = document.getElementById('nlInput');
const nlFillBtn = document.getElementById('nlFillBtn');
const understandPanel = document.getElementById('understandPanel');
const voiceOverlay = document.getElementById('voiceOverlay');
const voiceStatus = document.getElementById('voiceStatus');
const voiceTranscript = document.getElementById('voiceTranscript');
const voiceCancelBtn = document.getElementById('voiceCancelBtn');
const voiceDoneBtn = document.getElementById('voiceDoneBtn');
const greetingEl = document.getElementById('greeting');
const settingsBtn = document.getElementById('settingsBtn');
const settingsScreen = document.getElementById('settingsScreen');
const settingsCloseBtn = document.getElementById('settingsCloseBtn');
const settingsNameInput = document.getElementById('settingsNameInput');
const greetingStyleToggleEl = document.getElementById('greetingStyleToggle');
const themeSwatchesEl = document.getElementById('themeSwatches');
const appearanceToggleEl = document.getElementById('appearanceToggle');
const graceOptionsEl = document.getElementById('graceOptions');
const soundToggleEl = document.getElementById('soundToggle');
const quietHoursToggleEl = document.getElementById('quietHoursToggle');
const quietHoursRangeEl = document.getElementById('quietHoursRange');
const quietHoursStartInput = document.getElementById('quietHoursStart');
const quietHoursEndInput = document.getElementById('quietHoursEnd');
const onboardingScreen = document.getElementById('onboardingScreen');
const onboardingNameInput = document.getElementById('onboardingNameInput');
const onboardingContinueBtn = document.getElementById('onboardingContinueBtn');
const onboardingSkipBtn = document.getElementById('onboardingSkipBtn');
const milestoneModal = document.getElementById('milestoneModal');
const milestoneMessageEl = document.getElementById('milestoneMessage');
const toastEl = document.getElementById('toast');
const toastMessageEl = document.getElementById('toastMessage');
const appEl = document.getElementById('app');
const skeletonEl = document.getElementById('skeletonList');
const confettiEl = document.getElementById('confetti');
const allDoneBannerEl = document.getElementById('allDoneBanner');
const allDoneConfettiEl = document.getElementById('allDoneConfetti');
const settingsTabsEl = document.getElementById('settingsTabs');
const openAddBtn = document.getElementById('openAddBtn');
const addScreen = document.getElementById('addScreen');
const addCloseBtn = document.getElementById('addCloseBtn');
const editScreen = document.getElementById('editScreen');
const editForm = document.getElementById('editForm');
const editCloseBtn = document.getElementById('editCloseBtn');
const editCancelBtn = document.getElementById('editCancelBtn');
const editNameInput = document.getElementById('editNameInput');
const editTimeInput = document.getElementById('editTimeInput');
const editRecurrenceFieldsEl = document.getElementById('editRecurrenceFields');
const editColorFieldsEl = document.getElementById('editColorFields');
const notesInput = document.getElementById('notesInput');
const editNotesInput = document.getElementById('editNotesInput');
const viewTabsEl = document.getElementById('viewTabs');
const emptyStateSubEl = document.getElementById('emptyStateSub');
const detailScreen = document.getElementById('detailScreen');
const detailBackBtn = document.getElementById('detailBackBtn');
const detailTitleEl = document.getElementById('detailTitle');
const detailWhenEl = document.getElementById('detailWhen');
const detailRepeatEl = document.getElementById('detailRepeat');
const detailNotesBlockEl = document.getElementById('detailNotesBlock');
const detailNotesEl = document.getElementById('detailNotes');
const detailCompleteBtn = document.getElementById('detailCompleteBtn');
const detailSnoozeBtn = document.getElementById('detailSnoozeBtn');
const detailEditBtn = document.getElementById('detailEditBtn');
const detailStepsProgressEl = document.getElementById('detailStepsProgress');
const detailStepsListEl = document.getElementById('detailStepsList');
const stepAddForm = document.getElementById('stepAddForm');
const stepAddInput = document.getElementById('stepAddInput');
const breakIntoStepsBtn = document.getElementById('breakIntoStepsBtn');
const stepsScreen = document.getElementById('stepsScreen');
const stepsBackBtn = document.getElementById('stepsBackBtn');
const stepsTaskNameEl = document.getElementById('stepsTaskName');
const stepsStatusEl = document.getElementById('stepsStatus');
const stepsCancelBtn = document.getElementById('stepsCancelBtn');
const stepsMessageEl = document.getElementById('stepsMessage');
const stepsMessageTextEl = document.getElementById('stepsMessageText');
const stepsManualBtn = document.getElementById('stepsManualBtn');
const stepsRetryBtn = document.getElementById('stepsRetryBtn');
const stepsReviewEl = document.getElementById('stepsReview');
const stepsListEl = document.getElementById('stepsList');
const stepsSaveBtn = document.getElementById('stepsSaveBtn');
const stepsAgainBtn = document.getElementById('stepsAgainBtn');

const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---- Recurrence UI helpers ----
function renderRecurrenceFields(recurrence = { type: 'daily' }) {
  const selectedDays = recurrence.daysOfWeek || [];
  const weekdayButtons = WEEKDAY_LABELS.map((label, i) => `
    <button type="button" class="weekday-btn${selectedDays.includes(i) ? ' selected' : ''}" data-day="${i}" aria-label="${WEEKDAY_NAMES[i]}">${label}</button>
  `).join('');

  return `
    <select class="recurrence-select">
      <option value="daily"${recurrence.type === 'daily' ? ' selected' : ''}>Every day</option>
      <option value="daysOfWeek"${recurrence.type === 'daysOfWeek' ? ' selected' : ''}>Specific days</option>
      <option value="monthlyDate"${recurrence.type === 'monthlyDate' ? ' selected' : ''}>Monthly</option>
      <option value="once"${recurrence.type === 'once' ? ' selected' : ''}>One time</option>
    </select>
    <div class="weekdays-picker"${recurrence.type === 'daysOfWeek' ? '' : ' hidden'}>${weekdayButtons}</div>
    <input type="number" class="day-of-month-input" min="1" max="31" placeholder="Day of month (1-31)" value="${recurrence.type === 'monthlyDate' ? recurrence.dayOfMonth : ''}"${recurrence.type === 'monthlyDate' ? '' : ' hidden'}>
    <input type="date" class="once-date-input" value="${recurrence.type === 'once' ? recurrence.date : ''}"${recurrence.type === 'once' ? '' : ' hidden'}>
  `;
}

function wireRecurrenceControls(root) {
  const select = root.querySelector('.recurrence-select');
  const weekdaysPicker = root.querySelector('.weekdays-picker');
  const dayOfMonthInput = root.querySelector('.day-of-month-input');
  const onceDateInput = root.querySelector('.once-date-input');

  select.addEventListener('change', () => {
    weekdaysPicker.hidden = select.value !== 'daysOfWeek';
    dayOfMonthInput.hidden = select.value !== 'monthlyDate';
    onceDateInput.hidden = select.value !== 'once';
  });

  root.querySelectorAll('.weekday-btn').forEach(btn => {
    btn.addEventListener('click', () => btn.classList.toggle('selected'));
  });
}

// Returns a recurrence object read from the form, or null if the current
// selection is incomplete (e.g. no weekday picked yet).
function readRecurrenceFromForm(root) {
  const type = root.querySelector('.recurrence-select').value;

  if (type === 'daysOfWeek') {
    const daysOfWeek = [...root.querySelectorAll('.weekday-btn.selected')].map(b => Number(b.dataset.day));
    return daysOfWeek.length > 0 ? { type, daysOfWeek } : null;
  }
  if (type === 'monthlyDate') {
    const dayOfMonth = Number(root.querySelector('.day-of-month-input').value);
    return Number.isInteger(dayOfMonth) && dayOfMonth >= 1 && dayOfMonth <= 31 ? { type, dayOfMonth } : null;
  }
  if (type === 'once') {
    const date = root.querySelector('.once-date-input').value;
    return date ? { type, date } : null;
  }
  return { type: 'daily' };
}

// ---- Motion helpers ----
function prefersReducedMotion() {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// Adds an animation class, resolves when it finishes (with a timeout as a
// safety net), and always cleans the class up.
function playAnimation(el, className) {
  return new Promise(resolve => {
    if (prefersReducedMotion()) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      el.removeEventListener('animationend', onEnd);
      el.classList.remove(className);
      resolve();
    };
    const onEnd = (e) => {
      if (e.target === el) done();
    };
    // Safety net only: if animationend never arrives (app backgrounded
    // mid-slide, say) the UI must not hang. Generous so it never cuts a slide short.
    const timer = setTimeout(done, 1000);
    el.addEventListener('animationend', onEnd);
    el.classList.add(className);
  });
}

function bounce(el) {
  if (!el) return;
  el.classList.remove('just-selected');
  void el.offsetWidth; // restart the animation if it's already running
  el.classList.add('just-selected');
  el.addEventListener('animationend', () => el.classList.remove('just-selected'), { once: true });
}

// Push navigation: the incoming screen slides in from the right while the
// outgoing one slides off to the left.
function pushScreen(incoming, outgoing) {
  incoming.hidden = false;
  return Promise.all([
    playAnimation(incoming, 'anim-in-right'),
    playAnimation(outgoing, 'anim-out-left'),
  ]);
}

// Back navigation: the reverse. The leaving screen is hidden in the same
// tick its animation ends, so it can't flash back at its resting position.
function popScreen(leaving, returning) {
  return Promise.all([
    playAnimation(leaving, 'anim-out-right').then(() => { leaving.hidden = true; }),
    playAnimation(returning, 'anim-in-left'),
  ]);
}

const CONFETTI_COLORS = ['#ffffff', '#ffe08a', '#ffb3c1', '#c7f0ff', '#d9ccff'];

// Particles are generated here, but the motion itself is pure CSS keyframes.
// `count` lets the "all done for today" moment fire a fuller burst than an
// individual milestone without needing a second implementation.
function burstConfetti(target = confettiEl, count = 24) {
  target.innerHTML = '';
  if (prefersReducedMotion()) return;
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + Math.random() * 0.4;
    const distance = 90 + Math.random() * 80;
    const piece = document.createElement('span');
    piece.style.setProperty('--dx', `${Math.cos(angle) * distance}px`);
    piece.style.setProperty('--dy', `${Math.sin(angle) * distance - 30}px`); // slight upward bias
    piece.style.setProperty('--rot', `${Math.round(Math.random() * 540 - 270)}deg`);
    piece.style.setProperty('--delay', `${Math.round(Math.random() * 120)}ms`);
    piece.style.setProperty('--c', CONFETTI_COLORS[i % CONFETTI_COLORS.length]);
    target.appendChild(piece);
  }
}

// ---- Reminder color picker ----
// One swatch per palette color, plus a leading "match the app theme" swatch
// (value null) — the look every reminder had before colors existed.
function renderColorSwatches(selectedId) {
  const auto = `<button type="button" class="color-swatch color-swatch--auto${selectedId ? '' : ' selected'}" data-color="" aria-label="Match app theme" title="Match app theme"></button>`;
  const swatches = REMINDER_COLORS.map(c => `
    <button type="button" class="color-swatch${c.id === selectedId ? ' selected' : ''}" data-color="${c.id}" style="--sw:${c.hex}${c.dark ? `;--sw-dark:${c.dark}` : ''}" aria-label="${c.label}" title="${c.label}"></button>
  `).join('');
  return auto + swatches;
}

function wireColorSwatches(container, onChange) {
  container.querySelectorAll('.color-swatch').forEach(btn => {
    btn.addEventListener('click', () => {
      container.querySelectorAll('.color-swatch').forEach(b => b.classList.toggle('selected', b === btn));
      bounce(btn);
      if (onChange) onChange(btn.dataset.color || null);
    });
  });
}

function readColorFromContainer(container) {
  return normalizeReminderColor(container.querySelector('.color-swatch.selected')?.dataset.color);
}

function renderAddFormColor() {
  colorFieldsEl.innerHTML = renderColorSwatches(reminderDefaults.defaultColor);
  wireColorSwatches(colorFieldsEl);
}

function ordinal(n) {
  if (n % 10 === 1 && n !== 11) return `${n}st`;
  if (n % 10 === 2 && n !== 12) return `${n}nd`;
  if (n % 10 === 3 && n !== 13) return `${n}rd`;
  return `${n}th`;
}

function describeRecurrence(recurrence) {
  const type = recurrence?.type || 'daily';
  if (type === 'daysOfWeek') {
    return [...recurrence.daysOfWeek].sort((a, b) => a - b).map(d => WEEKDAY_SHORT[d]).join(', ');
  }
  if (type === 'monthlyDate') {
    return `Monthly on the ${ordinal(recurrence.dayOfMonth)}`;
  }
  if (type === 'once') {
    const [y, m, d] = recurrence.date.split('-').map(Number);
    return `Once · ${new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  }
  return null;
}

// ---- Date helpers ----
function formatTime(time) {
  const [h, m] = time.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${period}`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ---- Storage ----
async function loadReminders() {
  try {
    const loaded = await storage.load();
    reminders = loaded.reminders;
    nextId = loaded.nextId;
    if (!loaded.saveAllowed) blockedNotice = loaded.notice;
  } catch (e) {
    // Should not happen (the store handles its own errors), but a failed load
    // must never end with an empty list being saved over real data.
    console.error('Could not load reminders', e);
    storage.blockSaving();
    reminders = [];
    nextId = 1;
    blockedNotice = { kind: 'storage_unreadable' };
  }
}

// Shows the "we recovered your data" message, from this launch or an earlier
// one the user hasn't dismissed yet.
async function refreshRecoveryNotice() {
  const notice = blockedNotice || await storage.getNotice();
  const text = describeNotice(notice);
  recoveryBannerText.textContent = text;
  recoveryBanner.hidden = !text;
  recoveryExportEl.hidden = !(await storage.collectRecoveryData());
}

// Settings → Privacy: copies everything set aside during a recovery.
recoveryCopyBtn.addEventListener('click', async () => {
  const data = await storage.collectRecoveryData();
  if (!data) { recoveryExportEl.hidden = true; return; }
  try {
    await navigator.clipboard.writeText(data.text);
    showToast('Copied. Paste it into Notes or an email to keep it.');
  } catch {
    showToast("Couldn't copy. Try again.");
  }
});

async function saveReminders() {
  return storage.saveReminders(reminders);
}

// Checking off and un-marking: if it didn't reach storage, say so rather than
// show a checkmark that will be gone after a relaunch.
async function saveCheckOff() {
  const saved = await saveReminders();
  if (!saved.saved) showToast("Couldn't save that change. Check your storage and try again.");
  return saved;
}

// ---- Personalization ----
async function loadUserName() {
  const { value } = await Preferences.get({ key: USER_NAME_KEY });
  userName = value || null;
}

async function saveUserName(name) {
  userName = name || null;
  if (userName) {
    await Preferences.set({ key: USER_NAME_KEY, value: userName });
  } else {
    await Preferences.remove({ key: USER_NAME_KEY });
  }
  await syncAlerts(); // the name is part of the alert text
}

async function loadGreetingStyle() {
  const { value } = await Preferences.get({ key: GREETING_STYLE_KEY });
  greetingStyle = normalizeGreetingStyle(value);
}

async function saveGreetingStyle(style) {
  greetingStyle = normalizeGreetingStyle(style);
  await Preferences.set({ key: GREETING_STYLE_KEY, value: greetingStyle });
}

function renderGreeting() {
  greetingEl.textContent = getContextualGreeting({
    style: greetingStyle,
    pendingTitles: getPendingToday(reminders).map(r => r.name),
    name: userName,
  });
}

// ---- App icon badge ----
// Count of reminders whose time has passed today and aren't taken yet. Runs
// off the reminder list alone — no name or preference dependency. Only talks
// to the plugin when the count actually changes, because on iOS clearing the
// badge also clears delivered notifications from Notification Center.
let lastBadgeCount = null;

async function updateBadge() {
  const count = countBadge(reminders);
  if (count === lastBadgeCount) return;
  lastBadgeCount = count;
  try {
    if (count > 0) {
      await Badge.set({ count });
    } else {
      await Badge.clear();
    }
  } catch (e) {
    // Unsupported (plain browser) or badge permission not granted yet.
    console.warn('Could not update badge', e);
  }
  // The first badge call is what makes iOS show its permission prompt. If the
  // last sync ran while that was still undecided, the answer is in by now.
  if (lastAlertPermission === 'prompt') syncAlerts();
}

let milestoneTimer = null;

function showMilestoneModal(streak) {
  const message = getMilestoneMessage(streak, userName);
  if (!message) return;
  clearTimeout(milestoneTimer);
  milestoneMessageEl.textContent = message;
  if (isConfettiMilestone(streak)) {
    burstConfetti();
  } else {
    confettiEl.innerHTML = '';
  }
  milestoneModal.hidden = false;
  milestoneTimer = setTimeout(() => {
    milestoneModal.hidden = true;
  }, 3500);
}

// Low-pressure by design: a toast, not a modal — no backdrop, no dismiss
// button, gone on its own well before it could feel naggy.
let toastTimer = null;

function showToast(message) {
  clearTimeout(toastTimer);
  toastMessageEl.textContent = message;
  toastEl.hidden = false;
  toastTimer = setTimeout(() => {
    toastEl.hidden = true;
  }, 3000);
}

// ---- Appearance (accent theme) ----
async function loadAccentTheme() {
  const { value } = await Preferences.get({ key: ACCENT_THEME_KEY });
  accentTheme = ACCENT_THEMES[value] ? value : DEFAULT_ACCENT_THEME;
}

// Light / dark. 'system' follows iOS live (the media query listener below);
// light and dark force it. The resolved scheme lands on <html data-scheme>,
// which style.css keys its dark tokens off, and also picks which accent
// variant applyAccentTheme uses.
const systemDarkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function currentScheme() {
  return resolveScheme(appearance, systemDarkQuery.matches);
}

async function loadAppearance() {
  const { value } = await Preferences.get({ key: APPEARANCE_KEY });
  appearance = normalizeAppearance(value);
}

async function saveAppearance(mode) {
  appearance = normalizeAppearance(mode);
  await Preferences.set({ key: APPEARANCE_KEY, value: appearance });
  applyAccentTheme();
}

systemDarkQuery.addEventListener('change', () => {
  if (appearance === 'system') applyAccentTheme();
});

// Sets the CSS custom properties every accent-colored rule in style.css
// reads from, plus the light/dark scheme they sit on. Called on init (before
// render, to avoid a flash of the default color) and again immediately
// whenever the theme or appearance changes.
function applyAccentTheme() {
  const scheme = currentScheme();
  const theme = getAccentTheme(accentTheme, scheme);
  const rootEl = document.documentElement;
  rootEl.dataset.scheme = scheme;
  const root = rootEl.style;
  root.setProperty('--accent-color', theme.accent);
  root.setProperty('--accent-color-dark', theme.accentDark);
  root.setProperty('--accent-color-light', theme.accentLight);
}

async function saveAccentTheme(id) {
  accentTheme = ACCENT_THEMES[id] ? id : DEFAULT_ACCENT_THEME;
  await Preferences.set({ key: ACCENT_THEME_KEY, value: accentTheme });
  applyAccentTheme();
}

// ---- Reminder defaults (grace period, notification sound) ----
async function loadReminderDefaults() {
  const { value } = await storage.loadSetting(REMINDER_DEFAULTS_KEY, parseReminderDefaults);
  reminderDefaults = value;
}

async function saveReminderDefaults(next) {
  reminderDefaults = next;
  await Preferences.set({ key: REMINDER_DEFAULTS_KEY, value: JSON.stringify(reminderDefaults) });
}

// ---- Quiet hours ----
async function loadQuietHours() {
  const { value } = await storage.loadSetting(QUIET_HOURS_KEY, parseQuietHours);
  quietHours = value;
}

async function saveQuietHours(next) {
  quietHours = next;
  await Preferences.set({ key: QUIET_HOURS_KEY, value: JSON.stringify(quietHours) });
  await syncAlerts(); // alerts already on the phone must pick up the new quiet hours
}

// ---- Settings screen rendering ----
// Same convention as the recurrence fields: render an innerHTML block from
// current state, then wire it — re-run on open and after every change so the
// selected state always reflects what's actually saved.
function renderOnOffToggle(container, value, onChange) {
  container.innerHTML = `
    <button type="button" class="segmented-btn${value ? ' selected' : ''}" data-value="true">On</button>
    <button type="button" class="segmented-btn${!value ? ' selected' : ''}" data-value="false">Off</button>
  `;
  container.querySelectorAll('.segmented-btn').forEach(btn => {
    btn.addEventListener('click', () => onChange(btn.dataset.value === 'true'));
  });
}

function renderSettingsScreen() {
  greetingStyleToggleEl.innerHTML = GREETING_STYLES.map(style => `
    <button type="button" class="segmented-btn${style.value === greetingStyle ? ' selected' : ''}" data-style="${style.value}">${style.label}</button>
  `).join('');
  greetingStyleToggleEl.querySelectorAll('.segmented-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await saveGreetingStyle(btn.dataset.style);
      renderSettingsScreen();
      renderGreeting();
    });
  });

  appearanceToggleEl.innerHTML = APPEARANCE_MODES.map(mode => `
    <button type="button" class="segmented-btn${mode.value === appearance ? ' selected' : ''}" data-mode="${mode.value}">${mode.label}</button>
  `).join('');
  appearanceToggleEl.querySelectorAll('.segmented-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await saveAppearance(btn.dataset.mode);
      renderSettingsScreen();
    });
  });

  themeSwatchesEl.innerHTML = Object.entries(ACCENT_THEMES).map(([id, theme]) => `
    <button type="button" class="theme-swatch${id === accentTheme ? ' selected' : ''}" data-theme="${id}" style="background:${getAccentTheme(id, currentScheme()).accent}" aria-label="${theme.label} theme"></button>
  `).join('');
  themeSwatchesEl.querySelectorAll('.theme-swatch').forEach(btn => {
    btn.addEventListener('click', async () => {
      const themeId = btn.dataset.theme;
      await saveAccentTheme(themeId);
      renderSettingsScreen();
      bounce(themeSwatchesEl.querySelector(`[data-theme="${themeId}"]`));
    });
  });

  graceOptionsEl.innerHTML = GRACE_PERIOD_OPTIONS.map(hours => `
    <button type="button" class="segmented-btn${hours === reminderDefaults.gracePeriodHours ? ' selected' : ''}" data-hours="${hours}">${hours === 0 ? 'None' : hours + 'h'}</button>
  `).join('');
  graceOptionsEl.querySelectorAll('.segmented-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      await saveReminderDefaults({ ...reminderDefaults, gracePeriodHours: Number(btn.dataset.hours) });
      renderSettingsScreen();
      render(); // grace period affects the isOnGrace badge shown on each reminder
    });
  });

  defaultColorEl.innerHTML = renderColorSwatches(reminderDefaults.defaultColor);
  wireColorSwatches(defaultColorEl, async (id) => {
    await saveReminderDefaults({ ...reminderDefaults, defaultColor: id });
    renderAddFormColor(); // new reminders start from the new default
  });

  renderOnOffToggle(soundToggleEl, reminderDefaults.soundEnabled, async (enabled) => {
    await saveReminderDefaults({ ...reminderDefaults, soundEnabled: enabled });
    await syncAlerts(); // alerts already on the phone must pick up the new sound setting
    renderSettingsScreen();
  });

  renderOnOffToggle(quietHoursToggleEl, quietHours.enabled, async (enabled) => {
    await saveQuietHours({ ...quietHours, enabled });
    renderSettingsScreen();
  });
  quietHoursRangeEl.hidden = !quietHours.enabled;
  quietHoursStartInput.value = quietHours.start;
  quietHoursEndInput.value = quietHours.end;
}

quietHoursStartInput.addEventListener('change', async () => {
  await saveQuietHours({ ...quietHours, start: quietHoursStartInput.value });
});

quietHoursEndInput.addEventListener('change', async () => {
  await saveQuietHours({ ...quietHours, end: quietHoursEndInput.value });
});

// ---- Onboarding ----
onboardingNameInput.addEventListener('input', () => {
  onboardingContinueBtn.disabled = onboardingNameInput.value.trim().length === 0;
});

async function finishOnboarding(name) {
  await saveUserName(name);
  await Preferences.set({ key: ONBOARDED_KEY, value: 'true' });
  renderGreeting();
  render();
  // Onboarding exits left as the home screen enters from the right.
  await Promise.all([
    playAnimation(onboardingScreen, 'anim-out-left').then(() => { onboardingScreen.hidden = true; }),
    playAnimation(appEl, 'anim-in-right'),
  ]);
}

onboardingContinueBtn.addEventListener('click', () => {
  const name = onboardingNameInput.value.trim();
  if (!name) return;
  finishOnboarding(name);
});

onboardingSkipBtn.addEventListener('click', () => finishOnboarding(null));

// ---- Settings ----
function showSettingsTab(tab) {
  activeSettingsTab = tab;
  settingsTabsEl.querySelectorAll('.segmented-btn').forEach(btn => {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle('selected', active);
    btn.setAttribute('aria-selected', String(active));
  });
  // Panels share one grid cell, so toggling this class cross-fades them.
  settingsScreen.querySelectorAll('.settings-panel').forEach(panel => {
    panel.classList.toggle('is-active', panel.dataset.panel === tab);
  });
}

settingsTabsEl.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-tab]');
  if (btn) showSettingsTab(btn.dataset.tab);
});

// Every full-screen screen (settings, add, edit) opens and closes through
// these, so they all share the same slide and can't be triggered mid-slide.
let screenBusy = false;

// `from` is the screen underneath: the home list by default, or the detail
// screen when Edit is opened from it (so Back returns there, not home).
async function openScreen(screen, prepare, from = appEl) {
  if (screenBusy) return false;
  screenBusy = true;
  if (prepare) prepare();
  await pushScreen(screen, from);
  screenBusy = false;
  return true;
}

async function closeScreen(screen, to = appEl) {
  if (screenBusy) return false;
  screenBusy = true;
  await popScreen(screen, to);
  screenBusy = false;
  return true;
}

settingsBtn.addEventListener('click', () => openScreen(settingsScreen, () => {
  settingsNameInput.value = userName || '';
  renderSettingsScreen();
  showSettingsTab(activeSettingsTab);
}));

settingsCloseBtn.addEventListener('click', () => closeScreen(settingsScreen));

settingsNameInput.addEventListener('blur', async () => {
  await saveUserName(settingsNameInput.value.trim());
  renderGreeting();
  render();
});

// ---- Notifications ----
// Scheduling lives in notifications.js. This section only shows the outcome:
// the "Enable" banner (permission not asked yet), the alert banner (denied, or
// some alerts could not be scheduled) and a warning badge on affected rows.
let alertBadges = new Map(); // reminder id -> why its alert is not working
let lastAlertPermission = null; // what the last sync saw: 'granted' | 'denied' | 'prompt' | 'unavailable'

function applyAlertResult(result) {
  if (!result) return;
  const summary = summarizeAlerts(result, reminders);
  lastAlertPermission = result.permission;
  permissionBanner.hidden = summary.kind !== 'prompt';
  const text = alertBannerText(summary);
  alertBannerEl.hidden = !text;
  alertBannerMessageEl.textContent = text;
  alertRetryBtn.textContent = summary.kind === 'denied' ? 'Check again' : 'Retry';
  const changed = [...summary.badges].join() !== [...alertBadges].join();
  alertBadges = summary.badges;
  if (changed) render();
}

// Compares what the phone has scheduled with the saved reminders and settings,
// fixes any difference, and shows the result. Safe to call at any time, and as
// often as needed: asking twice changes nothing the second time.
async function syncAlerts() {
  const result = await actions.syncAlerts();
  applyAlertResult(result);
  return result;
}

// Shows what happened after an add / edit / delete. Saving and alerting are
// separate outcomes: a reminder whose alert failed is still saved.
function reportOutcome({ saved, alerts }) {
  if (saved && !saved.saved) showToast("Couldn't save that change. Check your storage and try again.");
  applyAlertResult(alerts);
}

// A notification that arrives while the app is open doesn't touch the badge
// (see presentationOptions in capacitor.config.json); just re-count.
LocalNotifications.addListener('localNotificationReceived', () => updateBadge()).catch(() => {
  // Not running in the native shell (plain browser preview).
});

const NOTIF_HIGHLIGHT_MS = 1800; // matches --dur-highlight in style.css

// On a cold start the tap can fire before init() has finished loading
// reminders and building rows — poll for the row rather than giving up the
// instant it isn't there yet.
function waitForRow(reminderId, { timeout = 6000, interval = 120 } = {}) {
  return new Promise(resolve => {
    const find = () => listEl.querySelector(`.swipe-row[data-reminder-id="${reminderId}"]`);
    const started = Date.now();
    const tick = () => {
      const row = find();
      if (row) { resolve(row); return; }
      if (Date.now() - started >= timeout) { resolve(null); return; }
      setTimeout(tick, interval);
    };
    tick();
  });
}

async function highlightFromNotification(reminderId) {
  // The row only exists on the tab it belongs to, so go there first.
  const reminder = reminders.find(r => r.id === reminderId);
  if (reminder && appliesToday(reminder)) {
    setView(reminder.takenDate === todayKey() ? 'done' : 'today');
  }
  const row = await waitForRow(reminderId);
  if (!row) return; // reminder was deleted, or never rendered within the timeout
  row.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const target = row.querySelector('.reminder-item');
  target.classList.remove('notif-highlight');
  void target.offsetWidth; // restart the animation if a previous tap is still fading
  target.classList.add('notif-highlight');
  setTimeout(() => target.classList.remove('notif-highlight'), NOTIF_HIGHLIGHT_MS);
}

// "Mark Taken" pressed on a notification. It never un-takes: an already-done
// reminder (a double press, or a late duplicate) is left alone. iOS may hand
// the press over late (e.g. the next morning), so resolveMarkTaken decides
// which day it counts for: today goes through completeReminder(), the very
// function the in-app check-off uses; an earlier day is credited to that day
// only, so today's dose is never marked taken by yesterday's press.
async function markTakenFromNotification(reminderId, snoozeDay = null) {
  await appReady;
  const decision = resolveMarkTaken(reminders.find(r => r.id === reminderId), new Date(), { snoozeDay });
  if (decision.kind === 'complete_today') {
    await completeReminder(reminderId);
  } else if (decision.kind === 'credit_past') {
    const idx = reminders.findIndex(r => r.id === reminderId);
    reminders[idx] = creditPastDay(reminders[idx], decision.day, graceOccurrencesForHours(reminderDefaults.gracePeriodHours));
    await saveCheckOff();
    render();
  }
}

// Tapping a delivered notification opens the app (default Capacitor
// behavior) — this is what scrolls to and highlights the specific reminder
// it was for, found via the reminderId in each alert's extra (see notifications.js).
// Pressing its "Mark Taken" button marks it done instead (see above).
LocalNotifications.addListener('localNotificationActionPerformed', (action) => {
  const route = classifyNotificationAction(action);
  if (route.kind === 'mark_taken') markTakenFromNotification(route.reminderId, route.snoozeDay);
  else if (route.kind === 'open') highlightFromNotification(route.reminderId);
}).catch(() => {
  // Not running in the native shell (plain browser preview).
});

alertRetryBtn.addEventListener('click', () => syncAlerts());

recoveryDismissBtn.addEventListener('click', async () => {
  recoveryBanner.hidden = true;
  if (!blockedNotice) await storage.dismissNotice(); // a session-only notice has nothing stored to clear
});

enableNotifsBtn.addEventListener('click', async () => {
  try {
    const result = await LocalNotifications.requestPermissions();
    await syncAlerts(); // schedules everything if allowed, or shows the "turned off" guidance if not
    if (result.display === 'granted') {
      lastBadgeCount = null; // badge permission is granted along with notifications
      updateBadge();
    }
  } catch (e) {
    console.error('Could not request notification permission', e);
  }
});

// ---- CRUD ----
async function addReminder(name, time, recurrence, color, notes, subtasks = [], importance = 'normal') {
  const outcome = await actions.add({ name, time, recurrence, color, notes, subtasks, importance });
  if (outcome.error === 'ids_exhausted') {
    showToast("Can't add more reminders: the app has run out of reminder numbers.");
    return false;
  }
  reportOutcome(outcome);
  if (!outcome.saved.saved) return false; // not added: keep the form so nothing typed is lost
  // Show the tab the new reminder lives on, so it doesn't seem to vanish.
  setView(appliesToday(outcome.reminder) ? 'today' : 'upcoming');
  return true;
}

// The in-app check-off: tapping the circle, swiping, and "Mark complete" all
// come through here. Taps it again to un-take.
async function toggleTaken(id) {
  const reminder = reminders.find(r => r.id === id);
  if (!reminder) return;
  if (!isFinished(reminder)) {
    await completeReminder(id);
    return;
  }
  reminders[reminders.indexOf(reminder)] = untakeToday(reminder, todayKey()); // gives back the streak credit too
  await saveCheckOff();
  syncAlerts(); // an un-marked one-time reminder needs its alert back
  render();
}

// Marks a reminder taken today and updates its streak (with the grace period).
// This is the one place that happens: the in-app check-off calls it, and so
// does the notification's "Mark Taken" button. Callers decide whether the
// reminder should be completed; this always completes it.
async function completeReminder(id) {
  const idx = reminders.findIndex(r => r.id === id);
  if (idx === -1) return;
  const reminder = reminders[idx];
  const today = todayKey();
  const previousStreak = reminder.currentStreak;
  justTakenId = id;
  reminders[idx] = takeToday(reminder, today, graceOccurrencesForHours(reminderDefaults.gracePeriodHours));
  const newStreak = reminders[idx].currentStreak;
  if (newStreak > previousStreak) {
    justIncrementedStreakId = id; // real increment this session — the ring pops
    if (isStreakMilestone(newStreak)) {
      showMilestoneModal(newStreak);
    } else if (isStreakAcknowledgment(newStreak)) {
      showToast(getStreakAcknowledgment(newStreak, userName));
    }
  }
  await saveCheckOff();
  syncAlerts(); // done now, so a pending snooze is dropped and shouldn't ping later
  render();
  justTakenId = null;
  justIncrementedStreakId = null;
  // On the Today tab the completed row lingers so its animation can play;
  // once that's had time to finish, a fresh render moves it over to Done.
  if (activeView === 'today') setTimeout(() => render(), COMPLETE_LINGER_MS);
}

const COMPLETE_LINGER_MS = 1400;

async function deleteReminder(id) {
  if (openSwipeId === id) openSwipeId = null;
  reportOutcome(await actions.remove(id));
  render({ animateEntrance: true });
}

async function updateReminder(id, name, time, recurrence, color, notes, importance = 'normal') {
  const outcome = await actions.update(id, { name, time, recurrence, color, notes, importance });
  if (outcome.error) return false;
  reportOutcome(outcome);
  if (!outcome.saved.saved) return false; // not changed: keep the form so the edit isn't lost
  editingId = null;
  render();
  return true;
}

// ---- Streak ring + swipe-to-delete ----
const RING_RADIUS = 17;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

function closeOpenSwipe() {
  const row = listEl.querySelector('.swipe-row.is-open');
  openSwipeId = null;
  if (!row) return;
  row.classList.remove('is-open', 'is-swiping');
  row.querySelector('.reminder-item').style.transform = '';
}

// Horizontal drag on a row: follows the finger, then snaps open/closed
// (leftward, delete — see resolveSwipeSnap) or commits/springs-back
// (rightward, complete — see shouldCompleteOnRelease). Vertical drags are
// left alone so the list still scrolls. `taken` disables the rightward
// gesture — completing an already-completed reminder isn't a thing swipe
// should do (tap-to-undo still works).
function wireSwipe(row, item, id, taken) {
  let tracking = false;
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startOffset = 0;
  let lastOffset = 0;
  let rowWidth = 0;
  let suppressClick = false;

  item.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (openSwipeId !== null && openSwipeId !== id) closeOpenSwipe();
    tracking = true;
    dragging = false;
    startX = e.clientX;
    startY = e.clientY;
    startOffset = openSwipeId === id ? -SWIPE_ACTION_WIDTH : 0;
    lastOffset = startOffset;
    rowWidth = row.getBoundingClientRect().width;
  });

  item.addEventListener('pointermove', (e) => {
    if (!tracking) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (!dragging) {
      if (Math.abs(dy) > 10 && Math.abs(dy) > Math.abs(dx)) {
        tracking = false; // it's a scroll, not a swipe
        return;
      }
      if (Math.abs(dx) < 8) return;
      dragging = true;
      row.classList.add('is-dragging', 'is-swiping');
      item.setPointerCapture(e.pointerId);
    }
    const target = startOffset + dx;
    lastOffset = target <= 0 ? clampSwipe(target) : (taken ? 0 : clampCompleteSwipe(target, rowWidth));
    item.style.transform = `translateX(${lastOffset}px)`;
  });

  const finish = () => {
    if (!tracking) return;
    tracking = false;
    if (!dragging) return;
    dragging = false;
    suppressClick = true;
    setTimeout(() => { suppressClick = false; }, 50);
    row.classList.remove('is-dragging');

    if (lastOffset > 0) {
      if (shouldCompleteOnRelease(lastOffset, rowWidth)) {
        commitComplete(row, item, id, rowWidth);
      } else {
        row.classList.remove('is-swiping');
        item.style.transform = '';
      }
      return;
    }

    if (resolveSwipeSnap(lastOffset) === 'open') {
      openSwipeId = id;
      row.classList.add('is-open', 'is-swiping');
      item.style.transform = `translateX(-${SWIPE_ACTION_WIDTH}px)`;
    } else {
      if (openSwipeId === id) openSwipeId = null;
      row.classList.remove('is-open', 'is-swiping');
      item.style.transform = '';
    }
  };
  item.addEventListener('pointerup', finish);
  item.addEventListener('pointercancel', finish);

  // Capture phase: swallow the click that ends a drag, and make a tap on an
  // open row close it instead of triggering whatever was underneath.
  item.addEventListener('click', (e) => {
    if (suppressClick) {
      e.stopPropagation();
      e.preventDefault();
    } else if (openSwipeId === id) {
      e.stopPropagation();
      e.preventDefault();
      closeOpenSwipe();
    }
  }, true);
}

// Past the threshold: finish sliding the content clear and fade it so the
// teal fill reads as "done", then actually mark it taken once that's
// visually settled — same pin-then-commit shape as removeWithAnimation.
function commitComplete(row, item, id, rowWidth) {
  row.classList.add('is-committing');
  item.style.transform = `translateX(${rowWidth}px)`;
  item.style.opacity = '0';
  setTimeout(() => toggleTaken(id), 280);
}

function completeSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
}

document.addEventListener('pointerdown', (e) => {
  if (openSwipeId !== null && !e.target.closest('.swipe-row.is-open')) closeOpenSwipe();
});

// Pins the row's height so it can transition to 0, then deletes for real once
// the collapse finishes (with a timeout fallback).
function removeWithAnimation(row, id) {
  if (row.classList.contains('is-removing')) return;
  row.style.height = `${row.offsetHeight}px`;
  void row.offsetHeight;
  row.classList.add('is-removing');
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    deleteReminder(id);
  };
  row.addEventListener('transitionend', (e) => {
    if (e.target === row && e.propertyName === 'height') finish();
  });
  setTimeout(finish, 450);
}

function checkSvg(animate) {
  return `<svg class="check-svg${animate ? ' check-svg--draw' : ''}" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" pathLength="1"/></svg>`;
}

// Only the moment it *becomes* fully done plays the entrance + bigger
// confetti burst; staying done across unrelated re-renders does nothing,
// and it reverts cleanly (new reminder added, one unmarked/edited back) the
// instant that's no longer true.
function updateAllDoneBanner() {
  const allDoneNow = isAllDoneToday(reminders);
  // The celebration belongs to the Today tab; elsewhere it stays hidden but
  // the transition is still tracked so switching tabs doesn't replay it.
  if (allDoneNow && activeView === 'today') {
    allDoneBannerEl.hidden = false;
    if (!wasAllDoneToday) {
      playAnimation(allDoneBannerEl, 'all-done-enter');
      burstConfetti(allDoneConfettiEl, 40); // fuller than an individual milestone's 24
    }
  } else {
    allDoneBannerEl.hidden = true;
    allDoneConfettiEl.innerHTML = '';
  }
  wasAllDoneToday = allDoneNow;
}

// ---- Home tabs ----
const EMPTY_VIEW_MESSAGES = {
  today: 'Nothing due today.',
  upcoming: 'Nothing coming up.',
  done: 'Nothing completed yet today.',
};

// What the active tab lists. A reminder checked off on the Today tab stays
// put for a moment (justTakenId) so its checkmark and streak ring can finish
// animating instead of vanishing the instant it's done.
function remindersForView() {
  const list = filterForView(reminders, activeView);
  if (activeView === 'today' && justTakenId !== null && !list.some(r => r.id === justTakenId)) {
    const lingering = reminders.find(r => r.id === justTakenId);
    if (lingering) {
      list.push(lingering);
      list.sort((a, b) => a.time.localeCompare(b.time));
    }
  }
  return list;
}

function setView(view) {
  activeView = view;
  openSwipeId = null;
  viewTabsEl.querySelectorAll('.view-tab').forEach(btn => {
    const selected = btn.dataset.view === view;
    btn.classList.toggle('selected', selected);
    btn.setAttribute('aria-selected', String(selected));
  });
  render({ animateEntrance: true });
}

viewTabsEl.addEventListener('click', (e) => {
  const tab = e.target.closest('[data-view]');
  if (tab && tab.dataset.view !== activeView) setView(tab.dataset.view);
});

// ---- One-time reminders from earlier days ----
// "Overdue" tops the Today tab; "Completed" sits collapsed under Done. Neither
// completes, reschedules or deletes anything by itself: a reminder leaves
// Overdue only when the user checks it off, edits it or deletes it.
let completedOpen = false;

function buildPastRow(reminder, kind) {
  const finished = kind === 'completed';
  const dayLabel = finished
    ? `Done ${describeDay(dateFromKey(reminder.takenDate))}`
    : `Was due ${describeDay(oneTimeDay(reminder))} · ${formatTime(reminder.time)}`;
  const item = document.createElement('div');
  item.className = 'reminder-item past-row' + (finished ? ' taken' : '');
  item.dataset.reminderId = reminder.id;
  item.innerHTML = `
    <button class="check-btn" aria-label="${finished ? 'Mark not taken' : 'Mark taken'}">${finished ? checkSvg(false) : ''}</button>
    <div class="reminder-info">
      <span class="reminder-name">${escapeHtml(reminder.name)}</span>
      <span class="reminder-time">${dayLabel}</span>
    </div>
    <button class="delete-btn" aria-label="Delete">✕</button>
  `;
  item.querySelector('.check-btn').addEventListener('click', () => toggleTaken(reminder.id));
  item.querySelector('.reminder-info').addEventListener('click', () => openDetail(reminder.id));
  item.querySelector('.delete-btn').addEventListener('click', () => deleteReminder(reminder.id));
  return item;
}

function renderPastSections() {
  const overdue = activeView === 'today' ? getOverdueOneTime(reminders) : [];
  overdueSectionEl.hidden = overdue.length === 0;
  overdueCountEl.textContent = overdue.length ? `· ${overdue.length}` : '';
  overdueListEl.replaceChildren(...overdue.map(r => buildPastRow(r, 'overdue')));

  const completed = activeView === 'done' ? getCompletedOneTime(reminders) : [];
  completedSectionEl.hidden = completed.length === 0;
  completedCountEl.textContent = completed.length ? `· ${completed.length}` : '';
  completedToggleEl.setAttribute('aria-expanded', String(completedOpen));
  completedListEl.hidden = !completedOpen;
  completedListEl.replaceChildren(...(completedOpen ? completed.map(r => buildPastRow(r, 'completed')) : []));
}

completedToggleEl.addEventListener('click', () => {
  completedOpen = !completedOpen;
  render();
});

// ---- Rendering ----
// animateEntrance: true only for renders where the list's actual *contents*
// just changed (initial load, add, delete) — every other render (toggling,
// editing, settings, theme, badge resync) rebuilds the DOM the same way but
// skips the stagger, so it doesn't replay just because something unrelated
// updated.
function render({ animateEntrance = false } = {}) {
  skeletonEl.remove(); // real data is here; no-op after the first render
  listEl.innerHTML = '';
  renderPastSections();
  const today = todayKey();
  renderGreeting();
  updateBadge();
  updateAllDoneBanner();
  todayActions.hidden = !(activeView === 'today' && getPendingToday(reminders).length > 0);

  const visible = remindersForView();
  const emptyMessage = reminders.length === 0 ? getEmptyStateMessage(userName) : EMPTY_VIEW_MESSAGES[activeView];
  // With reminders but nothing due on the Today tab and everything done, the
  // all-done banner already says it; a second empty message would be noise.
  const bannerCoversIt = activeView === 'today' && reminders.length > 0 && isAllDoneToday(reminders);
  const showEmpty = visible.length === 0 && !bannerCoversIt;
  emptyStateEl.querySelector('#emptyStateMessage').textContent = emptyMessage;
  emptyStateSubEl.hidden = !(reminders.length === 0 || activeView === 'today');
  emptyStateEl.hidden = !showEmpty;

  visible.forEach((reminder, index) => {
    const taken = reminder.takenDate === today;
    const upcoming = activeView === 'upcoming';
    const item = document.createElement('div');
    let node = item;
    let ringTargetOffset = null;

    const onGrace = isOnGrace(reminder, today, graceOccurrencesForHours(reminderDefaults.gracePeriodHours));
    let streakRing = '';
    if (isStreakEligible(reminder)) {
      const progress = ringProgress(reminder.currentStreak);
      // Start from the last rendered fill so a changed count animates; a
      // first render (or unchanged count) has nothing to animate.
      const previous = ringProgressById.has(reminder.id) ? ringProgressById.get(reminder.id) : progress;
      ringProgressById.set(reminder.id, progress);
      if (reminder.currentStreak > 0) {
        ringTargetOffset = ringDashOffset(progress, RING_CIRCUMFERENCE);
        const popping = justIncrementedStreakId === reminder.id;
        streakRing = `
          <span class="streak-ring${onGrace ? ' streak-ring--grace' : ''}${popping ? ' is-popping' : ''}" title="Longest streak: ${reminder.longestStreak} day${reminder.longestStreak === 1 ? '' : 's'}">
            <svg viewBox="0 0 38 38" aria-hidden="true">
              <circle class="ring-track" cx="19" cy="19" r="${RING_RADIUS}"/>
              <circle class="ring-fill" cx="19" cy="19" r="${RING_RADIUS}" stroke-dasharray="${RING_CIRCUMFERENCE}" style="stroke-dashoffset:${ringDashOffset(previous, RING_CIRCUMFERENCE)}"/>
            </svg>
            <span class="streak-ring-count">${reminder.currentStreak}</span>
          </span>`;
      }
    }
    const recurrenceLabel = describeRecurrence(reminder.recurrence);
    const colorHex = getReminderColorHex(reminder.color);
    item.className = 'reminder-item' + (taken ? ' taken' : '') + (colorHex ? ' has-color' : '');
    if (colorHex) {
      item.style.setProperty('--reminder-color', colorHex);
      const darkHex = getReminderColorDarkHex(reminder.color);
      if (darkHex) item.style.setProperty('--reminder-color-dark', darkHex);
    }
    // Upcoming reminders aren't due yet, so there's nothing to check off: a
    // calendar mark stands in for the checkbox and the label leads with the day.
    const leading = upcoming
      ? '<span class="upcoming-icon" aria-hidden="true"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3.5" y="5" width="17" height="15" rx="3"/><path d="M8 3v4M16 3v4M3.5 10h17"/></svg></span>'
      : `<button class="check-btn" aria-label="${taken ? 'Mark not taken' : 'Mark taken'}">${taken ? checkSvg(justTakenId === reminder.id) : ''}</button>`;
    const timeLabel = upcoming
      ? `${describeDay(nextOccurrence(reminder))} · ${formatTime(reminder.time)}`
      : `${formatTime(reminder.time)}${recurrenceLabel ? ` · ${recurrenceLabel}` : ''}`;
    item.innerHTML = `
      ${leading}
      <div class="reminder-info">
        <span class="reminder-name">${escapeHtml(reminder.name)}</span>
        <span class="reminder-time">${timeLabel}</span>
        ${alertBadges.has(reminder.id) ? `<span class="alert-badge">${alertBadgeText(alertBadges.get(reminder.id))}</span>` : ''}
      </div>
      ${streakRing}
      <button class="delete-btn" aria-label="Delete">✕</button>
    `;
    item.querySelector('.check-btn')?.addEventListener('click', () => toggleTaken(reminder.id));
    item.querySelector('.reminder-info').addEventListener('click', () => openDetail(reminder.id));

    // Wrap in a swipe row: delete sits behind it on the right (revealed
    // sliding left), complete sits behind it on the left (revealed sliding
    // right, not shown at all once already taken).
    const row = document.createElement('div');
    row.className = 'swipe-row' + (openSwipeId === reminder.id ? ' is-open is-swiping' : '');
    row.dataset.reminderId = reminder.id;
    const cannotComplete = taken || upcoming;
    row.innerHTML = (cannotComplete ? '' : `<div class="swipe-complete" aria-hidden="true">${completeSvg()}</div>`)
      + '<button type="button" class="swipe-action" aria-label="Delete reminder">Delete</button>';
    row.appendChild(item);
    if (openSwipeId === reminder.id) item.style.transform = `translateX(-${SWIPE_ACTION_WIDTH}px)`;
    wireSwipe(row, item, reminder.id, cannotComplete);
    row.querySelector('.swipe-action').addEventListener('click', () => removeWithAnimation(row, reminder.id));
    item.querySelector('.delete-btn').addEventListener('click', () => removeWithAnimation(row, reminder.id));
    node = row;

    if (animateEntrance) {
      node.classList.add('row-enter');
      node.style.animationDelay = `${staggerDelay(index)}ms`;
    }
    listEl.appendChild(node);
    if (ringTargetOffset !== null) {
      const fill = item.querySelector('.ring-fill');
      void fill.getBoundingClientRect(); // commit the starting offset so the change transitions
      fill.style.strokeDashoffset = ringTargetOffset;
    }
  });
}

// ---- Add screen ----
function resetAddForm() {
  nameInput.value = '';
  timeInput.value = '';
  notesInput.value = '';
  importanceInput.value = 'normal';
  nlInput.value = '';
  clearUnderstanding();
  recurrenceFieldsEl.innerHTML = renderRecurrenceFields();
  wireRecurrenceControls(addForm);
  renderAddFormColor();
}

resetAddForm();

openAddBtn.addEventListener('click', async () => {
  const opened = await openScreen(addScreen, resetAddForm);
  if (opened) nameInput.focus();
});

addCloseBtn.addEventListener('click', () => {
  intelligence.cancel();
  closeScreen(addScreen);
});

addForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  const time = timeInput.value;
  const recurrence = readRecurrenceFromForm(addForm);
  if (!name || !time || !recurrence) return;
  const color = readColorFromContainer(colorFieldsEl);
  const notes = notesInput.value.trim();
  const importance = importanceInput.value;
  // "Add three job applications..." was confirmed as separate reminders or as
  // one reminder with steps; everything else is a single reminder.
  let added = true;
  if (understanding && understanding.count > 1 && understanding.countMode === 'steps') {
    added = await addReminder(name, time, recurrence, color, notes, appendSubtasks([], numberedNames(name, understanding.count)), importance);
  } else if (understanding && reminderCount(understanding) > 1) {
    for (const numbered of numberedNames(name, understanding.count)) {
      added = await addReminder(numbered, time, recurrence, color, notes, [], importance);
      if (!added) break;
    }
  } else {
    added = await addReminder(name, time, recurrence, color, notes, [], importance);
  }
  if (added) closeScreen(addScreen);
  else render(); // the list shows only what was really saved
});

// ---- Describe it (Understand Reminder) ----
// A sentence, typed or spoken, becomes a draft in the form below. Questions
// the sentence left open appear as choices. Nothing is saved or scheduled
// until the user presses Save reminder, as with any other new reminder.
function clearUnderstanding() {
  understanding = null;
  understandPanel.hidden = true;
  understandPanel.innerHTML = '';
}

function renderUnderstandPanel({ usedAI = false, note = null, message = null } = {}) {
  if (message) {
    understandPanel.innerHTML = `<p class="understand-note">${escapeHtml(message)}</p>`;
    understandPanel.hidden = false;
    return;
  }
  const draft = understanding;
  const intro = usedAI
    ? 'Filled in on this iPhone. Check the details, then tap Save reminder.'
    : 'Filled in. Check the details, then tap Save reminder.';
  const questions = draft.questions.map(q => {
    if (q.kind === 'input') {
      return `<div class="understand-question" data-question="${q.id}"><p>${escapeHtml(q.message)}</p>
        <div class="chips"><button type="button" class="chip" data-focus="${q.field}">Set it</button></div></div>`;
    }
    const chips = q.options.map((option, i) =>
      `<button type="button" class="chip${i === q.defaultIndex ? ' is-default' : ''}" data-option="${i}">${escapeHtml(option.label)}</button>`).join('');
    return `<div class="understand-question" data-question="${q.id}"><p>${escapeHtml(q.message)}</p><div class="chips">${chips}</div></div>`;
  }).join('');
  understandPanel.innerHTML = `<p class="understand-note">${escapeHtml(intro)}${note ? ` ${escapeHtml(note)}` : ''}</p>${questions}`;
  understandPanel.hidden = false;
}

function applyDraftToForm(draft) {
  nameInput.value = draft.name;
  timeInput.value = timeValue(draft.time);
  recurrenceFieldsEl.innerHTML = renderRecurrenceFields(draft.recurrence);
  wireRecurrenceControls(addForm);
}

async function understandAndFill(text) {
  if (understandBusy) return;
  understandBusy = true;
  nlFillBtn.disabled = true;
  nlFillBtn.textContent = 'Reading…';
  try {
    const result = await intelligence.understandReminder(text);
    if (result.status === 'cancelled') return;
    if (result.status === 'error') {
      understanding = null;
      renderUnderstandPanel({ message: result.message });
      return;
    }
    understanding = result.draft;
    applyDraftToForm(understanding);
    renderUnderstandPanel(result);
    if (!understanding.name) nameInput.focus();
  } finally {
    understandBusy = false;
    nlFillBtn.disabled = false;
    nlFillBtn.textContent = 'Fill in';
  }
}

nlFillBtn.addEventListener('click', () => understandAndFill(nlInput.value));

// Enter here means "fill in", not "submit the form".
nlInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    understandAndFill(nlInput.value);
  }
});

understandPanel.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  const question = e.target.closest('[data-question]');
  if (!chip || !question || !understanding) return;
  if (chip.dataset.focus) {
    const field = chip.dataset.focus;
    (field === 'name' ? nameInput : field === 'date' ? addForm.querySelector('.recurrence-select') : timeInput).focus();
    return;
  }
  const id = question.dataset.question;
  const option = understanding.questions.find(q => q.id === id)?.options[Number(chip.dataset.option)];
  if (!option) return;
  understanding = applyAnswer(understanding, id, Number(chip.dataset.option));
  // Apply only what this answer changed, so anything the user has typed since stays.
  if (option.patch.time) timeInput.value = timeValue(option.patch.time);
  if (option.patch.recurrence) {
    recurrenceFieldsEl.innerHTML = renderRecurrenceFields(option.patch.recurrence);
    wireRecurrenceControls(addForm);
  }
  renderUnderstandPanel({});
});

// ---- Detail screen ----
function describeRepeat(recurrence) {
  const type = recurrence?.type || 'daily';
  if (type === 'daily') return 'Every day';
  if (type === 'once') return 'Does not repeat';
  if (type === 'daysOfWeek') return `Weekly on ${describeRecurrence(recurrence)}`;
  return describeRecurrence(recurrence);
}

function renderDetail() {
  const reminder = reminders.find(r => r.id === detailId);
  if (!reminder) return;
  const dueToday = appliesToday(reminder);
  // A one-time reminder from an earlier day has no "next" day: it says when it
  // was due, and can still be completed (or un-completed).
  const oneTimeDate = oneTimeDay(reminder);
  const missedOneTime = isOverdueOneTime(reminder) || isCompletedOneTime(reminder);
  const done = oneTimeDate ? isFinished(reminder) : dueToday && reminder.takenDate === todayKey();
  const day = dueToday ? 'Today'
    : oneTimeDate ? `${oneTimeDate < new Date() ? 'Was due ' : ''}${describeDay(oneTimeDate)}`
    : describeDay(nextOccurrence(reminder));

  detailTitleEl.textContent = reminder.name;
  detailWhenEl.textContent = `${day}, ${formatTime(reminder.time)}${done ? ' · Done' : ''}`;
  detailRepeatEl.textContent = describeRepeat(reminder.recurrence);
  detailNotesEl.textContent = reminder.notes || '';
  detailNotesBlockEl.hidden = !reminder.notes;

  // Completing and snoozing only make sense for something that's due today,
  // or a one-time reminder from an earlier day that is still on the list.
  detailCompleteBtn.hidden = !(dueToday || (oneTimeDate && (missedOneTime || done)));
  detailCompleteBtn.textContent = done ? 'Mark incomplete' : 'Mark complete';
  detailSnoozeBtn.hidden = !dueToday || done || missedOneTime;
  renderDetailSteps();
}

function openDetail(id) {
  if (!reminders.some(r => r.id === id)) return;
  openScreen(detailScreen, () => {
    detailId = id;
    renderDetail();
  });
}

async function closeDetail() {
  // Only forget which reminder this was if the screen actually closed — a tap
  // mid-slide is ignored by closeScreen and must leave the screen usable.
  const closed = await closeScreen(detailScreen);
  if (closed) detailId = null;
  return closed;
}

detailBackBtn.addEventListener('click', closeDetail);

// Leave first, then change the list, so the row's own animation (checkmark,
// streak ring, confetti) is what the user sees as the result.
detailCompleteBtn.addEventListener('click', async () => {
  const id = detailId;
  if (!(await closeDetail())) return;
  await toggleTaken(id);
});

detailSnoozeBtn.addEventListener('click', async () => {
  const reminder = reminders.find(r => r.id === detailId);
  if (!reminder) return;
  const result = await actions.snooze(reminder.id, SNOOZE_MINUTES);
  if (result.ok) {
    await closeDetail();
    showToast(`Snoozed for ${SNOOZE_MINUTES} minutes`);
  } else if (result.reason === 'permission_denied') {
    showToast('Notifications are off for Tickmark. Turn them on in Settings.');
  } else {
    showToast("Couldn't snooze — check that notifications are allowed");
  }
});

detailEditBtn.addEventListener('click', () => openEdit(detailId, detailScreen));

// ---- Steps (subtasks) ----
// Steps live on the reminder as an optional list. Saving them only rewrites
// that list: the reminder's time, recurrence and notifications are untouched,
// and steps never get notifications of their own.
function escapeAttr(str) {
  return escapeHtml(str).replace(/"/g, '&quot;');
}

function detailReminder() {
  return reminders.find(r => r.id === detailId);
}

async function saveSubtasks(reminder, subtasks) {
  reminder.subtasks = subtasks;
  await saveReminders();
  renderDetailSteps();
}

function renderDetailSteps() {
  const reminder = detailReminder();
  if (!reminder) return;
  const steps = getSubtasks(reminder);
  const { done, total } = subtaskProgress(steps);
  detailStepsProgressEl.textContent = total ? `· ${done} of ${total} done` : '';
  detailStepsListEl.hidden = total === 0;
  detailStepsListEl.innerHTML = steps.map(step => `
    <li class="step-item${step.done ? ' is-done' : ''}" data-step-id="${step.id}">
      <label class="step-check"><input type="checkbox"${step.done ? ' checked' : ''}><span>${escapeHtml(step.title)}</span></label>
      <button type="button" class="step-remove" aria-label="Remove step">✕</button>
    </li>
  `).join('');
}

detailStepsListEl.addEventListener('change', (e) => {
  const item = e.target.closest('[data-step-id]');
  const reminder = detailReminder();
  if (item && reminder) saveSubtasks(reminder, toggleSubtask(getSubtasks(reminder), Number(item.dataset.stepId)));
});

detailStepsListEl.addEventListener('click', (e) => {
  const remove = e.target.closest('.step-remove');
  const item = e.target.closest('[data-step-id]');
  const reminder = detailReminder();
  if (remove && item && reminder) saveSubtasks(reminder, removeSubtask(getSubtasks(reminder), Number(item.dataset.stepId)));
});

// Adding by hand always works, with or without on-device AI.
stepAddForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const reminder = detailReminder();
  const text = stepAddInput.value.trim();
  if (!reminder || !text) return;
  const before = getSubtasks(reminder);
  const after = appendSubtasks(before, [text]);
  if (after.length === before.length) {
    showToast('That step is already on the list');
    return;
  }
  stepAddInput.value = '';
  await saveSubtasks(reminder, after);
});

// ---- Break into Steps (on-device suggestions, reviewed before saving) ----
let stepsReview = [];

function showStepsPanel(panel) {
  [stepsStatusEl, stepsMessageEl, stepsReviewEl].forEach(el => { el.hidden = el !== panel; });
}

function updateStepsSaveButton() {
  const count = approvedSteps(stepsReview).length;
  stepsSaveBtn.disabled = count === 0;
  stepsSaveBtn.textContent = count === 0 ? 'Select steps to save' : `Save ${count} step${count === 1 ? '' : 's'}`;
}

function renderStepsReview() {
  stepsListEl.innerHTML = stepsReview.map(item => `
    <li class="step-item" data-review-id="${item.id}">
      <input type="checkbox" aria-label="Include this step"${item.selected ? ' checked' : ''}>
      <input type="text" class="step-input" value="${escapeAttr(item.text)}" maxlength="120" aria-label="Step text">
      <button type="button" class="step-remove" aria-label="Discard this step">✕</button>
    </li>
  `).join('');
  updateStepsSaveButton();
}

// Permanent conditions (old iOS, ineligible device) don't get a "Try again".
const PERMANENT_UNAVAILABLE = ['os_unsupported', 'device_not_eligible', 'plugin_unavailable', 'unknown'];

async function runBreakdown() {
  const reminder = detailReminder();
  if (!reminder) return;
  showStepsPanel(stepsStatusEl);
  // A request cancelled a moment ago may still be winding down natively.
  let result;
  for (let attempt = 0; attempt < 4; attempt++) {
    result = await intelligence.breakIntoSteps(reminder.name);
    if (result.status !== 'busy') break;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (result.status === 'cancelled' || stepsScreen.hidden) return; // the user left; nothing to show
  if (result.status === 'ok') {
    stepsReview = buildReview(result.steps);
    renderStepsReview();
    showStepsPanel(stepsReviewEl);
    return;
  }
  stepsMessageTextEl.textContent = result.message || 'Still working on another request. Try again in a moment.';
  stepsRetryBtn.hidden = result.status === 'unavailable' && PERMANENT_UNAVAILABLE.includes(result.reason);
  showStepsPanel(stepsMessageEl);
}

async function openSteps() {
  const reminder = detailReminder();
  if (!reminder) return;
  const opened = await openScreen(stepsScreen, () => {
    stepsTaskNameEl.textContent = reminder.name;
    stepsReview = [];
    showStepsPanel(stepsStatusEl);
  }, detailScreen);
  if (opened) runBreakdown();
}

function closeSteps() {
  intelligence.cancel();
  stepsReview = [];
  return closeScreen(stepsScreen, detailScreen);
}

breakIntoStepsBtn.addEventListener('click', openSteps);
stepsBackBtn.addEventListener('click', closeSteps);
stepsCancelBtn.addEventListener('click', closeSteps);
stepsRetryBtn.addEventListener('click', runBreakdown);
stepsAgainBtn.addEventListener('click', runBreakdown);

stepsManualBtn.addEventListener('click', async () => {
  await closeSteps();
  stepAddInput.focus();
});

stepsListEl.addEventListener('change', (e) => {
  const item = e.target.closest('[data-review-id]');
  if (!item || e.target.type !== 'checkbox') return;
  stepsReview = toggleReviewItem(stepsReview, Number(item.dataset.reviewId));
  updateStepsSaveButton();
});

stepsListEl.addEventListener('input', (e) => {
  const item = e.target.closest('[data-review-id]');
  if (!item || !e.target.classList.contains('step-input')) return;
  stepsReview = editReviewItem(stepsReview, Number(item.dataset.reviewId), e.target.value);
  updateStepsSaveButton();
});

stepsListEl.addEventListener('click', (e) => {
  const remove = e.target.closest('.step-remove');
  const item = e.target.closest('[data-review-id]');
  if (!remove || !item) return;
  stepsReview = discardReviewItem(stepsReview, Number(item.dataset.reviewId));
  renderStepsReview();
});

// The only place suggested steps become real data, and only the ones the user
// left selected, in the text they left them.
stepsSaveBtn.addEventListener('click', async () => {
  const reminder = detailReminder();
  const titles = approvedSteps(stepsReview);
  if (!reminder || titles.length === 0) return;
  const before = getSubtasks(reminder);
  const after = appendSubtasks(before, titles);
  await saveSubtasks(reminder, after);
  const added = after.length - before.length;
  await closeSteps();
  showToast(added === 0 ? 'Those steps were already on the list' : `Added ${added} step${added === 1 ? '' : 's'}`);
});

// ---- Edit screen ----
function openEdit(id, from = appEl) {
  const reminder = reminders.find(r => r.id === id);
  if (!reminder) return;
  openScreen(editScreen, () => {
    editingId = id;
    editNameInput.value = reminder.name;
    editTimeInput.value = reminder.time;
    editNotesInput.value = reminder.notes || '';
    editImportanceInput.value = normalizeImportance(reminder.importance);
    editRecurrenceFieldsEl.innerHTML = renderRecurrenceFields(reminder.recurrence);
    wireRecurrenceControls(editForm);
    editColorFieldsEl.innerHTML = renderColorSwatches(reminder.color);
    wireColorSwatches(editColorFieldsEl);
  }, from);
}

// Edit is only reachable from the detail screen now, so Back lands there.
function closeEdit() {
  editingId = null;
  closeScreen(editScreen, detailId !== null ? detailScreen : appEl);
}

editCloseBtn.addEventListener('click', closeEdit);
editCancelBtn.addEventListener('click', closeEdit);

editForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = editNameInput.value.trim();
  const time = editTimeInput.value;
  const recurrence = readRecurrenceFromForm(editForm);
  if (!name || !time || !recurrence || editingId === null) return;
  if (!(await updateReminder(editingId, name, time, recurrence, readColorFromContainer(editColorFieldsEl), editNotesInput.value.trim(), editImportanceInput.value))) return;
  if (detailId !== null) renderDetail(); // refresh it before Back reveals it
  closeEdit();
});

// ---- Voice input ----
// Speech recognition runs entirely on-device (SFSpeechRecognizer with
// requiresOnDeviceRecognition = true, see SpeechInputPlugin.swift) — audio
// never leaves the device. The transcript is only ever a starting point:
// it's parsed into a best guess and dropped into the normal add form for
// the user to review and edit, never saved directly.
let voiceSession = null;
let latestTranscript = '';

function pad2(n) {
  return String(n).padStart(2, '0');
}

function openVoiceOverlay() {
  voiceStatus.textContent = 'Listening…';
  voiceTranscript.textContent = '';
  voiceOverlay.hidden = false;
  micBtn.classList.add('listening');
}

function closeVoiceOverlay() {
  voiceOverlay.hidden = true;
  micBtn.classList.remove('listening');
}

async function stopVoiceSession() {
  if (!voiceSession) return;
  const session = voiceSession;
  voiceSession = null;
  try {
    await session.stop();
  } catch (e) {
    console.error('Could not stop voice session', e);
  }
}

async function finishVoiceInput() {
  // Captured before stopping: stopping cancels the native recognition task,
  // which can trigger one more (empty/error) transcript callback — reading
  // latestTranscript only after that await would risk it already having
  // been overwritten by that trailing event.
  const transcript = latestTranscript.trim();
  latestTranscript = '';
  await stopVoiceSession();
  closeVoiceOverlay();
  if (transcript) {
    nlInput.value = transcript;
    understandAndFill(transcript);
  }
}

micBtn.addEventListener('click', async () => {
  if (voiceSession) return;
  try {
    const permissions = await ensureVoicePermissions();
    if (permissions.speech !== 'granted' || permissions.microphone !== 'granted') {
      voiceStatus.textContent = 'Microphone/speech access denied';
      voiceOverlay.hidden = false;
      return;
    }
    openVoiceOverlay();
    voiceSession = await startListening({
      onTranscript: ({ text, isFinal }) => {
        latestTranscript = text;
        voiceTranscript.textContent = text;
        if (isFinal) finishVoiceInput();
      },
      onError: (err) => {
        voiceStatus.textContent = err?.message ? `Error: ${err.message}` : 'Could not transcribe';
      },
    });
  } catch (e) {
    console.error('Could not start voice input', e);
    voiceStatus.textContent = e?.message || 'Voice input is not available';
    voiceOverlay.hidden = false;
  }
});

voiceDoneBtn.addEventListener('click', finishVoiceInput);

voiceCancelBtn.addEventListener('click', async () => {
  latestTranscript = '';
  await stopVoiceSession();
  closeVoiceOverlay();
});

// ---- Today's focus ----
// The order comes from rules (prioritizer.js) over what Tickmark stores. The
// on-device model may only phrase a summary of that order. Changing a task's
// importance is the user's override: it saves just that one field (no
// notification is touched) and re-ranks straight away.
const IMPORTANCE_LABELS = { high: 'High', normal: 'Normal', low: 'Low' };
let focusToken = 0; // a summary that finishes after the list changed is ignored

function renderFocusList(ranked) {
  focusListEl.innerHTML = ranked.map(item => `
    <li class="focus-item${item.rank === 1 ? ' is-top' : ''}" data-focus-id="${item.id}">
      <span class="focus-rank" aria-hidden="true">${item.rank}</span>
      <div class="focus-body">
        <p class="focus-name">${escapeHtml(item.name)}<span class="focus-time">${formatTime(item.time)}</span></p>
        <p class="focus-reasons">${escapeHtml(item.reasons.join(' \u00b7 '))}</p>
        <div class="segmented-control focus-importance" role="group" aria-label="Importance of ${escapeAttr(item.name)}">
          ${IMPORTANCE_LEVELS.map(level => `<button type="button" class="segmented-btn${item.importance === level ? ' selected' : ''}" data-importance="${level}" aria-pressed="${item.importance === level}">${IMPORTANCE_LABELS[level]}</button>`).join('')}
        </div>
      </div>
    </li>
  `).join('');
}

// Shows the rule-written sentence at once, then swaps in the model's phrasing
// if it arrives, and passes validation, before the list changes again.
async function refreshFocus() {
  const ranked = rankFocus(reminders);
  const token = ++focusToken;
  intelligence.cancel();
  renderFocusList(ranked);
  focusSummaryEl.textContent = focusSummary(ranked);
  focusSourceEl.hidden = true;
  const result = await intelligence.summarizeFocus(ranked);
  if (token !== focusToken || result.status === 'cancelled' || !result.usedAI) return;
  focusSummaryEl.textContent = result.summary;
  focusSourceEl.hidden = false;
}

function closeFocus() {
  focusToken++;
  intelligence.cancel();
  return closeScreen(focusScreen);
}

focusBtn.addEventListener('click', async () => {
  const opened = await openScreen(focusScreen, () => { refreshFocus(); });
  if (!opened) focusToken++;
});
focusBackBtn.addEventListener('click', closeFocus);

focusListEl.addEventListener('click', async (e) => {
  const button = e.target.closest('[data-importance]');
  const item = e.target.closest('[data-focus-id]');
  if (!button || !item) return;
  reminders = withImportance(reminders, Number(item.dataset.focusId), button.dataset.importance);
  await saveReminders();
  refreshFocus();
});

// ---- Plan my day ----
// A suggested layout of today's pending reminders inside a window the user
// picks. Blocks come from rules (planner.js); the on-device model may only
// phrase a sentence about them. Nothing here changes a reminder or its
// notification: saving stores the plan itself under its own key, and that is
// all. Edits re-time the blocks so they can never overlap.
let planState = null; // { scope, plan, estimates, saved }
let planToken = 0;    // ignores a summary that finishes after the plan changed

const minutesToInput = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const inputToMinutes = value => {
  const [h, m] = value.split(':').map(Number);
  return Number.isInteger(h) && Number.isInteger(m) ? h * 60 + m : null;
};

async function loadStoredPlan() {
  const { value } = await Preferences.get({ key: PLAN_KEY });
  return value ? fromStoredPlan(value, reminders) : null;
}

function renderPlan() {
  const { plan, scope, saved } = planState;
  planScopesEl.querySelectorAll('.chip').forEach(chip => chip.classList.toggle('is-selected', chip.dataset.scope === scope));
  planStartInput.value = minutesToInput(plan.window.start);
  planEndInput.value = minutesToInput(plan.window.end);
  planBlocksEl.hidden = plan.blocks.length === 0;

  planBlocksEl.innerHTML = plan.blocks.map((block, index) => {
    const lengths = DURATION_OPTIONS.includes(block.minutes) ? DURATION_OPTIONS : [...DURATION_OPTIONS, block.minutes].sort((a, b) => a - b);
    const warning = block.lateBy > 0
      ? `Finishes ${formatDuration(block.lateBy)} after its ${formatMinutes(block.due)} reminder`
      : block.beyondWindow ? `Runs past ${formatMinutes(plan.window.end)}` : '';
    const meta = block.overdue ? 'Already overdue' : `Reminder at ${formatMinutes(block.due)}`;
    return `
      <li class="plan-block${warning ? ' has-warning' : ''}" data-plan-id="${block.id}">
        <p class="plan-time">${formatMinutes(block.start)}<span>to ${formatMinutes(block.end)}</span></p>
        <div class="plan-body">
          <p class="plan-name">${escapeHtml(block.name)}</p>
          <p class="plan-meta">${escapeHtml(meta)}</p>
          ${warning ? `<p class="plan-warning">${escapeHtml(warning)}</p>` : ''}
          <div class="plan-controls">
            <span class="plan-length-group">
              <select class="plan-length" aria-label="Estimated length of ${escapeAttr(block.name)}">
                ${lengths.map(m => `<option value="${m}"${m === block.minutes ? ' selected' : ''}>${formatDuration(m)}</option>`).join('')}
              </select>
              <span class="plan-estimate">${block.estimated ? 'estimated' : 'your estimate'}</span>
            </span>
            <span class="plan-tools">
              <button type="button" class="plan-tool" data-move="-1" aria-label="Move earlier"${index === 0 ? ' disabled' : ''}>\u2191</button>
              <button type="button" class="plan-tool" data-move="1" aria-label="Move later"${index === plan.blocks.length - 1 ? ' disabled' : ''}>\u2193</button>
              <button type="button" class="plan-tool" data-remove="1" aria-label="Remove from plan">\u2715</button>
            </span>
          </div>
        </div>
      </li>`;
  }).join('');

  planUnscheduledEl.hidden = plan.unscheduled.length === 0;
  planUnscheduledListEl.innerHTML = plan.unscheduled.map(task => `
    <li data-plan-id="${task.id}">
      <div class="plan-body">
        <p class="plan-name">${escapeHtml(task.name)}</p>
        <p class="plan-meta">${escapeHtml(task.text)}</p>
      </div>
      ${task.reason === 'no_room' || task.reason === 'removed' ? '<button type="button" class="btn-outline plan-tool-text" data-add="1">Add anyway</button>' : ''}
    </li>`).join('');

  planSaveBtn.textContent = saved ? 'Plan saved' : 'Save plan';
  planSaveBtn.disabled = plan.blocks.length === 0 || saved;
  planDiscardBtn.hidden = !saved;
}

// Plain sentence first, then the model's phrasing if it arrives (and passes
// validation) before the plan changes again.
async function refreshPlanSummary({ askModel }) {
  const token = ++planToken;
  intelligence.cancel();
  const { plan } = planState;
  planSummaryEl.textContent = planSummary(plan);
  planSourceEl.hidden = true;
  if (!askModel) return;
  const result = await intelligence.summarizePlan(plan);
  if (token !== planToken || result.status === 'cancelled' || !result.usedAI) return;
  planSummaryEl.textContent = result.summary;
  planSourceEl.hidden = false;
}

// Builds a fresh plan. `window` is the user's own: a named scope or times they typed.
function replan(scope, window = windowFor(scope, new Date(), reminders, planState?.estimates || {})) {
  const estimates = planState?.estimates || {};
  const plan = buildPlan({ reminders, now: new Date(), window, estimates });
  planState = { scope, plan, estimates, saved: false };
  renderPlan();
  refreshPlanSummary({ askModel: true });
}

function editPlan(update) {
  planState = { ...planState, plan: update(planState.plan), saved: false };
  renderPlan();
  refreshPlanSummary({ askModel: false }); // a plain sentence is enough while the user is still editing
}

async function openPlan() {
  const stored = await loadStoredPlan();
  const opened = await openScreen(planScreen, () => {
    planState = { scope: null, plan: null, estimates: {}, saved: false };
    if (stored) {
      planState = { scope: null, plan: stored, estimates: {}, saved: true };
      renderPlan();
      refreshPlanSummary({ askModel: false });
    } else {
      replan('rest');
    }
  });
  if (!opened) planToken++;
}

function closePlan() {
  planToken++;
  intelligence.cancel();
  return closeScreen(planScreen);
}

planBtn.addEventListener('click', openPlan);
planBackBtn.addEventListener('click', closePlan);

planScopesEl.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-scope]');
  if (chip) replan(chip.dataset.scope);
});

// Typed window times: the user's own choice, used exactly as given.
function onWindowTimeChange() {
  const start = inputToMinutes(planStartInput.value);
  const end = inputToMinutes(planEndInput.value);
  if (start === null || end === null || end <= start) {
    showToast('The end time needs to be after the start time');
    renderPlan();
    return;
  }
  replan(null, { start, end });
}
planStartInput.addEventListener('change', onWindowTimeChange);
planEndInput.addEventListener('change', onWindowTimeChange);

planBlocksEl.addEventListener('change', (e) => {
  const item = e.target.closest('[data-plan-id]');
  if (!item || !e.target.classList.contains('plan-length')) return;
  const id = Number(item.dataset.planId);
  const minutes = Number(e.target.value);
  planState.estimates = { ...planState.estimates, [id]: minutes };
  editPlan(plan => setBlockMinutes(plan, id, minutes));
});

planBlocksEl.addEventListener('click', (e) => {
  const item = e.target.closest('[data-plan-id]');
  const button = e.target.closest('button');
  if (!item || !button) return;
  const id = Number(item.dataset.planId);
  if (button.dataset.move) editPlan(plan => moveBlock(plan, id, Number(button.dataset.move)));
  else if (button.dataset.remove) editPlan(plan => removeBlock(plan, id));
});

planUnscheduledListEl.addEventListener('click', (e) => {
  const item = e.target.closest('[data-plan-id]');
  if (item && e.target.closest('[data-add]')) editPlan(plan => addUnscheduled(plan, Number(item.dataset.planId)));
});

// The only place a plan is stored, and only when the user taps Save plan.
planSaveBtn.addEventListener('click', async () => {
  if (!planState || planState.plan.blocks.length === 0) return;
  await Preferences.set({ key: PLAN_KEY, value: JSON.stringify(toStoredPlan(planState.plan)) });
  planState = { ...planState, saved: true };
  renderPlan();
  showToast('Plan saved on this iPhone');
});

planDiscardBtn.addEventListener('click', async () => {
  await Preferences.remove({ key: PLAN_KEY });
  replan('rest');
  showToast('Saved plan discarded');
});

// ---- A new day while the app is open or in the background ----
// Launch runs the stale-streak check; a new day that starts while the app is
// open (midnight) or suspended (resume) needs the same, or the streak count,
// Today list, Overdue and badge stay on yesterday until a relaunch.
let currentDay = null;
let midnightTimer = null;

async function refreshForNewDay() {
  const today = todayKey();
  if (currentDay === null || today === currentDay) return;
  currentDay = today;
  reminders = checkStaleStreaks(reminders, today, graceOccurrencesForHours(reminderDefaults.gracePeriodHours));
  await saveReminders();
  render();
  updateBadge();
}

// Timers don't run while iOS has the app suspended; resume covers that case.
function armMidnightTimer() {
  clearTimeout(midnightTimer);
  midnightTimer = setTimeout(async () => {
    await refreshForNewDay();
    syncAlerts();
    armMidnightTimer();
  }, msUntilNextLocalMidnight() + 1000);
}

// ---- Text size (Dynamic Type) ----
// Only iOS's WebKit knows the system text styles; elsewhere (a desktop
// browser preview) the designed 16px root is left alone.
function applyTextSize() {
  if (!(window.CSS && CSS.supports && CSS.supports('font', '-apple-system-body'))) return;
  const probe = document.createElement('span');
  probe.style.cssText = 'font: -apple-system-body; position: absolute; visibility: hidden;';
  probe.textContent = 'x';
  document.body.appendChild(probe);
  const bodyPx = parseFloat(getComputedStyle(probe).fontSize);
  probe.remove();
  document.documentElement.style.fontSize = `${rootFontSizeForSystemBody(bodyPx)}px`;
}

// ---- Init ----
async function init() {
  applyTextSize();
  // Theme is applied first, before anything renders, to avoid a flash of
  // the default color. This is fully reliable in the web preview (see the
  // inline bootstrap script in index.html's <head>, which reads localStorage
  // synchronously); on a native device, Preferences is backed by UserDefaults
  // rather than localStorage, which isn't readable synchronously from JS
  // before the page runs — so there, this is the earliest point a flash can
  // be avoided, not a hard guarantee zero frames ever paint the default.
  await loadAccentTheme();
  await loadAppearance();
  applyAccentTheme();

  await loadUserName();
  await loadGreetingStyle();
  renderGreeting();
  await loadReminderDefaults();
  renderAddFormColor();
  await loadQuietHours();
  await loadReminders();
  const graceOccurrences = graceOccurrencesForHours(reminderDefaults.gracePeriodHours);
  const previousStreaks = new Map(reminders.map(r => [r.id, r.currentStreak]));
  reminders = checkStaleStreaks(reminders, todayKey(), graceOccurrences);
  currentDay = todayKey();
  // One toast for the launch, even if several reminders' streaks broke while
  // the app was closed — this is meant to be a gentle nudge, not a list.
  const anyStreakReset = reminders.some(r => previousStreaks.get(r.id) > 0 && r.currentStreak === 0);
  await saveReminders();
  markAppReady(); // reminders, settings and stale-streak checks are done: notification actions may proceed
  await refreshRecoveryNotice();
  render({ animateEntrance: true });
  if (anyStreakReset) {
    showToast(getStreakResetMessage(userName));
  }
  // First launch of this version: clear every alert scheduled under the old
  // numbering, then rebuild them all from the saved reminders. Every launch
  // after that only fixes whatever differs.
  await notifier.migrate();
  await syncAlerts();
  armMidnightTimer();
  micBtn.hidden = !(await isVoiceAvailable());

  const { value: onboarded } = await Preferences.get({ key: ONBOARDED_KEY });
  if (!onboarded) {
    onboardingScreen.hidden = false;
  }
}

// Backgrounding and resuming: keep the greeting and the icon badge honest,
// since time passes and reminders become overdue while we're not looking.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    // Leaving the app: make sure the icon shows the current overdue count.
    updateBadge();
  } else {
    // A notification may have set the badge natively while we were away, so
    // forget what we last set and re-sync instead of trusting it.
    lastBadgeCount = null;
    applyTextSize(); // the text size may have been changed in iOS Settings meanwhile
    render();
    // The user may have changed the notification permission in iOS Settings.
    appReady.then(async () => {
      await refreshForNewDay();
      armMidnightTimer(); // re-aimed, since it may have been paused while suspended
      syncAlerts();
    });
  }
});

init().catch(e => console.error('init failed', e)).finally(markAppReady); // never leave a waiting action hanging
