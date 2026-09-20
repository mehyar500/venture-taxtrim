// functions/api/subscribe.js
// POST /api/subscribe — { email, case_token? }
// TaxTrim email capture (free-tier funnel entry). Stores in LEADS_DB
// (taxtrim_captures + taxtrim_unsub_tokens) and is synced to the central
// email_contact store (brand='taxtrim') by sync_taxtrim_captures.py, which
// also mints warmup_unsub_tokens so every email can carry List-Unsubscribe.
// Sends the result-card email via the injected mail path (transactional).
// Returns { ok:true, unsub_url }.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UNSUB_BASE = "https://taxtrim.mehyar.us/api/unsubscribe";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// In-memory per-isolate rate limit: 10 signups / 15 min / IP.
const RL = new Map();
function rateLimitOk(ip) {
  const now = Date.now();
  const arr = (RL.get(ip) || []).filter((ts) => now - ts < 15 * 60 * 1000);
  if (arr.length >= 10) return false;
  arr.push(now);
  RL.set(ip, arr);
  return true;
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env?.LEADS_DB) return json({ ok: false, error: "service_unavailable" }, 503);
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    if (!rateLimitOk(ip)) return json({ ok: false, error: "rate_limited" }, 429);

    const body = await request.json().catch(() => ({}));
    const email = String(body.email || "").trim().toLowerCase().slice(0, 254);
    if (!EMAIL_RE.test(email)) return json({ ok: false, error: "invalid_email" }, 400);
    const caseToken = String(body.case_token || "").slice(0, 64) || null;

    // Honor per-product suppression: a suppressed address can never re-enter.
    const suppressed = await env.LEADS_DB.prepare(
      "SELECT 1 FROM taxtrim_suppression WHERE email = ?"
    ).bind(email).first().catch(() => null);
    if (suppressed) return json({ ok: false, error: "unsubscribed" }, 200);

    const db = env.LEADS_DB;
    await db.prepare(
      "CREATE TABLE IF NOT EXISTS taxtrim_captures (" +
        "id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL, case_token TEXT, " +
        "ip TEXT, source TEXT NOT NULL DEFAULT 'web', unsubscribed INTEGER NOT NULL DEFAULT 0, " +
        "synced INTEGER NOT NULL DEFAULT 0, " +
        "created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))"
    ).run().catch(() => {});
    await db.prepare(
      "INSERT INTO taxtrim_captures (email, case_token, ip) VALUES (?, ?, ?)"
    ).bind(email, caseToken, ip.slice(0, 64)).run()
      .catch((e) => console.error("subscribe capture insert failed", e && e.message));

    await db.prepare(
      "CREATE TABLE IF NOT EXISTS taxtrim_unsub_tokens (token TEXT PRIMARY KEY, email TEXT NOT NULL, " +
        "created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))"
    ).run().catch(() => {});
    const token = crypto.randomUUID();
    await db.prepare("INSERT OR REPLACE INTO taxtrim_unsub_tokens (token, email) VALUES (?, ?)")
      .bind(token, email).run()
      .catch((e) => console.error("subscribe token store failed", e && e.message));

    const unsubUrl = `${UNSUB_BASE}?token=${token}`;

    // Result-card delivery: the capture row above is picked up by the
    // sync_taxtrim_captures.py cron (runs every 15 min), which upserts into
    // the central email_contact store and sends the transactional verdict
    // email via Brevo with List-Unsubscribe. Nothing to do here.

    return json({ ok: true, brand: "taxtrim", unsub_url: unsubUrl });
  } catch (e) {
    console.error("api/subscribe error", e && e.message);
    return json({ ok: false, error: "subscribe_failed" }, 500);
  }
}
