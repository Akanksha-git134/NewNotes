const PROMPT = (text) => `Extract every event, exam, deadline, or appointment mentioned in this campus notice. Return ONLY a JSON array, no markdown fences, no preamble, no explanation. Each item must have exactly these fields:
- title (short string)
- date (YYYY-MM-DD, assume year 2026 if not specified)
- start_time (HH:MM in 24-hour time, or null if it's an all-day deadline)
- end_time (HH:MM in 24-hour time, or null)
- venue (string, or "Online" or "N/A")
- type: pick exactly ONE of these five values based on strict rules:
  - "exam" — ONLY for midterms, finals, quizzes, or tests that are part of a course's academic evaluation
  - "internship" — ONLY for internship-related items: online assessments (OAs), interviews, applications, offers — even if the notice calls it an "assessment" or "test", if it's tied to a company/internship it is "internship", NOT "exam"
  - "assignment" — homework, projects, or submission deadlines for a course
  - "event" — club events, orientations, fests, talks, workshops
  - "other" — anything that doesn't fit the above

If the notice contains no extractable event, return an empty array.

Notice text:
"""${text}"""`;

function parseJsonResponse(raw) {
  const clean = raw.replace(/```json|```/g, "").trim();
  try {
    const parsed = JSON.parse(clean);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch (e) {
    // Fallback: the model may have wrapped the JSON in explanatory prose
    // despite instructions not to. Find the first [...] or {...} block and
    // try parsing just that, instead of failing outright.
    const arrayMatch = clean.match(/\[[\s\S]*\]/);
    const objectMatch = clean.match(/\{[\s\S]*\}/);
    const candidate = arrayMatch?.[0] || objectMatch?.[0];
    if (candidate) {
      try {
        const parsed = JSON.parse(candidate);
        return Array.isArray(parsed) ? parsed : [parsed];
      } catch (e2) {
        // fall through to the error below
      }
    }
    throw new Error("Model did not return valid JSON: " + clean.slice(0, 200));
  }
}

// Uses Google's Gemini API free tier (Google AI Studio) — no credit card,
// 1,500 requests/day, native JSON mode. Get a key at https://aistudio.google.com/apikey
async function extractWithGemini(text) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set. Add it to your .env file.");

  const model = "gemini-3.5-flash";
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: PROMPT(text) }] }],
        generationConfig: { responseMimeType: "application/json" },
      }),
    }
  );
  if (!res.ok) throw new Error(`Gemini API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const raw = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
  return parseJsonResponse(raw);
}

// Uses OpenRouter's free tier (:free models) — no credit card, but 50 req/day
// and the free model roster rotates. Get a key at https://openrouter.ai/keys
// Set OPENROUTER_MODEL in .env to whatever :free model is currently live —
// check https://openrouter.ai/models?max_price=0 for the current list.
async function extractWithOpenRouter(text) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set. Add it to your .env file.");
  const model = process.env.OPENROUTER_MODEL || "meta-llama/llama-3.3-70b-instruct:free";

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: PROMPT(text) }],
    }),
  });
  if (!res.ok) throw new Error(`OpenRouter API error ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content || "";
  return parseJsonResponse(raw);
}

// Switch providers by setting LLM_PROVIDER=gemini or LLM_PROVIDER=openrouter in .env
export async function extractEvents(text) {
  const provider = (process.env.LLM_PROVIDER || "gemini").toLowerCase();
  if (provider === "openrouter") return extractWithOpenRouter(text);
  return extractWithGemini(text);
}
