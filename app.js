/* TaxTrim shared frontend logic. Contract: POST /api/cases returns the case
   fields flat (case_token, verdict, verdict_label, ...); GET /api/cases/:token
   returns { ok, case } for email/deep links. */
(function(){
  "use strict";

  function $(id){ return document.getElementById(id); }
  function fmt(n){
    if (n === null || n === undefined || isNaN(n)) return "—";
    return "$" + Math.round(n).toLocaleString("en-US");
  }
  function esc(s){
    return String(s == null ? "" : s).replace(/[&<>"']/g, function(m){
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m];
    });
  }
  function showError(id, msg){
    var el = $(id); if (!el) return;
    el.textContent = msg; el.style.display = "block";
  }
  function hide(id){ var el = $(id); if (el) el.style.display = "none"; }
  function show(id){ var el = $(id); if (el) el.style.display = ""; }

  var VERDICTS = {
    likely_over:   { label: "LIKELY OVER-ASSESSED", cls: "over", pin: 84,
                     blurb: "Your DOF market value sits well above what comparable homes actually sold for. This is the profile that wins appeals." },
    borderline:    { label: "BORDERLINE", cls: "border", pin: 50,
                     blurb: "Your assessment is close to the comp median — an appeal is a judgment call. The packet still lays out the full case." },
    probably_fair: { label: "PROBABLY FAIR", cls: "fair", pin: 16,
                     blurb: "Your assessment lines up with recent sales. Filing an appeal on these numbers would likely be a waste of your evening." },
    unsupported_class: { label: "NOT COVERED", cls: "blocked", pin: 50,
                     blurb: "TaxTrim's appeal packets are built for Tax Class 1 (1–3 family) homes. Other classes use different Tax Commission rules we don't model yet." }
  };

  async function runCheck(input){
    hide("form-error");
    if (!input.address && !(input.bbl && input.bbl.length === 10)) {
      showError("form-error", "Enter your NYC address, or a 10-digit BBL.");
      return;
    }
    hide("input-view"); show("loading-view"); hide("result-view"); hide("result-cta");
    var steps = ["Pulling your assessment…","Finding comparable sales…","Running the verdict math…"];
    var si = 0;
    var tick = setInterval(function(){ si = (si+1) % steps.length; var t = $("loading-text"); if (t) t.textContent = steps[si]; }, 1800);
    try {
      var resp = await fetch("/api/cases", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify(input)
      });
      var data = await resp.json().catch(function(){ return {}; });
      clearInterval(tick);
      hide("loading-view");
      if (!resp.ok || !data.ok) {
        show("input-view");
        var msg = data.message || "Something went wrong looking up that property.";
        if (data.error === "rate_limited") msg = "You've run several checks recently — please wait a few minutes and try again.";
        if (data.error === "bbl_required") {
          show("bbl-view"); hide("input-view");
          showError("bbl-error", msg);
          return;
        }
        showError("form-error", msg);
        return;
      }
      renderResult(data);
      show("result-view");
      if (data.verdict !== "unsupported_class") show("result-cta");
      history.replaceState(null, "", "/check.html?case=" + encodeURIComponent(data.case_token));
    } catch (e) {
      clearInterval(tick); hide("loading-view"); show("input-view");
      showError("form-error", "Network hiccup — please try again.");
    }
  }

  async function loadCase(token){
    hide("input-view"); show("loading-view"); hide("result-view"); hide("result-cta");
    try {
      var resp = await fetch("/api/cases/" + encodeURIComponent(token));
      var data = await resp.json().catch(function(){ return {}; });
      hide("loading-view");
      if (!resp.ok || !data.ok || !data.case) { show("input-view"); return; }
      renderResult(data.case);
      show("result-view");
      if (data.case.verdict !== "unsupported_class") show("result-cta");
    } catch (e) { hide("loading-view"); show("input-view"); }
  }

  function blockVs(c){
    if (c.block_median_market == null || !c.dof_market) return "—";
    var d = Math.round((c.dof_market - c.block_median_market) / c.block_median_market * 100);
    return (d >= 0 ? "+" : "") + d + "% vs block";
  }

  function renderResult(c){
    var v = VERDICTS[c.verdict] || VERDICTS.unsupported_class;
    var maxBar = Math.max(c.dof_market || 0, c.comp_median || 0, 1);
    var nycW = Math.round((c.dof_market || 0) / maxBar * 100);
    var trueW = Math.round((c.comp_median || 0) / maxBar * 100);
    var gapTxt;
    if (c.verdict === "unsupported_class") {
      gapTxt = "No verdict computed — see note above.";
    } else if (c.excess_market > 0) {
      gapTxt = "You're assessed <strong>" + fmt(c.excess_market) + "</strong> above the comp median.";
    } else if (c.excess_market < 0) {
      gapTxt = "You're assessed <strong>" + fmt(Math.abs(c.excess_market)) + "</strong> below the comp median.";
    } else { gapTxt = "Right on the comp median."; }

    var vintage = c.data_vintage || {};
    var vintageLine = "Comparable sales through " + esc(vintage.sales_max_date || "—")
      + " · assessment roll FY " + esc((vintage.assessment_roll || "").replace("FY ", ""))
      + " · tax-rate math estimated with latest published Class 1 rate";

    var html = ''
      + '<section class="hero"><span class="eyebrow">Your free verdict</span>'
      + '<h1>' + esc(c.address || "Your property") + '</h1>'
      + '<p class="lede">' + esc(c.borough || "") + (c.tax_class ? ' · Tax Class ' + esc(c.tax_class) : '') + ' · BBL ' + esc(c.bbl || "") + '</p></section>'
      + '<div class="card">'
      + '<span class="verdict-badge ' + v.cls + '">' + esc(c.verdict_label || v.label) + '</span>'
      + '<p>' + v.blurb + '</p>'
      + '<div class="meter"><span class="pin" style="left:' + v.pin + '%"></span></div>'
      + '<div class="meter-labels"><span>FAIR</span><span>BORDERLINE</span><span>OVER-ASSESSED</span></div>';

    if (c.verdict !== "unsupported_class") {
      html += ''
      + '<div class="vs">'
      + '<div class="vs-row"><div class="lab"><span>🏛️ NYC says (market value)</span><span class="val">' + fmt(c.dof_market) + '</span></div>'
      + '<div class="bar nyc"><i style="width:' + nycW + '%"></i></div></div>'
      + '<div class="vs-row"><div class="lab"><span>📊 ' + (c.comp_count || 0) + ' comparable sales say</span><span class="val">' + fmt(c.comp_median) + '</span></div>'
      + '<div class="bar true"><i style="width:' + trueW + '%"></i></div></div>'
      + '</div>'
      + '<p class="vs-caption">' + gapTxt + '</p>'
      + '<div class="stat-grid">'
      + '<div class="stat"><div class="k">Est. excess assessment</div><div class="v ' + (c.excess_assessed > 0 ? "bad" : "good") + '">' + fmt(c.excess_assessed) + '</div></div>'
      + '<div class="stat"><div class="k">Est. yearly overpayment*</div><div class="v ' + (c.annual_overpay > 0 ? "bad" : "good") + '">' + fmt(c.annual_overpay) + '/yr</div></div>'
      + '<div class="stat"><div class="k">Your value vs block median</div><div class="v">' + blockVs(c) + '</div></div>'
      + '<div class="stat"><div class="k">Your percentile vs comps</div><div class="v">' + (c.percentile != null ? Math.round(c.percentile) + "th" : "—") + '</div></div>'
      + '</div>'
      + '<p class="vintage">' + vintageLine + '</p>'
      + '<p class="tiny">*Estimated with the latest published Class 1 tax rate. For illustration only — not legal or tax advice.</p>';
    } else {
      html += '<p class="vs-caption">No verdict computed — see note above.</p>';
    }
    html += '</div>';

    // email gate (funnel entry) — shown once, right after the free result
    html += ''
      + '<div class="email-gate" id="email-gate">'
      + '<h3>📧 Get this verdict + deadline reminders</h3>'
      + '<p class="tiny" style="font-size:14px">We\'ll email your result card and nudge you before the March filing deadline. No spam — one-click unsubscribe on everything.</p>'
      + '<div class="inline-form"><input id="gate-email" type="email" inputmode="email" autocomplete="email" placeholder="you@email.com" aria-label="Email address"><button id="gate-btn" type="button">Send it</button></div>'
      + '<p class="tiny" id="gate-msg" style="margin:8px 0 0"></p>'
      + '</div>';

    // paywall — only when there's a case worth appealing
    if (c.verdict === "likely_over" || c.verdict === "borderline") {
      html += ''
        + '<div class="card paywall" id="paywall">'
        + '<span class="eyebrow">The appeal packet · $39</span>'
        + '<h3>Turn this verdict into a filed appeal</h3>'
        + '<div class="price-row"><span class="price">$39</span><span class="price-note">one-time · flat fee</span></div>'
        + '<ul class="check-list">'
        + '<li>Comparable-sales analysis with your ranked comps</li>'
        + '<li>Pre-filled NYC Tax Commission complaint narrative</li>'
        + '<li>Step-by-step filing instructions + deadline calendar</li>'
        + '<li>Printable packet — ready for the portal or a hearing</li>'
        + '</ul>'
        + '<button class="btn btn-primary btn-block" id="buy-packet" type="button">Get my appeal packet — $39</button>'
        + '<p class="tiny" style="text-align:center">Secure checkout via Stripe. One-time payment, yours to keep.</p>'
        + '</div>';
    }

    $("result-view").innerHTML = html;

    // wire email gate
    var gateBtn = $("gate-btn");
    if (gateBtn) gateBtn.addEventListener("click", function(){ subscribeEmail(c.case_token); });
    var gateInput = $("gate-email");
    if (gateInput) gateInput.addEventListener("keydown", function(e){ if (e.key === "Enter") subscribeEmail(c.case_token); });

    // wire paywall
    var buyBtn = $("buy-packet");
    if (buyBtn) buyBtn.addEventListener("click", function(){ startCheckout(c); });

    var cta = $("result-cta");
    if (cta) {
      cta.innerHTML = '<button class="btn btn-primary btn-block" id="cta-packet" type="button">Get the $39 appeal packet</button>'
        + '<button class="btn btn-ghost btn-block" id="cta-new" type="button">Check another address</button>';
      var cp = $("cta-packet");
      if (cp && (c.verdict === "likely_over" || c.verdict === "borderline")) {
        cp.addEventListener("click", function(){ startCheckout(c); });
      } else if (cp) { cp.style.display = "none"; }
      $("cta-new").addEventListener("click", function(){
        history.replaceState(null, "", "/check.html");
        hide("result-view"); hide("result-cta"); show("input-view");
      });
    }
  }

  async function subscribeEmail(caseToken){
    var input = $("gate-email"), msg = $("gate-msg");
    var email = input ? input.value.trim() : "";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      if (msg) { msg.textContent = "Enter a valid email address."; msg.style.color = "#b91c1c"; }
      return;
    }
    if (msg) { msg.textContent = "Sending…"; msg.style.color = "#64748b"; }
    try {
      var resp = await fetch("/api/subscribe", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: email, case_token: caseToken })
      });
      var data = await resp.json().catch(function(){ return {}; });
      if (data.ok) {
        if (msg) { msg.textContent = "✅ Your result card is on its way — check your inbox."; msg.style.color = "#0f766e"; }
        var gate = $("email-gate"); if (gate) gate.querySelector(".inline-form").style.display = "none";
      } else {
        if (msg) { msg.textContent = data.error === "unsubscribed" ? "That address previously unsubscribed." : "Couldn't save that email — try again."; msg.style.color = "#b91c1c"; }
      }
    } catch (e) {
      if (msg) { msg.textContent = "Network hiccup — try again."; msg.style.color = "#b91c1c"; }
    }
  }

  async function startCheckout(c){
    var email = null;
    var gateInput = $("gate-email");
    if (gateInput && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(gateInput.value.trim())) {
      email = gateInput.value.trim();
    }
    if (!email) {
      email = prompt("Where should we send your packet receipt? Enter your email:");
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) { return; }
      email = email.trim();
    }
    var btn = $("buy-packet");
    if (btn) { btn.disabled = true; btn.textContent = "Opening checkout…"; }
    try {
      var resp = await fetch("https://mehyar.us/api/pay/checkout", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ product_id: "taxtrim-packet", email: email,
                               params: { case_token: c.case_token } })
      });
      var data = await resp.json().catch(function(){ return {}; });
      if (data.checkout_url) { window.location.href = data.checkout_url; return; }
      throw new Error(data.error || "checkout_failed");
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = "Get my appeal packet — $39"; }
      showError("form-error", "Checkout didn't open — please try again.");
      show("result-cta");
    }
  }

  // ---- page wiring ----
  document.addEventListener("DOMContentLoaded", function(){
    // deep link: /check.html?case=<token>
    var m = window.location.search.match(/[?&]case=([^&]+)/);
    if (m && $("result-view")) { loadCase(decodeURIComponent(m[1])); return; }

    var form = $("lookup-form");
    if (form) form.addEventListener("submit", function(e){
      e.preventDefault();
      var bbl = ($("bbl") && $("bbl").value || "").replace(/\D/g, "");
      runCheck({ address: $("address").value.trim(), borough: $("borough").value, bbl: bbl });
    });
    var bblForm = $("bbl-form");
    if (bblForm) bblForm.addEventListener("submit", function(e){
      e.preventDefault();
      var bbl = ($("bbl-manual") && $("bbl-manual").value || "").replace(/\D/g, "");
      if (bbl.length !== 10) { showError("bbl-error", "BBL must be exactly 10 digits."); return; }
      hide("bbl-view"); runCheck({ bbl: bbl });
    });
  });
})();
