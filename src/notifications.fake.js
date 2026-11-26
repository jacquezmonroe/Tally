// A stand-in for the Local Notifications plugin, used only by tests.
//
// IT IS A MOCK. It copies the behaviors of the real iOS plugin that were read
// from its source (@capacitor/local-notifications 8.3.1):
//   - an alert's identifier is the id as a string; scheduling an id that
//     already exists replaces it
//   - getPending() returns id, title, body, extra and schedule, but NOT sound
//   - cancel removes by id; checkPermissions reports { display }
//   - ids must be whole numbers (checked here against the strict 32-bit range)
//   - iOS keeps only the 64 soonest pending alerts per app and silently drops
//     the rest; it never reports an error. So, like iOS, this never fails over
//     the limit: it records the most alerts ever pending at once (maxPending)
//     and whether that went past IOS_LIMIT (overLimit), for tests to assert on.
// It proves our logic and error handling. It cannot prove what iOS itself does
// with a real alert: that needs a real device.

const INT32_MIN = -(2 ** 31);
const INT32_MAX = 2 ** 31 - 1;
export const IOS_LIMIT = 64;

export function fakePlugin({ permission = 'granted' } = {}) {
  const plugin = {
    permission,
    pending: new Map(),   // string id -> the full notification as scheduled (including sound)
    calls: [],            // every call, in order
    registered: 0,
    active: 0,
    maxActive: 0,
    maxPending: 0,        // the most alerts ever pending at once
    get overLimit() { return plugin.maxPending > IOS_LIMIT; }, // iOS would have dropped one silently
    // Failure switches: set a function that returns true/throws for what should fail.
    failSchedule: () => false,   // (notification) => boolean
    failCancel: () => false,     // (ids) => boolean
    failPending: false,
    failRegister: false,
    failPermission: false,
  };

  async function tracked(name, detail, fn) {
    plugin.calls.push([name, detail]);
    plugin.active += 1;
    plugin.maxActive = Math.max(plugin.maxActive, plugin.active);
    try {
      await Promise.resolve(); // give overlapping callers a chance to interleave
      await Promise.resolve();
      return await fn();
    } finally {
      plugin.active -= 1;
    }
  }

  plugin.checkPermissions = () => tracked('checkPermissions', null, async () => {
    if (plugin.failPermission) throw new Error('not implemented on web');
    return { display: plugin.permission };
  });

  plugin.registerActionTypes = (options) => tracked('registerActionTypes', options, async () => {
    if (plugin.failRegister) throw new Error('register failed');
    plugin.registered += 1;
  });

  plugin.getPending = () => tracked('getPending', null, async () => {
    if (plugin.failPending) throw new Error('getPending failed');
    return {
      notifications: [...plugin.pending.values()].map(n => ({
        id: n.id,
        title: n.title,
        body: n.body,
        extra: n.extra,
        schedule: n.schedule && n.schedule.at ? { ...n.schedule, at: new Date(n.schedule.at).toISOString() } : n.schedule,
      })),
    };
  });

  plugin.schedule = ({ notifications }) => tracked('schedule', notifications, async () => {
    for (const n of notifications) {
      if (!Number.isInteger(n.id) || n.id < INT32_MIN || n.id > INT32_MAX) throw new Error(`invalid notification id ${n.id}`);
      if (typeof n.title !== 'string' || typeof n.body !== 'string') throw new Error('notification needs a title and body');
      if (plugin.failSchedule(n)) throw new Error(`schedule failed for ${n.id}`);
    }
    for (const n of notifications) plugin.pending.set(String(n.id), JSON.parse(JSON.stringify(n)));
    plugin.maxPending = Math.max(plugin.maxPending, plugin.pending.size);
    return { notifications: notifications.map(n => ({ id: n.id })) };
  });

  plugin.cancel = ({ notifications }) => tracked('cancel', notifications, async () => {
    const ids = notifications.map(n => n.id);
    if (plugin.failCancel(ids)) throw new Error('cancel failed');
    for (const id of ids) plugin.pending.delete(String(id));
  });

  // Test conveniences (not part of the real plugin).
  plugin.pendingIds = () => [...plugin.pending.values()].map(n => n.id).sort((a, b) => a - b);
  plugin.callCount = (name) => plugin.calls.filter(([n]) => n === name).length;
  plugin.scheduledNotifications = () => plugin.calls.filter(([n]) => n === 'schedule').flatMap(([, d]) => d);
  plugin.resetCalls = () => { plugin.calls.length = 0; plugin.maxActive = 0; plugin.maxPending = plugin.pending.size; };
  return plugin;
}

export function fakePrefs(initial = {}, { failSet = () => false } = {}) {
  const store = new Map(Object.entries(initial));
  return {
    store,
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async set(key, value) { if (failSet(key)) throw new Error('set failed'); store.set(key, value); },
    async remove(key) { store.delete(key); },
    async keys() { return [...store.keys()]; },
  };
}
