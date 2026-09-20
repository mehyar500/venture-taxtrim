# TaxTrim — taxtrim.mehyar.us

"NYC says your home is worth $X. They're often wrong."

Free NYC property-tax over-assessment check (Class 1 homes): address/BBL →
DOF assessment + comparable sales → deterministic verdict. Paid $39 appeal
packet (comp analysis, pre-filled Tax Commission complaint, filing
instructions, printable PDF) and $49/yr annual renewal.

- Static PWA + Cloudflare Pages Functions (`functions/`)
- D1: `mehyar_leads_prod` (`taxtrim_*` tables; schema in build notes)
- Checkout: centralized `POST https://mehyar.us/api/pay/checkout`
- Fulfillment: `fulfillTaxtrim` in mehyar-web (`fulfillment='taxtrim'`)
- Data: NYC Open Data Socrata — assessments `8y4t-faws`, rolling sales
  `usep-8jbt`, PLUTO `64uk-42ks`, tax rates `7zb8-7bpk`
- Hard 75-day sales-freshness guard: stale feed blocks the verdict.

Build notes: `~/workspace/build/taxtrim/`
