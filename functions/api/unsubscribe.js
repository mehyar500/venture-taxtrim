// functions/api/unsubscribe.js
// GET /api/unsubscribe?token= — one-click unsubscribe. Honored immediately:
// flips taxtrim_captures.unsubscribed, adds to taxtrim_suppression
// (per-product do-not-mail), and the sync job propagates opted_out to the
// central email_contact store. Renders a plain confirmation page.

function page(msg) {
  return new Response(
    `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>Unsubscribed — TaxTrim</title>` +
    `<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;` +
    `background:#f4f7fb;color:#0f1b2d;display:flex;min-height:100vh;align-items:center;` +
    `justify-content:center;margin:0;padding:20px}` +
    `.c{background:#fff;border-radius:16px;padding:32px;max-width:420px;text-align:center;` +
    `box-shadow:0 6px 24px rgba(15,27,45,.08)}</style></head>` +
    `<body><div class="c"><h1>✅ ${msg}</h1>` +
    `<p style="color:#64748b">You won't receive any more emails from TaxTrim. ` +
    `Your verdict results and any purchased packets stay available.</p>` +
    `<p><a href="https://taxtrim.mehyar.us/">Back to TaxTrim</a></p></div></body></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } }
  );
}

export async function onRequestGet({ request, env }) {
  try {
    const token = new URL(request.url).searchParams.get("token") || "";
    if (!token || !env?.LEADS_DB) return page("Unsubscribed");
    const db = env.LEADS_DB;
    const row = await db.prepare("SELECT email FROM taxtrim_unsub_tokens WHERE token = ?")
      .bind(token).first().catch(() => null);
    if (!row || !row.email) return page("Unsubscribed");
    const email = String(row.email).toLowerCase();

    await db.prepare("UPDATE taxtrim_captures SET unsubscribed = 1, synced = 0 WHERE email = ?")
      .bind(email).run().catch(() => {});
    await db.prepare("INSERT OR IGNORE INTO taxtrim_suppression (email, reason) VALUES (?, 'unsubscribe')")
      .bind(email).run().catch(() => {});
    return page("Unsubscribed");
  } catch (e) {
    console.error("api/unsubscribe error", e && e.message);
    return page("Unsubscribed");
  }
}
