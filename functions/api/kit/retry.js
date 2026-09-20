// functions/api/kit/retry.js
// POST /api/kit/retry — { token } — buyer-initiated packet rebuild.
// Delegates to the mehyar-web regenerate endpoint (the single source of
// truth for packet generation lives in fulfillTaxtrim). The order's own
// access_token is the capability — no other auth needed.

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function onRequestPost({ request }) {
  try {
    const body = await request.json().catch(() => ({}));
    const token = String(body.token || "");
    if (!token || token.length < 16) return json({ ok: false, error: "not_found" }, 404);
    const r = await fetch("https://mehyar.us/api/taxtrim/regenerate", {
      method: "POST",
      headers: { "content-type": "application/json",
                 "user-agent": "TaxTrim-Pages/1.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" },
      body: JSON.stringify({ token }),
    });
    const out = await r.json().catch(() => ({}));
    return json(out, r.ok ? 200 : (r.status === 404 ? 404 : 500));
  } catch (e) {
    console.error("api/kit/retry error", e && e.message);
    return json({ ok: false, error: "retry_failed" }, 500);
  }
}
