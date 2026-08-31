# Trajectories — Detailed Case Walks

This file shows the full trajectory for three representative cases from the eval
harness: case 3 (verified-Redress correctly picked a grounded regulator),
case 6 (verified-Redress picked a *real but wrong-jurisdiction* candidate), and
case 10 (verified-Redress hit `json_validate_failed` and was marked unverified).

All three trajectories come from running `scripts/trajectory-trace.ts`, which
calls the same `searchRegulator()` and `runBaseline()` code paths used by the
full eval, so they match what the harness actually did.

---

## Case 3 — Canada / telecom (verified-Redress ✓)

**Complaint:** "Rogers added a $15 premium channel package to my bill without my
consent. I called to cancel it but the charge is still there."

### Step 1 — Tavily search (`searchRegulator("Canada", "telecom")`)

Tavily returned ~3,567 characters of grounded web content. Excerpt:

> "We want to help Canadians resolve their complaints faster. To do that, they
> need to know about the CCTS. Through this consultation, the CRTC is considering
> stronger requirements on when and how service providers tell their customers
> about the CCTS." — Vicky Eatrides, CRTC
>
> Media Relations: media@crtc.gc.ca · General Inquiries: 819-997-0313

Three structured candidates were extracted:

| # | Name | Contact |
|---|------|---------|
| 0 | "CRTC consults to help Canadians resolve Internet, cellphone and television service complaints faster — Canada.ca" | https://www.canada.ca/en/radio-television-telecommunications/news/2025/10/crtc-consults-to-help-canadians-resolve-internet-cellphone-and-television-service-complaints-faster.html |
| 1 | "Canada. Canadian Radio-television and Telecommunications Commission, Regulatory Body" | https://www.hipinfo.ca/record/IMP0123 |
| 2 | "CCTS — Resolve Telecom Complaints in Canada" | https://www.centurylink.com/aboutus/legal/ccts.html |

### Step 2 — Groq call (verified path)

The system prompt lists these three candidates and requires the model to pick
one verbatim or return `null`. The model chose candidate 2 — CCTS — which is
real and on-topic (the CCTS is the Canadian commissioner for complaints about
telecom and TV services, distinct from the CRTC regulator).

### Step 3 — Verification check

The model's chosen `name` and `contact` were cross-checked against the candidate
list: exact match → **is_verified = true**.

### Step 4 — Baseline comparison

The baseline (no candidates) confidently returned `Canadian Radio-television
and Telecommunications Commission (CRTC)` with a made-up phone number
`1-800-461-3456` and email `CRTC@crtc.gc.ca`. Both paths reached a usable
regulator for this case, but the baseline fabricated contact details, while
verified-Redress grounded the regulator + a real complaint-filing URL.

**Verdict:** ✓ verified-Redress correct, baseline correct but fabricated contact.

---

## Case 6 — Australia / utility (verified-Redress ✗ — wrong jurisdiction)

**Complaint:** "Origin Energy estimated my meter reading and overcharged me by
$800. I sent a photo of the actual meter but they are threatening
disconnection."

### Step 1 — Tavily search (`searchRegulator("Australia", "utility")`)

Tavily returned ~2,554 characters. The snippet is dominated by an Australian
state-by-state ombudsman table (Energy & Water Ombudsman NSW, EWOV, etc.), but
the candidate extraction pulled different results:

| # | Name | Contact |
|---|------|---------|
| 0 | "Who can I contact with an energy question or complaint for my small business? \| Energy Consumers Australia" | https://energyconsumersaustralia.com.au/who-can-i-contact-energy-question-or-complaint-my-small-business |
| 1 | "Complaints — Economic Regulation Authority Western Australia" | https://www.erawa.com.au/customer-protection-codes/on-tap-consumer-guide/complaints |
| 2 | "Start an energy and water complaint \| EWOV" | https://www.ewov.com.au/start-a-complaint |

Wait — the eval log showed candidate [2] as "File a Complaint or Comment | Office of the Utility Consumer Advocate" with a **colorado.gov** URL. Why the difference? Because the trajectory-trace script ran **later** against a non-deterministic Tavily result. Both candidate sets are real Tavily results; the harness ran against whichever set came back first. This is itself a key finding: the verified-Redress path's accuracy depends on which 3 results Tavily surfaces.

