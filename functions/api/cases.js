// functions/api/cases.js
// POST /api/cases — { address?, borough?, bbl? } — the TaxTrim verdict engine.
//
// NYC address (or manual 10-digit BBL) -> BBL -> DOF assessment (8y4t-faws) +
// comparable sales (usep-8jbt, joined to PLUTO 64uk-42ks coords) ->
// deterministic over-assessment verdict. Every number is computed, never
// guessed; the AI is used only later, for the paid complaint narrative.
//
// HARD 75-DAY FRESHNESS GUARD: if the rolling sales feed's max sale_date is
// more than 75 days old, no verdict is computed (error: data_stale).
//
// Column map: ~/workspace/build/taxtrim/data/column-map.json (verified 2026-09-19).

const SOCRATA = "https://data.cityofnewyork.us";
const UA = { "user-agent": "TaxTrim/1.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36" };

const DS = { assess: "8y4t-faws", sales: "usep-8jbt", pluto: "64uk-42ks", rates: "7zb8-7bpk" };
const BOROUGH_NAME = { 1: "Manhattan", 2: "Bronx", 3: "Brooklyn", 4: "Queens", 5: "Staten Island" };

// Class 1 assessment ratio (6%) — NYC Tax Commission TC600 2026/27 instructions.
// Class 1 = 1-3 family homes, the only class TaxTrim serves.
const CLASS1_RATIO = 0.06;
// Latest PUBLISHED Class 1 rate (24/25, quoted in the current 2026-27 NOPV
// brochure). Flagged as an estimate everywhere it is used; refresh before Dec 1.
const CLASS1_RATE = 0.20085;
const CLASS1_RATE_YEAR = "24/25 (latest published)";

const STALE_DAYS = 75;
const MIN_COMPS = 5;
const MAX_COMPS = 30;

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// ── rate limiting: 20 lookups / hour / IP (per isolate) ──
const RL = new Map();
function rateLimitOk(ip) {
  const now = Date.now();
  const arr = (RL.get(ip) || []).filter((ts) => now - ts < 3600 * 1000);
  if (arr.length >= 20) return false;
  arr.push(now);
  RL.set(ip, arr);
  return true;
}

// ── Socrata helpers ──
async function soql(dataset, params) {
  const q = new URLSearchParams(params).toString();
  const r = await fetch(`${SOCRATA}/resource/${dataset}.json?${q}`, { headers: UA });
  if (!r.ok) throw new Error(`socrata ${dataset} -> HTTP ${r.status}`);
  return r.json();
}
async function viewsMeta(id) {
  const r = await fetch(`${SOCRATA}/api/views/${id}`, { headers: UA });
  if (!r.ok) throw new Error(`views ${id} -> HTTP ${r.status}`);
  const v = await r.json();
  return v.rowsUpdatedAt || null;
}
async function metaGet(db, k) {
  try {
    const row = await db.prepare("SELECT v, updated_at FROM taxtrim_meta WHERE k = ?").bind(k).first();
    return row || null;
  } catch { return null; }
}
async function metaSet(db, k, v) {
  try {
    await db.prepare("INSERT OR REPLACE INTO taxtrim_meta (k, v, updated_at) VALUES (?, ?, ?)")
      .bind(k, v, new Date().toISOString()).run();
  } catch {}
}
async function metaCached(db, k, ttlMs, fetcher) {
  const c = await metaGet(db, k);
  if (c && c.updated_at && Date.now() - Date.parse(c.updated_at) < ttlMs && c.v) {
    try { return JSON.parse(c.v); } catch {}
  }
  const v = await fetcher();
  await metaSet(db, k, JSON.stringify(v));
  return v;
}

