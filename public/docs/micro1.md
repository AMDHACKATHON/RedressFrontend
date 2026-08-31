# Redress — micro1 Frontier Engineering Challenge Submission Plan

## Status
- Base project: Redress (AI complaint resolution agent), originally built for the
  AMD Developer Hackathon 2026 (lablab.ai). That project is complete and submitted
  elsewhere. This document scopes the **new, additional work** being built specifically
  for the micro1 Frontier Engineering Challenge (Aug 28–31, 2026), per micro1 ground rule:
  "Make it clear what existed before the competition and what you added."
- Repo: https://github.com/AMDHACKATHON/Redress
- Live app: https://redressamd.vercel.app

---

## 1. Who has this problem?

People with a legitimate complaint against a bank, telco, utility, landlord, or
government agency often don't know how to escalate formally, don't know which
regulatory body has jurisdiction, or send an ineffective email and give up.

## 2. What bottleneck makes it worth solving?

Redress already drafts complaint letters and looks up the right company contact
and regulator using live web search (Tavily). But there's an asymmetry in the
existing implementation:

- **Company contact lookup is verified.** Candidate emails are extracted
  programmatically via regex from search results. The LLM must pick from that
  candidate list. The code checks the LLM's choice against the candidate list —
  if it picked something not in the list (hallucinated), the system nulls it out
  instead of presenting a fabricated email.
- **Regulator lookup is NOT verified.** Raw search snippets are handed to the LLM,
  which is trusted to correctly name the regulator, its contact info, and the
  filing process. There is no candidate-list extraction and no check that the
  LLM's answer is grounded in the actual search results. If Tavily returns weak
  or irrelevant results, the LLM is likely to fall back on pretrained knowledge
  or hallucinate a regulator name/contact outright.

This matters more than the email gap: sending a formal complaint to the wrong or
a fabricated regulator is a worse failure than a missing email contact — it wastes
the user's time, may mislead them about their legal options, and could damage the
credibility of the complaint if it's later escalated further.

## 3. The improvement (what's being added for micro1)

Mirror the existing, working company-email verification pattern onto the
regulator lookup path:

1. **Programmatic candidate extraction** — parse Tavily's regulator search
   results into a structured candidate list (regulator name + contact/URL),
   instead of handing raw snippets straight to the LLM.
2. **Constrained selection** — prompt the LLM to pick from the candidate list
   only, same pattern as `searchCompanyContact`.
3. **Post-hoc verification** — programmatically check the LLM's chosen regulator
   against the candidate list. If it doesn't match (hallucinated / not grounded),
   set `regulator` to `null` instead of presenting unverified info.
4. **Human-in-the-loop flag** — when regulator is null/unverified, surface a
   clear "we couldn't confidently verify the regulator for your case — please
   review before sending" flag in the UI, rather than silently degrading. This
   satisfies the ground rule: "Make a qualified human reviewer part of any
   solution that could significantly affect someone."

This is a scoped, mirrored change — not a rebuild. It reuses the exact
verification pattern that already exists and works for company emails.

## 4. Baseline (for comparison)

A minimal single-prompt baseline, built separately from Redress (no code shared):
- Given a complaint description, ask an LLM directly: "who should this person
  contact, and draft a complaint letter."
- No web search, no verification, no candidate extraction, no clarifying
  questions, no stage machine.
- Represents "what a basic prompt gets you today" — the PDF's suggested baseline
  type ("one direct prompt with basic instructions").

## 5. Evaluation plan

- **Test set**: 10 complaint scenarios spanning multiple countries and sectors
  (banking, telecom, utility, housing, government), including:
  - A few straightforward cases (well-known company/regulator, should resolve cleanly)
  - At least 1–2 cases where the correct regulator is obscure or where search
    results are likely to be thin/ambiguous, to specifically probe hallucination
- **Method**: Run the same 10 cases through (a) the baseline, (b) pre-fix Redress
  (regulator lookup unverified), (c) post-fix Redress (regulator lookup verified).
- **Primary metric**: Regulator correctness — does the named regulator actually
  have jurisdiction for that country+sector? (Scored manually against known
  correct answers.)
- **Secondary metric**: Hallucination rate — how often is a regulator presented
  with no grounding in actual search results, vs. correctly flagged as
  unverified.
- **Human-reviewer signal**: Does the system correctly flag the ambiguous cases
  for human review instead of confidently presenting a wrong answer?

## 6. Changelog (to fill in as work happens)

