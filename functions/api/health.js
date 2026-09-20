// functions/api/health.js
// GET /api/health — dataset vintage stamps for the freshness guard.
// Returns rowsUpdatedAt per Socrata dataset + the max sale date observed in
// the active sales feed, cached 6h in D1 (taxtrim_meta). The verdict engine
// refuses to compute when the sales feed is >75 days stale.

const DATASETS = {
  assess: "8y4t-faws",
  sales_rolling: "usep-8jbt",
  sales_annual: "w2pb-icbu",
  rates: "7zb8-7bpk",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

const UA = { "user-agent": "TaxTrim/1.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" };

async function viewsMeta(id) {
  const r = await fetch(`https://data.cityofnewyork.us/api/views/${id}`, { headers: UA });
  if (!r.ok) throw new Error("views " + id + " -> " + r.status);
  const v = await r.json();
  return { rows_updated_at: v.rowsUpdatedAt || null, name: v.name || id };
}

export async function onRequestGet({ env }) {
  try {
    const db = env?.LEADS_DB;
    if (db) {
      await db.prepare(
        "CREATE TABLE IF NOT EXISTS taxtrim_meta (k TEXT PRIMARY KEY, v TEXT, updated_at TEXT)"
      ).run().catch(() => {});
      const cached = await db.prepare("SELECT v, updated_at FROM taxtrim_meta WHERE k = 'health'")
        .first().catch(() => null);
      if (cached && cached.updated_at) {
        const age = Date.now() - Date.parse(cached.updated_at);
        if (age < 6 * 3600 * 1000 && cached.v) return json(JSON.parse(cached.v));
      }
    }
    const out = { ok: true, at: new Date().toISOString(), datasets: {} };
    for (const [k, id] of Object.entries(DATASETS)) {
      try { out.datasets[k] = { id, ...(await viewsMeta(id)) }; }
      catch (e) { out.datasets[k] = { id, error: String(e && e.message).slice(0, 120) }; }
    }
    // Max sale date in the rolling feed (staleness guard input).
    try {
      const r = await fetch(
        "https://data.cityofnewyork.us/resource/usep-8jbt.json?$select=max(sale_date)&$limit=1",
        { headers: UA }
      );
      if (r.ok) {
        const rows = await r.json();
        out.max_sale_date = (rows[0] && (rows[0].max_sale_date || rows[0]._max_sale_date)) || null;
      }
    } catch (e) { out.max_sale_date_error = String(e && e.message).slice(0, 120); }

    if (db) {
      await db.prepare("INSERT OR REPLACE INTO taxtrim_meta (k, v, updated_at) VALUES ('health', ?, ?)")
        .bind(JSON.stringify(out), new Date().toISOString()).run().catch(() => {});
    }
    return json(out);
  } catch (e) {
    console.error("api/health error", e && e.message);
    return json({ ok: false, error: "health_failed" }, 500);
  }
}
