import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { pool, initDb } from "./db.js";
import { extractEvents } from "./extract.js";
import { sendReminderDigest } from "./reminders.js";
import cron from "node-cron";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

const norm = (s) => (s || "").toLowerCase().trim();

function toMinutes(t) {
  if (!t) return null;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

// Compute overlap conflicts across a list of events (in-memory, cheap for hackathon scale)
function attachConflicts(events) {
  const withConflicts = events.map((e) => ({ ...e, conflictsWith: [] }));
  for (let i = 0; i < withConflicts.length; i++) {
    for (let j = i + 1; j < withConflicts.length; j++) {
      const a = withConflicts[i], b = withConflicts[j];
      if (!a.date || !b.date || a.date.toString() !== b.date.toString()) continue;
      const as = toMinutes(a.start_time), ae = toMinutes(a.end_time);
      const bs = toMinutes(b.start_time), be = toMinutes(b.end_time);
      if (as == null || ae == null || bs == null || be == null) continue;
      if (as < be && bs < ae) {
        a.conflictsWith.push(b.id);
        b.conflictsWith.push(a.id);
      }
    }
  }
  return withConflicts;
}

// POST /api/sources - accepts { name, text }, extracts events, diffs against DB, stores result
app.post("/api/sources", async (req, res) => {
  const { name, text } = req.body;
  if (!text || !text.trim()) {
    return res.status(400).json({ error: "text is required" });
  }
  const sourceName = name?.trim() || "Untitled source";

  try {
    const extracted = await extractEvents(text);

    const sourceResult = await pool.query(
      `INSERT INTO sources (name, raw_text) VALUES ($1, $2) RETURNING id`,
      [sourceName, text]
    );
    const sourceId = sourceResult.rows[0].id;

    for (const ev of extracted) {
      const titleNorm = norm(ev.title);
      if (!titleNorm) continue;

      const existing = await pool.query(
        `SELECT * FROM events WHERE title_norm = $1`,
        [titleNorm]
      );

      if (existing.rows.length === 0) {
        await pool.query(
          `INSERT INTO events
            (title, title_norm, date, start_time, end_time, venue, type, source_id, source_name, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'new')`,
          [ev.title, titleNorm, ev.date, ev.start_time, ev.end_time, ev.venue, ev.type || "other", sourceId, sourceName]
        );
      } else {
        const prev = existing.rows[0];
        const changed =
          String(prev.date) !== String(ev.date) ||
          prev.start_time !== ev.start_time ||
          prev.end_time !== ev.end_time ||
          prev.venue !== ev.venue;

        if (changed) {
          await pool.query(
            `UPDATE events SET
              date=$1, start_time=$2, end_time=$3, venue=$4, type=$5,
              source_id=$6, source_name=$7, status='changed',
              prev_date=$8, prev_start_time=$9, prev_end_time=$10, prev_venue=$11,
              change_dismissed=false, conflict_dismissed=false,
              updated_at=now()
             WHERE title_norm=$12`,
            [ev.date, ev.start_time, ev.end_time, ev.venue, ev.type || "other",
             sourceId, sourceName,
             prev.date, prev.start_time, prev.end_time, prev.venue,
             titleNorm]
          );
        } else {
          await pool.query(`UPDATE events SET updated_at=now() WHERE title_norm=$1`, [titleNorm]);
        }
      }
    }

    res.json({ ok: true, extractedCount: extracted.length });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/state - everything the frontend needs to render
app.get("/api/state", async (req, res) => {
  try {
    const events = (await pool.query(`SELECT * FROM events ORDER BY date ASC NULLS LAST`)).rows;
    const sources = (await pool.query(`SELECT id, name, created_at FROM sources ORDER BY created_at DESC`)).rows;
    const notes = (await pool.query(`SELECT date, text FROM notes ORDER BY date ASC`)).rows;
    const withConflicts = attachConflicts(events);
    res.json({ events: withConflicts, sources, notes });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/notes - body { date: 'YYYY-MM-DD', text }. Upserts a single note per date.
// Passing an empty/whitespace-only text deletes the note for that date.
app.post("/api/notes", async (req, res) => {
  const { date, text } = req.body;
  if (!date) return res.status(400).json({ error: "date is required" });

  try {
    if (!text || !text.trim()) {
      await pool.query(`DELETE FROM notes WHERE date = $1`, [date]);
      return res.json({ ok: true, deleted: true });
    }
    await pool.query(
      `INSERT INTO notes (date, text, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (date) DO UPDATE SET text = EXCLUDED.text, updated_at = now()`,
      [date, text.trim()]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/send-reminder - manual trigger (for demo). Also runs on a daily schedule below.
app.post("/api/send-reminder", async (req, res) => {
  try {
    const result = await sendReminderDigest();
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/events/:id/dismiss - body { type: 'conflict' | 'change' }
// Manually hides an item from the Conflicts or Changes view. Nothing is deleted —
// the event and its history stay intact, this only sets a display flag.
// For type='conflict': conflicts are symmetric (A overlaps B implies B overlaps A),
// so dismissing on one side must dismiss on both, or the pair count breaks and one
// side is left silently stranded in the Conflicts view.
app.post("/api/events/:id/dismiss", async (req, res) => {
  const { id } = req.params;
  const { type } = req.body;
  if (!["conflict", "change"].includes(type)) {
    return res.status(400).json({ error: "type must be 'conflict' or 'change'" });
  }

  try {
    if (type === "change") {
      const result = await pool.query(`UPDATE events SET change_dismissed = true WHERE id = $1 RETURNING id`, [id]);
      if (result.rows.length === 0) return res.status(404).json({ error: "Event not found" });
      return res.json({ ok: true });
    }

    const all = (await pool.query(`SELECT * FROM events`)).rows;
    const withConflicts = attachConflicts(all);
    const target = withConflicts.find((e) => String(e.id) === String(id));
    if (!target) return res.status(404).json({ error: "Event not found" });

    const idsToUpdate = [Number(id), ...(target.conflictsWith || [])];
    await pool.query(`UPDATE events SET conflict_dismissed = true WHERE id = ANY($1)`, [idsToUpdate]);
    res.json({ ok: true, dismissedIds: idsToUpdate });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/events/:id/undismiss - reverses a dismissal, same { type } body
app.post("/api/events/:id/undismiss", async (req, res) => {
  const { id } = req.params;
  const { type } = req.body;
  if (!["conflict", "change"].includes(type)) {
    return res.status(400).json({ error: "type must be 'conflict' or 'change'" });
  }
  const column = type === "conflict" ? "conflict_dismissed" : "change_dismissed";
  try {
    await pool.query(`UPDATE events SET ${column} = false WHERE id = $1`, [id]);
    res.json({ ok: true });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;

initDb()
  .then(() => {
    app.listen(PORT, () => console.log(`NewNotes backend running on port ${PORT}`));

    // Daily digest at 8:00 AM server time. Only runs if reminder env vars are set.
    if (process.env.RESEND_API_KEY && process.env.REMINDER_EMAIL) {
      cron.schedule("0 8 * * *", async () => {
        try {
          await sendReminderDigest();
          console.log("Daily reminder digest sent.");
        } catch (err) {
          console.error("Failed to send daily digest:", err.message);
        }
      });
      console.log("Daily reminder digest scheduled for 8:00 AM.");
    } else {
      console.log("Reminders not configured (set RESEND_API_KEY + REMINDER_EMAIL in .env to enable).");
    }
  })
  .catch((err) => {
    console.error("Failed to init DB:", err);
    process.exit(1);
  });
