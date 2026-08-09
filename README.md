# NewNotes

Extracts events/deadlines from pasted campus notices, tracks changes between
versions of the same event, and flags schedule conflicts. Backend: Node +
Express + Postgres. Frontend: plain HTML/JS served by the backend.

## Run it locally in VS Code

1. **Open the folder**
   Open the `newnotes` folder in VS Code (`code .` from the terminal, or
   File → Open Folder).

2. **Install Postgres locally** (skip if you already have it)
   Easiest: install [Postgres.app](https://postgresapp.com/) (Mac) or use
   Docker: `docker run --name newnotes-db -e POSTGRES_PASSWORD=postgres -p 5432:5432 -d postgres`

3. **Create the database**
   ```
   createdb newnotes
   ```
   (or, with Docker, run `docker exec -it newnotes-db createdb -U postgres newnotes`)

4. **Get a free Gemini API key**
   Go to [aistudio.google.com/apikey](https://aistudio.google.com/apikey),
   sign in with a Google account, click "Create API key." No credit card,
   no billing setup — the free tier gives 1,500 requests/day, more than
   enough for a hackathon demo.

5. **Set up environment variables**
   ```
   cd backend
   cp .env.example .env
   ```
   Open `.env` and paste in your `GEMINI_API_KEY`. Leave `DATABASE_URL`
   as-is if you used the Docker command above.

6. **Install dependencies and run**
   ```
   npm install
   npm run dev
   ```
   Open **http://localhost:3000** — you'll see the NewNotes UI. Go to
   Sources, click a sample notice, hit Extract.

## Deploying to Zerops

1. Push this repo to GitHub.
2. In the Zerops dashboard: create a new Project, add a **PostgreSQL**
   service (any small tier), and a **Node.js** service.
3. Connect the Node.js service to this GitHub repo — Zerops will pick up
   `zerops.yml` automatically.
4. In the Node.js service's environment variables, add `GEMINI_API_KEY`
   with your real key. `DATABASE_URL` is filled in automatically from the
   Postgres service reference in `zerops.yml`.
5. Deploy. Zerops gives you a public URL when the build finishes.

## How the core logic works

- `POST /api/sources` — takes `{ name, text }`, sends the text to Gemini
  with a strict JSON-extraction prompt, then for each extracted event:
  - if no event with a matching (normalized) title exists yet → insert as `new`
  - if one exists and date/time/venue differ → update it, save the old
    values as `prev_*`, mark `changed`
  - if one exists and nothing differs → mark `unchanged`
- `GET /api/state` — returns all events plus sources. Conflict detection
  happens here: any two events on the same date with overlapping
  start/end times are cross-linked via `conflictsWith`.

That diff + conflict logic in `backend/server.js` is the actual product —
everything else is presentation.
