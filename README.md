# NewNotes

NewNotes turns messy campus notices — WhatsApp forwards, email announcements,
notice-board photos-turned-text — into a single organized view of what's
actually due, when things change, and when two things collide on your
calendar.

You paste a notice in. It figures out the rest.

## What it actually does

- **Extracts events** — paste any notice text and NewNotes uses AI (Gemini)
  to pull out the title, date, time, venue, and type (exam / assignment /
  internship / event) automatically. No manual form-filling.
- **Tracks changes** — if a notice updates something you already extracted
  (a deadline moved, a venue changed), NewNotes doesn't just overwrite it —
  it keeps the old value and shows you the diff: `Aug 10 → Aug 13`.
- **Flags conflicts** — if two events land on the same day with overlapping
  times, both get flagged automatically. No manually cross-checking your
  timetable against every internship OA and midterm.
- **Calendar view** — see everything laid out by date, click any day to see
  what's due, and jot a free-text note on any day (packing list, "call mom
  before this", whatever) — separate from extracted events.
- **Email reminders** — one click sends a digest of upcoming events,
  conflicts, and recent changes straight to your inbox. Runs automatically
  every morning too.
- **Dismiss, don't delete** — conflicts and changes stay visible until *you*
  mark them handled. Nothing disappears from re-processing a notice or
  re-extracting the same source.
- **Share-to-extract (Android)** — once installed as an app on your phone,
  you can select a WhatsApp notice and share it directly into NewNotes
  instead of copy-pasting.

## How to use it (once it's running)

1. Open the app — you land on **Overview**, which is empty until you add a
   source.
2. Go to **Sources**. Either click one of the "Load sample" buttons to try
   it with fake data, or paste a real notice into the text box and give it
   a name (e.g. "DAA notice - WhatsApp").
3. Click **Extract events**. Within a few seconds you'll see a confirmation
   of how many events were pulled out.
4. Check **Overview** — it now shows real counts, anything needing
   attention, and what's upcoming.
5. Check **Conflicts** — anything overlapping in time is listed here, with
   a **Dismiss conflict** button once you've actually resolved it (e.g.
   requested a reschedule).
6. Check **Changes** — anything that's new or was updated from a previous
   version of the same event, with the old value struck through.
7. Check **Calendar** — click any date to see what's due that day, or add a
   personal note to it.
8. Click **Send reminder email now** (on the Sources page) to get everything
   above emailed to you immediately, instead of waiting for the daily 8am
   digest.

## Run it locally in VS Code

1. **Open the folder**
   Open the `newnotes` folder in VS Code (`code .` from the terminal, or
   File → Open Folder).

2. **Get a free Postgres database (Neon)**
   Go to [neon.tech](https://neon.tech), sign up (no card needed), create a
   project. Copy the connection string it gives you — you'll need it in
   step 4. (Alternative: install Postgres locally instead, if you prefer —
   any Postgres works, Neon is just the fastest path to a working `DATABASE_URL`
   with nothing to install.)

3. **Get a free Gemini API key**
   Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey),
   sign in with a Google account, click "Create API key." No credit card,
   no billing setup — the free tier gives 1,500 requests/day.

4. **Set up environment variables**
   ```
   cd backend
   copy .env.example .env
   ```
   Open `.env` and fill in:
   - `GEMINI_API_KEY` — from step 3
   - `DATABASE_URL` — your full Neon connection string from step 2
   - `RESEND_API_KEY` — from [resend.com](https://resend.com) (free, no
     card) — needed for reminder emails
   - `REMINDER_EMAIL` — the same email you signed up to Resend with
     (unverified-domain accounts can only send to their own address)

5. **Install dependencies and run**
   ```
   npm install
   npm run dev
   ```
   Open **http://localhost:3000** — you'll land on the NewNotes UI.

## Deploying to Zerops

1. Push this repo to GitHub (see `.gitignore` — `node_modules/` and `.env`
   are already excluded, so secrets never get committed).
2. Create a Zerops account and project at [zerops.io](https://zerops.io),
   import this GitHub repo — it auto-detects `zerops.yml`.
3. In the imported service's environment variables, set the same four
   secrets from your local `.env`: `GEMINI_API_KEY`, `DATABASE_URL`,
   `RESEND_API_KEY`, `REMINDER_EMAIL`. (Using the same Neon database as
   local dev is fine — no need for a second Postgres instance.)
4. Deploy. Zerops gives you a public HTTPS URL when the build finishes.

## How the core logic works

- `POST /api/sources` — takes `{ name, text }`, sends the text to Gemini
  with a strict JSON-extraction prompt, then for each extracted event:
  - if no event with a matching (normalized) title exists yet → insert as `new`
  - if one exists and date/time/venue differ → update it, save the old
    values as `prev_*`, mark `changed`
  - if one exists and nothing differs → leave its status untouched (it
    stays visible until manually dismissed, not silently cleared)
- `GET /api/state` — returns all events, sources, and notes. Conflict
  detection happens here: any two events on the same date with overlapping
  start/end times are cross-linked via `conflictsWith`.
- `POST /api/events/:id/dismiss` — hides a conflict or change from view.
  Dismissing a conflict cascades to both events in the pair (conflicts are
  symmetric — dismissing only one side would leave the other stranded).
- `POST /api/notes` — upserts a free-text note for a given calendar date.
- Reminder emails (`backend/reminders.js`) — build the same
  upcoming/conflicts/changes summary and send it via Resend, either on
  demand or on a daily 8am cron.

That diff + conflict logic in `backend/server.js` is the actual product —
everything else is presentation.

## Known limitations (by design, for the hackathon timeline)

- Single hardcoded user, no login/auth on the API — fine for a demo, not
  for a public multi-user launch.
- WhatsApp share-to-extract only works on Android + Chrome (installed as a
  home-screen app). iOS/Safari doesn't support the underlying Web Share
  Target API, so it falls back to copy-paste there.
- Text notices only — no PDF or image/OCR ingestion yet.
