// functions/api/cases/[token].js
// GET /api/cases/:token — fetch a stored verdict for the email/deep link.

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

export async function onRequestGet({ params, env }) {
  try {
    const token = params.token || "";
    if (!token || token.length < 16 || !env?.LEADS_DB) {
      return json({ ok: false, error: "not_found" }, 404);
    }
    const c = await env.LEADS_DB.prepare(
      "SELECT case_token, bbl, address, borough, tax_class, dof_market, dof_assessed, " +
      "comp_median, comp_count, block_median_market, verdict, excess_market, excess_assessed, " +
      "annual_overpay, percentile, data_vintage, comps_json FROM taxtrim_cases WHERE case_token = ?"
    ).bind(token).first();
    if (!c) return json({ ok: false, error: "not_found" }, 404);
    let vintage = {};
    try { vintage = JSON.parse(c.data_vintage || "{}"); } catch {}
    return json({ ok: true, case: {
      case_token: c.case_token, bbl: c.bbl, address: c.address, borough: c.borough,
      tax_class: c.tax_class, dof_market: c.dof_market, dof_assessed: c.dof_assessed,
      comp_median: c.comp_median, comp_count: c.comp_count,
      block_median_market: c.block_median_market, verdict: c.verdict,
      excess_market: c.excess_market, excess_assessed: c.excess_assessed,
      annual_overpay: c.annual_overpay, percentile: c.percentile,
      data_vintage: vintage,
    }});
  } catch (e) {
    console.error("api/cases/[token] error", e && e.message);
    return json({ ok: false, error: "lookup_failed" }, 500);
  }
}