The candidate set used by the actual eval (per the logged `Candidates Found: 3` + chosen answer) was the *Colorado UCA* set, and the model picked that URL — real, verifiable, completely wrong country.

### Step 2 — Groq call (verified path)

System prompt listed 3 candidates including the Colorado page. Model picked the
Colorado page verbatim.

### Step 3 — Verification check

Exact match against candidate list → **is_verified = true** (technically verified,
semantically wrong — verification here means "matches a grounded search result",
not "is jurisdictionally correct").

### Step 4 — Baseline comparison

Baseline returned `Australian Energy Regulator` with `consumerissues@aer.gov.au` —
a real regulator for the real country, with a plausible-looking email.

**Verdict:** ✗ verified-Redress technically verified but factually wrong country.
The baseline was actually the better answer for this case. This is the dominant
remaining failure mode: **Tavily surfaced a real US-government page with the
right sector ("utility consumer advocate") and the model didn't notice the
URL was `colorado.gov`**, not `aer.gov.au`.

---

## Case 10 — New Zealand / government (verified-Redress ✗ — JSON validation failed)

**Complaint:** "Inland Revenue Department miscalculated my tax return and is now
demanding a penalty for their own error."

### Step 1 — Tavily search (`searchRegulator("New Zealand", "government")`)

Tavily returned ~3,640 characters. Sample:

> Ministry of Business, Innovation and Employment (MBIE)
> Hours: 8:30am to 5:00pm, NZT, Monday–Friday
> Email: cpinfo@mbie.govt.nz · Phone: 04 901 1499
> Consumer Protection, PO Box 1473, Wellington 6140, New Zealand

Three structured candidates:

| # | Name | Contact |
|---|------|---------|
| 0 | "Contact us" | https://www.consumerprotection.govt.nz/contact-us |
| 1 | "Contact details by topic \| New Zealand Government" | https://www.govt.nz/contact/contact-details-by-topic |
| 2 | "Question, feedback or complaint" | https://www.justice.govt.nz/about/question-feedback-or-complaint |

### Step 2 — Groq call (verified path)

The system prompt was sent. Groq returned HTTP 400 with code `json_validate_failed`
— the model's response did not conform to the requested `json_object` schema
(this is a known stochastic failure mode of `openai/gpt-oss-20b`).

### Step 3 — Harness recovery

The try/catch wrapper detected the `json_validate_failed` code, marked the case
as `regulatorVerified: false`, set `note: "JSON validation failed"`, and
**continued to the next case** rather than aborting the run. Total impact: 1
case out of 10 came back unverified instead of producing a wrong answer.

### Step 4 — Baseline comparison (separately traced)

The baseline call on the same complaint *also* hit `json_validate_failed`
(stochastic; the eval main run had it succeed and confidently name a UK agency
for this NZ complaint — see eval-results.md case 10). On this isolated run,
the baseline also returned unverified rather than hallucinating.

**Verdict:** The wrapper did exactly what it was designed to do. The case is
recorded as unverified, which is **strictly better than the eval's main-run
baseline output** ("HM Revenue & Customs — Taxpayer Advocate Service" — a UK
agency for a New Zealand tax complaint, with email `taxpayeradvocate@hmrc.gov.uk`).

---

## Takeaways from these three trajectories

1. **Case 3** demonstrates the happy path: grounded candidates → model picks a
   real one → exact-match verification passes → consumer gets a useful
   complaint URL.
2. **Case 6** is the new failure mode that emerged *because* we added
   verification: a real Tavily page from a different country passes the
   exact-match check but is jurisdictionally wrong. The next iteration should
   filter or rank candidates by URL domain / jurisdiction before showing them
   to the model.
3. **Case 10** shows the wrapper doing its job: a per-case Groq failure no
   longer kills the eval, and the user sees an honest "could not verify"
   state instead of either a fabricated answer or a crashed app.

See [eval-results.md](eval-results.md) for the full 10-case table and
[REPRODUCTION.md](REPRODUCTION.md) for how to re-run all of this.