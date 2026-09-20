// functions/api/kit/packet.js
// GET /api/kit/packet?token= — token-gated paid packet JSON for packet.html.
// The token is the order access_token (unified with billing_payments.access_token
// at webhook time). Unknown/short tokens -> 404. Only 'ready' orders serve.

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
    const db = env.LEADS_DB;
    const order = await db.prepare(
      "SELECT status, output_json FROM taxtrim_orders WHERE access_token = ?"
    ).bind(token).first();
    if (!order || !order.output_json) return json({ ok: false, error: "not_found" }, 404);
    if (order.status !== "ready") return json({ ok: false, error: "not_ready", status: order.status }, 409);
    return json({ ok: true, packet: JSON.parse(order.output_json) });
  } catch (e) {
    console.error("api/kit/packet error", e && e.message);
    return json({ ok: false, error: "packet_failed" }, 500);
  }
}
