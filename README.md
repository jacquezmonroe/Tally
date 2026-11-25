# Tickmark

A simple, private, offline medication and routine reminder app — no accounts, no cloud, nothing ever leaves your device.

**GitHub:** https://github.com/jacquezmonroe/Tally

> Tickmark was originally named Tally. The repository, the app's bundle ID, and its on-device storage keys still use the original name so existing installs and data keep working.

## Features

**Reminders**
- Reminders that repeat every day, on specific days of the week, monthly on a date, or happen once
- Local notifications — no server, no account, works offline
- A **Mark Taken** button on the notification itself, plus a **Snooze 10 min** button on a reminder's detail screen
- Optional steps inside a reminder, an importance level, notes, and a colour per reminder
- Quiet hours and a sound on/off setting: a quiet-hours alert still arrives on time, just silently

**Keeping track**
- Streaks for daily and weekly reminders, with a configurable grace period (none, 12, 24 or 48 hours) so one missed day doesn't wipe your progress
- Today, Upcoming and Done tabs
- One-time reminders from earlier days that you haven't finished appear under **Overdue** (they are never auto-completed), and finished ones move to a collapsed **Completed** list
- The app icon badge shows what's overdue

**Adding reminders quickly**
- Speak a reminder: speech recognition runs entirely on the device
- Type or say a sentence like "call Marcus tomorrow at 8 PM" under **Describe it**; anything the app is unsure about, such as a missing day, is shown as a question to confirm before anything is saved
- **What should I focus on today?** and **Plan my day** rank and lay out your reminders with the app's own rules, and you can override importance and edit the plan
- On supported iPhones (iOS 26 with Apple Intelligence), on-device AI can also break a task into steps and write the short summaries for the focus list and the plan. It uses only the model on your phone, and the rest of the app works without it.

**Being honest about problems**
- If a notification can't be scheduled, or notifications are turned off for the app, you see a banner and a warning on the affected reminder, with a Retry button
- Saved data is checked every time it loads. Anything unreadable is set aside and the original is backed up before any repair, and the app tells you what happened.

**Look and feel**
- Light, Dark or System appearance, accent themes, and a simple or detailed greeting

## Privacy

Everything is stored on the device. The app makes no network requests, has no accounts, and has no analytics. Speech recognition is forced to on-device, and the optional AI features use only Apple's on-device model.

## Tech Stack

- Vanilla JavaScript, HTML, CSS — no UI framework
- [Capacitor](https://capacitorjs.com/) to wrap the web app as a native iOS app (iOS 15 and up)
- `@capacitor/local-notifications` for reminder notifications
- `@capacitor/preferences` for on-device storage (falls back to `localStorage` in a plain browser)
- `@capawesome/capacitor-badge` for the app icon badge
- Two small Swift plugins: on-device speech input, and on-device AI built on Apple's Foundation Models
- Vite as the build tool/bundler
- Node's built-in test runner for the tests

## Getting Started

Install dependencies and build:

```
npm install
npm run build
```

Run the tests:

```
npm test
```

To preview in a browser (native notifications, badge, speech and on-device AI aren't available here, but everything else works):

```
npm run dev
```

To run it as a native iOS app:

```
npx cap sync ios
npx cap open ios
```

Then build and run from Xcode onto a simulator or a real device.

## Project Structure

```
Tally/                          (the repository folder; the app itself is Tickmark)
├── index.html
├── capacitor.config.json
├── package.json
├── JOURNEY.md                  how the app came together
├── src/
│   ├── main.js                 screens and wiring
│   ├── style.css, alerts.css, pastReminders.css
│   ├── due.js                  what is due, overdue, upcoming or completed
│   ├── streak.js               streaks and grace periods
│   ├── storage.js              validated loading, backups and recovery
│   ├── notifications.js        one function that makes scheduled alerts match saved reminders
│   ├── notificationActions.js  the "Mark Taken" notification button
│   ├── reminderActions.js      add, edit, delete and snooze
│   ├── alertStatus.js          alert banner and badge text
│   ├── settings.js, personalization.js, subtasks.js, motion.js
│   ├── voice.js, voiceInput.js speech to reminder
│   ├── intelligence/           "Describe it", steps, focus and plan
│   └── *.test.js               tests
└── ios/
    └── App/
        ├── App/                native shell and the Swift plugins (speech, on-device AI)
        └── AITests/            Swift tests for the AI text cleaner
```

## Related Projects

- [Weather App](https://github.com/jacquezmonroe/weather-app) — [live demo](https://weather-app-orcin-one.vercel.app/)
- [Tic-Tac-Toe (React)](https://github.com/jacquezmonroe/tic-tac-toe-react) — [live demo](https://tic-tac-toe-react-sand-ten.vercel.app/)
- [Calculator](https://github.com/jacquezmonroe/calculator-app) — [live demo](https://calculator-app-three-sand.vercel.app/)
