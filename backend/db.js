import pg from "pg";

const { Pool } = pg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes("neon.tech")
    ? { rejectUnauthorized: false }
    : false,
});

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sources (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      raw_text TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT now()
    );

    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      title_norm TEXT NOT NULL UNIQUE,
      date DATE,
      start_time TIME,
      end_time TIME,
      venue TEXT,
      type TEXT DEFAULT 'other',
      source_id INTEGER REFERENCES sources(id),
      source_name TEXT,
      status TEXT DEFAULT 'new',
      prev_date DATE,
      prev_start_time TIME,
      prev_end_time TIME,
      prev_venue TEXT,
      conflict_dismissed BOOLEAN DEFAULT false,
      change_dismissed BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now()
    );

    ALTER TABLE events ADD COLUMN IF NOT EXISTS conflict_dismissed BOOLEAN DEFAULT false;
    ALTER TABLE events ADD COLUMN IF NOT EXISTS change_dismissed BOOLEAN DEFAULT false;

    -- One free-text note per calendar date, e.g. "bring lab report", "carpool w/ Sam".
    CREATE TABLE IF NOT EXISTS notes (
      date DATE PRIMARY KEY,
      text TEXT NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT now()
    );
  `);
  console.log("Database ready.");
}