| Stage | What was tried and why | Evidence | Decision/Learning |
|---|---|---|---|
| Baseline | Single direct prompt, no tools, no search, no candidate constraints | 10 cases in `eval-results.md`. Baseline confidently named a UK agency (`HMRC` / `taxpayeradvocate@hmrc.gov.uk`) for a NZ tax complaint (case 10), an invented Singapore body (`State Department of Housing and Community Development`, `complaints@housingstate.gov`) for a Singapore housing complaint (case 9), and a fabricated consumer email (`customerservice@[bankname].com`) on a no-country smoke test. Across all 10 cases, baseline produced at least 1 outright jurisdictional hallucination and several unverifiable contact emails. | Starting point. Confirms the gap: a single-prompt LLM hallucinates regulators and contact details with high confidence. |
| Existing (pre-micro1) | Redress as built for AMD hackathon — multi-stage agent, verified company email, unverified regulator | Pre-micro1 regulator selection was the email selection pattern but *without* candidate extraction or a null-fallback — the LLM received Tavily snippets and was trusted to name the regulator from prose alone. Same evaluation set, run via the unmodified Redress code path: same hallucinated agencies as baseline in cases 9 and 10. | Identified the gap being solved: regulator selection needs the same "grounded candidates + constrained pick + post-hoc verification" treatment as email. |
| Iteration 1 | Added candidate extraction + constrained selection + null-fallback for regulator lookup, mirroring the email pattern. Implemented in `app/api/complaints/[id]/letter/route.ts` against the same `searchRegulator` output that the email path already used. | Cases 3, 5, 7, 8, 9 all returned real, jurisdictionally-correct regulators. Case 9 went from a fabricated Singapore body to the real **Council for Estate Agencies** — a clear win. | Kept. The pattern works whenever Tavily surfaces the right jurisdiction in its top results. |
| Eval infra | Built `scripts/eval.ts` and `scripts/baseline.ts`, 10-case test set spanning US/UK/Canada/Nigeria/India/Australia/South Africa/Ireland/Singapore/New Zealand. First eval runs hit two failure modes that the harness didn't yet handle: (a) Groq 429s because the 4s inter-case delay wasn't enough, and (b) `json_validate_failed` 400s from the model that aborted the whole run. | Patched: delay raised to **25s** to stay under the Groq 8000 TPM cap (~2000–3500 tokens per case across baseline + verified). Added a `fetchWithRetry` wrapper for transient 429/5xx/DNS errors and a targeted try/catch in `runVerifiedRedress` / `runBaseline` that detects `json_validate_failed` and marks the case `unverified` instead of throwing. | Kept. Both fixes are infra-only and leave the core verified-feature logic untouched. |
| Final | Verified-Redress with the same constraint+null-fallback pattern as the email path, plus the human-review flag in `LetterDisplay.tsx` for cases that come back unverified. | Full 10-case run completed in ~5 min; **8/10 verified, 2/10 unverified** (cases 1 and 10 — both `json_validate_failed`). Verified-Redress picked a real, jurisdictionally correct regulator in **5/10** cases (3, 5, 7, 8, 9). Baseline fabricated or wrong-country in **at least 2/10** cases (9, 10). 3 verified-Redress picks (cases 2, 4, 6) were *real* but wrong-sector or wrong-country — the dominant residual failure mode. | Main contribution: the same grounding + exact-match verification that prevents email hallucinations prevents the worst regulator hallucinations (e.g. case 9), but **it does not guarantee jurisdictional correctness** — the next iteration needs domain filtering on Tavily candidates before they reach the LLM. |

**Honest failures (per ground rule):**

1. Cases 1 and 10 came back unverified rather than producing a regulator answer. Both were `json_validate_failed` from the model — the wrapper caught them instead of crashing, which is the right behavior, but the user still gets "couldn't verify" for a real consumer need. Mitigation: retry once with a relaxed prompt before marking unverified.
2. 3/10 verified-Redress picks were real-but-wrong (cases 2, 4, 6). These are the hardest failure mode: the verification pass *succeeds* against a Tavily result that is grounded but off-topic. Requires a domain/jurisdiction filter pre-LLM, not just post-hoc verification.
3. The 25s inter-case delay means the eval takes ~5 minutes. We considered batching cases, but Groq's 8000 TPM cap is per-minute and each case already uses ~2–3.5k tokens, so a tighter loop risks 429s that the retry wrapper can paper over but that cost real minutes.
4. Network in this environment is flaky (intermittent `EAI_AGAIN` to `api.groq.com`). `fetchWithRetry` masks individual blips but a sustained outage would still fail a case.

## 7. Deliverables checklist (per micro1 requirements)

- [ ] Complete solution code (this repo + changes) + README explaining user/bottleneck
- [ ] Improvement Changelog (table above, filled in with real evidence)
- [ ] Reproduction guide — clean-env setup, exact commands for baseline/solution/eval,
      required data, expected output, versions, approx runtime/cost
- [ ] Solution video (≤5 min) — problem + baseline → full run → comparison →
      changelog highlight → one thing that was tried and removed
- [ ] Agent trajectories — representative logs from the regulator-lookup agent
      call showing: candidate extraction → LLM selection → verification check →
      pass/fail outcome, for at least a verified case and a flagged/null case
- [ ] Hot take — the failure mode observed (regulator hallucination without
      grounding) and the practical lesson for building more reliable agents

## 8. What existed before vs. what's new (for the README, per ground rule #02)

**Existed before (AMD hackathon):**
- Full Next.js app, auth, MongoDB models, multi-stage agent (Understand/Draft/Escalate)
- Tavily search integration for both company contact and regulator
- Verified company-email selection with hallucination check
- Unverified regulator selection (trusts LLM on raw snippets)
- PDF letter generation

**New for micro1:**
- Candidate extraction for regulator search results
- Constrained LLM selection from regulator candidates
- Post-hoc verification / null-fallback for regulator (mirroring email pattern)
- Human-review flag in UI when regulator is unverified
- Standalone baseline script (single-prompt, no tools)
- Evaluation harness + 10-case test set + scoring
- This changelog and reproduction guide
