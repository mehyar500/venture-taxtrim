// functions/api/kit/status.js
// GET /api/kit/status?token= — order status for success.html polling.
// Token = order access_token (== billing_payments.access_token after unification).

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function onRequestGet({ request, env }) {
  try {
    const token = new URL(request.url).searchParams.get("token") || "";
    if (!token || token.length < 16 || !env?.LEADS_DB) {
      return json({ ok: false, error: "not_found" }, 404);
    }
    const order = await env.LEADS_DB.prepare(
      "SELECT status, access_token FROM taxtrim_orders WHERE access_token = ?"
    ).bind(token).first();
    if (!order) return json({ ok: false, error: "not_found" }, 404);
    return json({ ok: true, status: order.status, access_token: order.access_token });
  } catch (e) {
    console.error("api/kit/status error", e && e.message);
    return json({ ok: false, error: "status_failed" }, 500);
  }
}