function haversineMi(lat1, lon1, lat2, lon2) {
  const R = 3958.8;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
function median(nums) {
  if (!nums.length) return null;
  const s = nums.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function num(v) {
  const n = Number(String(v == null ? "" : v).replace(/,/g, ""));
  return isFinite(n) ? n : null;
}
// BBL from a rolling-sales row: borough + block (5-digit zp) + lot (4-digit zp).
function salesRowBbl(r) {
  const b = String(r.borough || "").trim();
  const bl = String(r.block || "").trim().padStart(5, "0");
  const l = String(r.lot || "").trim().padStart(4, "0");
  if (!/^[1-5]$/.test(b) || !/^\d{5}$/.test(bl) || !/^\d{4}$/.test(l)) return null;
  return b + bl + l;
}

// ── BBL resolution ──
async function geoclientBbl(env, address, boroughCode) {
  const appId = env.GEOCLIENT_APP_ID, appKey = env.GEOCLIENT_APP_KEY;
  if (!appId || !appKey) return null;
  const m = String(address).trim().match(/^(\d+[A-Za-z]?)\s+(.+)$/);
  if (!m) return null;
  const street = m[2].replace(/\b(apt|unit|suite|#)\b.*$/i, "").trim();
  const params = new URLSearchParams({
    houseNumber: m[1], street, borough: BOROUGH_NAME[boroughCode] || "",
    app_id: appId, app_key: appKey,
  });
  const r = await fetch(
    `https://geoservice.planning.nyc.gov/geoservice/geoservice.svc/address.json?${params}`,
    { headers: UA }
  );
  if (!r.ok) return null;
  const j = await r.json();
  const a = j && j.address;
  if (!a || !a.bbl) return null;
  return { bbl: String(a.bbl), lat: num(a.latitude), lon: num(a.longitude) };
}

export async function onRequestPost({ request, env }) {
  try {
    if (!env?.LEADS_DB) return json({ ok: false, error: "service_unavailable" }, 503);
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    if (!rateLimitOk(ip)) return json({ ok: false, error: "rate_limited" }, 429);
    const body = await request.json().catch(() => ({}));
    const db = env.LEADS_DB;
    await db.prepare(
      "CREATE TABLE IF NOT EXISTS taxtrim_meta (k TEXT PRIMARY KEY, v TEXT, updated_at TEXT)"
    ).run().catch(() => {});

    // ── 1. resolve BBL ──
    let bbl = String(body.bbl || "").replace(/\D/g, "");
    let geoLat = null, geoLon = null;
    if (!/^\d{10}$/.test(bbl)) {
      const address = String(body.address || "").trim();
      const boroughCode = String(body.borough || "").trim();
      if (!address || !BOROUGH_NAME[boroughCode]) {
        return json({ ok: false, error: "bad_input",
          message: "Enter a NYC address with borough, or a 10-digit BBL." }, 400);
      }
      try {
        const g = await geoclientBbl(env, address, boroughCode);
        if (g && /^\d{10}$/.test(g.bbl)) { bbl = g.bbl; geoLat = g.lat; geoLon = g.lon; }
      } catch (e) { console.error("geoclient failed", e && e.message); }
      if (!/^\d{10}$/.test(bbl)) {
        return json({ ok: false, error: "bbl_required",
          message: "We couldn't resolve that address automatically. Enter the 10-digit BBL from your Notice of Property Value (find it at nyc.gov/finance) and we'll run the analysis." }, 422);
      }
    }

    // ── 2. PLUTO: coords + block/lot ──
    const plutoRows = await soql(DS.pluto, {
      $select: "bbl,latitude,longitude,borocode,block,lot,address",
      $where: `bbl=${bbl}`,
      $limit: "2",
    });
    const pluto = (plutoRows && plutoRows[0]) || null;
    const lat = num(pluto && pluto.latitude) ?? geoLat;
    const lon = num(pluto && pluto.longitude) ?? geoLon;
    if (lat == null || lon == null) {
      return json({ ok: false, error: "no_location",
        message: "We found the BBL but not its map location, so we can't pull comparable sales." }, 422);
    }
    const boro = String((pluto && pluto.borocode) || bbl[0]);
    const block = pluto && pluto.block != null ? String(pluto.block) : bbl.slice(1, 6);
    const plutoAddress = (pluto && pluto.address) || "";

    // ── 3. current tax year (dynamic) ──
    const yearInfo = await metaCached(db, "tax_year", 24 * 3600 * 1000, async () => {
      const rows = await soql(DS.assess, { $select: "max(year)", $limit: "1" });
      const y = rows[0] && (rows[0].max_year || rows[0]._max_year);
      return { year: String(y || "2027") };
    });
    const taxYear = yearInfo.year;

    // ── 4. DOF assessment row (one row per BBL: rectype=1, latest period) ──
    const assessRows = await soql(DS.assess, {
      $select: "parid,boro,block,lot,housenum_lo,housenum_hi,street_name,zip_code,bldg_class," +
        "curmkttot,curmktland,curacttot,curactland,curactextot,curtrntot,curtxbtot,curtxbextot," +
        "curtaxclass,year,owner,units,yrbuilt,gross_sqft",
      $where: `parid='${bbl}' AND year='${taxYear}' AND rectype='1'`,
      $order: "period DESC",
      $limit: "1",
    });
    const a = (assessRows && assessRows[0]) || null;
    if (!a || num(a.curmkttot) == null) {
      return json({ ok: false, error: "no_assessment",
        message: "No current DOF assessment found for this BBL. It may be a new development or a merged lot." }, 422);
    }
    const dofMarket = num(a.curmkttot);
    const dofAssessed = num(a.curacttot) || 0;
    const dofBillable = num(a.curtxbtot) || 0;
    const taxClass = String(a.curtaxclass || "").trim();
    const bldgClass = String(a.bldg_class || "").trim();
    const zip = String(a.zip_code || "").trim();
    const dispAddress = [a.housenum_lo, a.street_name].filter(Boolean).join(" ") || plutoAddress;

    // TaxTrim serves Tax Class 1 (1-3 family homes) only — say so honestly.
    if (taxClass !== "1") {
      const caseToken = crypto.randomUUID();
      await db.prepare(
        "INSERT INTO taxtrim_cases (case_token, bbl, address, borough, tax_class, dof_market, " +
        "dof_assessed, verdict, data_vintage) VALUES (?, ?, ?, ?, ?, ?, ?, 'unsupported_class', ?)"
      ).bind(caseToken, bbl, dispAddress, BOROUGH_NAME[boro] || boro, taxClass, dofMarket,
        dofAssessed, JSON.stringify({ reason: "non_class_1" })).run().catch(() => {});
      return json({ ok: true, case_token: caseToken, bbl, address: dispAddress,
        borough: BOROUGH_NAME[boro] || boro, tax_class: taxClass,
        dof_market: dofMarket, dof_assessed: dofAssessed,
        verdict: "unsupported_class",
        verdict_label: "NOT COVERED",
        message: `This property is Tax Class ${taxClass}, not Class 1. TaxTrim's appeal packets are built for Class 1 (1–3 family) homes; other classes use different Tax Commission rules we don't model yet.` });
    }

    // ── 5. FRESHNESS GUARD (hard): rolling sales feed must be <= 75 days old ──
    const fresh = await metaCached(db, "sales_freshness", 6 * 3600 * 1000, async () => {
      const rows = await soql(DS.sales, { $select: "max(sale_date)", $where: "sale_price>0", $limit: "1" });
      const msd = rows[0] && (rows[0].max_sale_date || rows[0]._max_sale_date);
      return { max_sale_date: msd ? String(msd).slice(0, 10) : null };
    });
    const maxSaleDate = fresh.max_sale_date;
    const daysStale = maxSaleDate
      ? Math.floor((Date.now() - Date.parse(maxSaleDate + "T00:00:00Z")) / 86400000) : 9999;
    const salesUpdated = await viewsMeta(DS.sales).catch(() => null);
    if (!maxSaleDate || daysStale > STALE_DAYS) {
      return json({ ok: false, error: "data_stale",
        message: `NYC's sales feed is ${daysStale} days old (latest sale ${maxSaleDate || "unknown"}). ` +
          `TaxTrim won't guess from stale data — check back soon; the city usually refreshes daily.` }, 503);
    }

    // ── 6. comps: PLUTO bbox (1.5mi) + rolling sales by zip, joined client-side ──
    const R = 1.5, dLat = R / 69.0, dLon = R / (69.0 * Math.cos((lat * Math.PI) / 180));
    const plutoBbox = await soql(DS.pluto, {
      $select: "bbl,latitude,longitude",
      $where: `latitude between ${lat - dLat} and ${lat + dLat} AND longitude between ${lon - dLon} and ${lon + dLon}`,
      $limit: "50000",
    });
    const coordByBbl = new Map();
    for (const p of plutoBbox || []) {
      const pb = String(p.bbl || "").split(".")[0];
      const pla = num(p.latitude), plo = num(p.longitude);
      if (/^\d{10}$/.test(pb) && pla != null && plo != null) coordByBbl.set(pb, [pla, plo]);
    }
    const cutoff = new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10);
    const salesRows = await soql(DS.sales, {
      $select: "borough,block,lot,address,zip_code,sale_price,sale_date,neighborhood," +
        "building_class_category,building_class_at_time_of,tax_class_at_time_of_sale," +
        "total_units,gross_square_feet,year_built",
      $where: `sale_price>0 AND sale_date>'${cutoff}' AND borough='${boro}' AND zip_code='${zip}' ` +
        `AND tax_class_at_time_of_sale='1'`,
      $limit: "50000",
    });

    const bldgFam = bldgClass ? bldgClass[0].toUpperCase() : null;
    const candidates = [];
    for (const s of salesRows || []) {
      const sbbl = salesRowBbl(s);
      if (!sbbl || sbbl === bbl) continue;
      const price = num(s.sale_price);
      if (!price || price <= 0) continue;
      const coords = coordByBbl.get(sbbl);
      if (!coords) continue;
      const sbFam = String(s.building_class_at_time_of || "").trim().toUpperCase();
      if (bldgFam && sbFam && sbFam[0] !== bldgFam) continue;
      const d = haversineMi(lat, lon, coords[0], coords[1]);
      candidates.push({
        address: String(s.address || "").trim() || null,
        price, sale_date: String(s.sale_date || "").slice(0, 10),
        distance_mi: Math.round(d * 100) / 100,
        neighborhood: String(s.neighborhood || "").trim() || null,
      });
    }

    let radiusUsed = null, comps = [];
    for (const rTry of [0.5, 1.0, 1.5]) {
      const inR = candidates.filter((c) => c.distance_mi <= rTry)
        .sort((x, y) => x.distance_mi - y.distance_mi);
      if (inR.length >= MIN_COMPS) { radiusUsed = rTry; comps = inR.slice(0, MAX_COMPS); break; }
    }
    if (!comps.length) {
      return json({ ok: false, error: "insufficient_data",
        message: `Only ${candidates.length} comparable Class 1 sale(s) near this property in the last 12 months — ` +
          `not enough for an honest verdict. Try again in a few weeks as the city posts new sales.` }, 422);
    }

    const compMedian = median(comps.map((c) => c.price));
    const excessMarket = dofMarket - compMedian;
    const excessPct = dofMarket > 0 ? excessMarket / dofMarket : 0;
    let verdict, verdictLabel;
    if (excessPct >= 0.15) { verdict = "likely_over"; verdictLabel = "LIKELY OVER-ASSESSED"; }
    else if (excessPct >= 0.05) { verdict = "borderline"; verdictLabel = "BORDERLINE"; }
    else { verdict = "probably_fair"; verdictLabel = "PROBABLY FAIR"; }

    const excessAssessed = Math.max(0, excessMarket) * CLASS1_RATIO;
    const annualOverpay = excessAssessed * CLASS1_RATE;

    // ── 7. block median + percentile (Class 1 market values on the block) ──
    let blockMedian = null, percentile = null;
    try {
      const blockRows = await soql(DS.assess, {
        $select: "parid,curmkttot,period",
        $where: `boro='${boro}' AND block='${block}' AND year='${taxYear}' AND rectype='1' AND curtaxclass='1'`,
        $limit: "50000",
      });
      const byBbl = new Map();
      for (const br of blockRows || []) {
        const mv = num(br.curmkttot);
        if (mv == null || mv <= 0) continue;
        const pid = String(br.parid || "").trim();
        const per = Number(br.period || 0);
        const cur = byBbl.get(pid);
        if (!cur || per > cur.per) byBbl.set(pid, { mv, per });
      }
      const mvs = [...byBbl.values()].map((v) => v.mv);
      if (mvs.length >= 3) {
        blockMedian = median(mvs);
        const below = mvs.filter((v) => v < dofMarket).length;
        percentile = Math.round((below / mvs.length) * 100);
      }
    } catch (e) { console.error("block median failed", e && e.message); }

    // ── 8. persist case ──
    const vintage = {
      assessment_roll: `FY ${taxYear}`,
      sales_max_date: maxSaleDate,
      sales_days_stale: daysStale,
      sales_feed_updated: salesUpdated,
      rate_year: CLASS1_RATE_YEAR,
      rate_estimated: true,
    };
    const caseToken = crypto.randomUUID();
    const compsJson = JSON.stringify(comps.map((c) => ({
      address: c.address, price: c.price, sale_date: c.sale_date, distance_mi: c.distance_mi,
    })));
    await db.prepare(
      "INSERT INTO taxtrim_cases (case_token, bbl, address, borough, tax_class, dof_market, dof_assessed, " +
      "comp_median, comp_count, block_median_market, verdict, excess_market, excess_assessed, " +
      "annual_overpay, percentile, data_vintage, comps_json, ip) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(caseToken, bbl, dispAddress, BOROUGH_NAME[boro] || boro, taxClass, dofMarket, dofAssessed,
      compMedian, comps.length, blockMedian, verdict, excessMarket,
      Math.round(excessAssessed), Math.round(annualOverpay), percentile,
      JSON.stringify(vintage), compsJson, ip.slice(0, 64)
    ).run().catch((e) => console.error("case insert failed", e && e.message));

    return json({
      ok: true, case_token: caseToken, bbl, address: dispAddress,
      borough: BOROUGH_NAME[boro] || boro, tax_class: taxClass,
      dof_market: dofMarket, dof_assessed: dofAssessed,
      comp_median: Math.round(compMedian), comp_count: comps.length,
      radius_mi: radiusUsed, block_median_market: blockMedian,
      verdict, verdict_label: verdictLabel,
      excess_market: Math.round(excessMarket),
      excess_assessed: Math.round(excessAssessed),
      annual_overpay: Math.round(annualOverpay),
      annual_overpay_estimated: true,
      percentile,
      data_vintage: vintage,
      vintage_note: `Comparable sales through ${maxSaleDate}; tax-rate math estimated with the latest published Class 1 rate (${CLASS1_RATE_YEAR}).`,
    });
  } catch (e) {
    console.error("api/cases error", e && e.message);
    return json({ ok: false, error: "lookup_failed",
      message: "The city's data service hiccuped. Try again in a minute." }, 502);
  }
}
