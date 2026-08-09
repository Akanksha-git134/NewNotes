import { pool } from "./db.js";

function fmtTime(t) {
  return t ? t.toString().slice(0, 5) : "All day";
}
// pg returns DATE columns as a JS Date at UTC midnight. Formatting that with
// toLocaleDateString() converts through the SERVER's local timezone, which
// silently shifts the printed date back a day whenever the server runs in a
// negative-UTC-offset zone — the same bug the calendar UI had. Reading the
// UTC getters instead of the local ones sidesteps the conversion entirely.
function fmtDate(d) {
  if (!d) return "—";
  const dt = new Date(d);
  return new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()))
    .toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

function toMinutes(t) {
  if (!t) return null;
  const [h, m] = t.toString().split(":").map(Number);
  return h * 60 + m;
}

function toUtcDayStart(d) {
  const dt = new Date(d);
  return Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate());
}

// Find events happening within `hours` from now, and cross-check conflicts among ALL events.
async function getDigestData(hours = 48) {
  const events = (await pool.query(`SELECT * FROM events ORDER BY date ASC NULLS LAST`)).rows;

  const now = new Date();
  const todayUtcStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const cutoff = todayUtcStart + hours * 60 * 60 * 1000;

  const upcoming = events.filter((e) => {
    if (!e.date) return false;
    const d = toUtcDayStart(e.date);
    return d >= todayUtcStart && d <= cutoff;
  });

  // conflicts across all events (same date, overlapping time)
  const conflicts = [];
  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      const a = events[i], b = events[j];
      if (!a.date || !b.date || a.date.toString() !== b.date.toString()) continue;
      const as = toMinutes(a.start_time), ae = toMinutes(a.end_time);
      const bs = toMinutes(b.start_time), be = toMinutes(b.end_time);
      if (as == null || ae == null || bs == null || be == null) continue;
      if (as < be && bs < ae) conflicts.push([a, b]);
    }
  }

  const recentChanges = events.filter((e) => e.status === "changed");

  return { upcoming, conflicts, recentChanges };
}

function buildEmailHtml({ upcoming, conflicts, recentChanges }) {
  const section = (title, rows) =>
    rows.length
      ? `<h3 style="margin:20px 0 8px;font-family:sans-serif;color:#141b2b;">${title}</h3>` + rows.join("")
      : "";

  const upcomingRows = upcoming.map(
    (e) => `<div style="padding:10px 14px;border:1px solid #c7c4d8;border-radius:8px;margin-bottom:6px;font-family:sans-serif;">
      <strong>${e.title}</strong><br/>
      <span style="color:#464555;font-size:13px;">${fmtDate(e.date)} · ${fmtTime(e.start_time)} · ${e.venue || "N/A"}</span>
    </div>`
  );

  const conflictRows = conflicts.map(
    ([a, b]) => `<div style="padding:10px 14px;border:1px solid #ba1a1a;background:#ffdad6;border-radius:8px;margin-bottom:6px;font-family:sans-serif;">
      <strong>${a.title}</strong> overlaps with <strong>${b.title}</strong><br/>
      <span style="color:#464555;font-size:13px;">${fmtDate(a.date)} · ${fmtTime(a.start_time)}–${fmtTime(a.end_time)} vs ${fmtTime(b.start_time)}–${fmtTime(b.end_time)}</span>
    </div>`
  );

  const changeRows = recentChanges.map(
    (e) => `<div style="padding:10px 14px;border:1px solid #3525cd;border-radius:8px;margin-bottom:6px;font-family:sans-serif;">
      <strong>${e.title}</strong> changed<br/>
      <span style="color:#464555;font-size:13px;">${fmtDate(e.prev_date)} ${fmtTime(e.prev_start_time)} → ${fmtDate(e.date)} ${fmtTime(e.start_time)}</span>
    </div>`
  );

  return `
    <div style="max-width:480px;margin:0 auto;">
      <h2 style="font-family:sans-serif;color:#3525cd;">NewNotes Daily Digest</h2>
      ${section("⚠️ Conflicts", conflictRows)}
      ${section("📅 Coming up (next 48h)", upcomingRows)}
      ${section("🔄 Recently changed", changeRows)}
      ${!conflicts.length && !upcoming.length && !recentChanges.length ? '<p style="font-family:sans-serif;color:#505f76;">Nothing urgent — you\'re all caught up.</p>' : ""}
    </div>
  `;
}

export async function sendReminderDigest() {
  const apiKey = process.env.RESEND_API_KEY;
  const to = process.env.REMINDER_EMAIL;
  if (!apiKey || !to) {
    throw new Error("RESEND_API_KEY and REMINDER_EMAIL must be set in .env to send reminders.");
  }

  const data = await getDigestData(48);
  const html = buildEmailHtml(data);

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      from: "NewNotes <onboarding@resend.dev>",
      to: [to],
      subject: `NewNotes: ${data.conflicts.length} conflict(s), ${data.upcoming.length} coming up`,
      html,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }

  return {
    sent: true,
    upcomingCount: data.upcoming.length,
    conflictCount: data.conflicts.length,
    changeCount: data.recentChanges.length,
  };
}
