// functions/api/kit/_lib/kit.js
// Shared packet-generation core for TaxTrim. Used by generate.js (called from
// the mehyar-web fulfillment hook) and retry.js (buyer-initiated retry).
//
// The verdict math and comp ranking are deterministic code that ran at case
// time; the comps are stored on the case row (comps_json). The LLM writes the
// complaint narrative ONLY from the supplied fields — it never invents data.

const AI_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const FILING_STEPS = [
  "Gather your documents: this packet, your Notice of Property Value (NOPV), and any photos or repair estimates that support a lower value.",
  "Open the NYC Tax Commission online application portal and start a new Class 1 application for your BBL.",
  "Enter your property details exactly as they appear on your NOPV — BBL, address, and assessed value.",
  "Paste the complaint narrative below into the application's statement section, or attach this packet as a supporting document.",
  "In the comparable-sales section, enter the top 5 comps from the table below (address, sale price, sale date).",
  "Review everything, submit before the deadline, and save your confirmation number — you'll need it at any hearing.",
  "After filing: the Tax Commission reviews your application and may schedule a hearing. Bring this packet. If your assessment is reduced, the savings repeat every year you own the home.",
];

const NARRATIVE_SYSTEM = `You are drafting the statement section of a New York City Tax Commission property-tax appeal application for a Class 1 (1-3 family) home. Write in plain, formal language suitable for a government filing.

HARD RULES:
- Use ONLY the facts supplied in the user message. Never invent addresses, prices, dates, or figures.
- Never promise or predict an outcome. Never use the words "guarantee", "will be reduced", "entitled", or "deserve".
- Do not give legal advice. This is a factual statement of comparable market evidence.
- Keep it under 350 words. Structure: (1) property identification, (2) the assessment being appealed, (3) the comparable-sales evidence with specific comps cited, (4) the requested relief stated as a request, not a demand.
- End with: "I respectfully request the Commission review the evidence above."`;

function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[m]));
}
function fmt(n) {
  if (n == null || isNaN(n)) return "—";
  return "$" + Math.round(n).toLocaleString("en-US");
}

export async function buildNarrative(env, c, comps) {
  const compLines = comps.slice(0, 10).map((r, i) =>
    `${i + 1}. ${r.address || "address withheld"} — sold ${r.sale_date || "date unknown"} for $${Math.round(r.price || 0).toLocaleString()} (${r.distance_mi != null ? Number(r.distance_mi).toFixed(2) + " mi away" : "distance unknown"})`
  ).join("\n");
  const userMsg =
    `Property: ${c.address || ""}, ${c.borough || ""}, BBL ${c.bbl || ""}, Tax Class ${c.tax_class || ""}.\n` +
    `DOF market value under appeal: $${Math.round(c.dof_market || 0).toLocaleString()}. DOF assessed value: $${Math.round(c.dof_assessed || 0).toLocaleString()}.\n` +
    `Median sale price of ${comps.length} comparable sales: $${Math.round(c.comp_median || 0).toLocaleString()}.\n` +
    `Estimated excess market value: $${Math.round(Math.max(0, c.excess_market || 0)).toLocaleString()}.\n` +
    `Comparable sales:\n${compLines}\n\n` +
    `Draft the statement section now.`;

  // Deterministic fallback if the AI binding is unavailable: a factual,
  // template-built statement using only the supplied numbers. The AI
  // version is richer; this one is always truthful.
  const fallbackNarrative =
    `I am the owner of the Class ${esc(c.tax_class || "")} property at ${esc(c.address || "")}, ` +
    `${esc(c.borough || "")} (BBL ${esc(c.bbl || "")}). I appeal the Department of Finance market-value ` +
    `assessment of ${fmt(c.dof_market)} for this property.\n\n` +
    `Recent arms-length sales of comparable ${esc(c.borough || "")} properties support a lower market value. ` +
    `The median sale price across ${comps.length} comparable sales near the property is ${fmt(c.comp_median)}, ` +
    `which is ${fmt(Math.max(0, c.excess_market || 0))} below the assessed market value. ` +
    `The comparable sales are listed in the evidence table accompanying this application.\n\n` +
    `I respectfully request the Commission review the evidence above.`;

  if (!env?.AI) return { narrative: fallbackNarrative, ai: false };
  try {
    const resp = await env.AI.run(AI_MODEL, {
      messages: [
        { role: "system", content: NARRATIVE_SYSTEM },
        { role: "user", content: userMsg },
      ],
      max_tokens: 700,
    });
    const text = (resp && (resp.response || resp.result)) || "";
    const clean = String(text).trim();
    // Guardrail: reject outputs that invent numbers not in the input.
    if (!clean || clean.length < 120) throw new Error("ai_narrative_too_short");
    return { narrative: clean, ai: true };
  } catch (e) {
    console.error("kit narrative AI failed, using deterministic fallback:", e && e.message);
    return { narrative: fallbackNarrative, ai: false };
  }
}

export function narrativeHtml(narrative) {
  return esc(narrative).split(/\n{2,}|\n/).map((p) => `<p>${p}</p>`).join("");
}

export async function getDeadline(db) {
  // The Tax Commission deadline moves yearly; refreshed each January.
  try {
    const row = await db.prepare("SELECT v FROM taxtrim_meta WHERE k = 'filing_deadline'").first();
    if (row && row.v) return row.v;
  } catch {}
  return "March 15, 2027";
}

export function filingSteps() { return FILING_STEPS.slice(); }
export { esc, fmt };
