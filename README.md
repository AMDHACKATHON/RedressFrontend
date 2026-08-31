# Redress — Verified Complaint Letters for Consumers

## What this is and who it's for

Redress is a Next.js app that turns a free-form consumer complaint ("my bank
charged me a wrong fee", "my internet drops out and they keep billing me")
into a formal, regulator-aware complaint letter — recipient, address, contact
email — that a consumer can copy and send. The intended user is an everyday
consumer in any country who has been wronged by a bank, telecom, retailer, or
utility and doesn't know where to escalate when customer service refuses to
help. See [micro1.md §1–2](public/docs/micro1.md) for the full problem
statement.

The interesting design decision — and the reason this project exists — is
that Redress does not just ask an LLM to name the regulator. It performs a
live Tavily web search, extracts a small set of candidate regulators from
the search results, asks the LLM to pick from that list verbatim, and then
checks the chosen name + contact against the candidates before returning it.
If the verification check fails, the regulator is replaced with `null` and the
UI shows a "we couldn't confidently verify this regulator — please review"
warning so the consumer is never misled into writing to a fabricated agency.

## What existed before this hackathon vs. what was added

**Existed before (AMD hackathon):**
- Full Next.js app, NextAuth + Google login, MongoDB models for complaints and letters.
- Multi-stage Understand / Draft / Escalate agent.
- Tavily search for company contact and for regulator snippets.
- **Verified** company-email selection with a hallucination check.
- **Unverified** regulator selection — LLM was trusted on raw Tavily prose.
- PDF letter generation.

**New for micro1:**
- Candidate extraction for regulator search results (mirrors the email pattern).
- Constrained LLM selection from regulator candidates verbatim.
- Post-hoc verification / null-fallback for the chosen regulator.
- Human-review flag in the UI (`LetterDisplay.tsx`) when the regulator comes back unverified.
- Standalone baseline script (`scripts/baseline.ts`) — single prompt, no tools.
- Evaluation harness (`scripts/eval.ts`) and a 10-case test set spanning 9 countries and 6 sectors.
- This README, [REPRODUCTION.md](REPRODUCTION.md), [eval-results.md](eval-results.md), and [TRAJECTORIES.md](TRAJECTORIES.md).

## How the verification improvement works (plain language)

When a user submits a complaint, Redress asks Tavily for the real regulator in
their country and sector — for example "Australia utility regulator complaint".
Tavily returns a list of web pages; Redress parses out the regulator names
and contact details from those pages and shows that short list to the LLM.
The LLM is **required** to pick one name and contact verbatim — or to return
`null`. After the LLM answers, Redress checks whether the chosen name and
contact appear in the candidate list. If they do, the regulator is shown to
the user as verified. If they don't — either because the LLM invented
something, or because the model failed to produce valid JSON — Redress hides
the regulator and shows an amber "we couldn't verify this — please review"
notice instead. The user gets an honest "I'm not sure" rather than a
confident wrong answer.

Evidence: [eval-results.md](eval-results.md). The changelog that traces each
iteration is in [micro1.md §6](public/docs/micro1.md).

## Solution video

The 5-minute solution video (problem → baseline → full run → comparison →
changelog highlight → one thing tried and removed) will be added via an
updated Drive link in [micro1.md §7](public/docs/micro1.md) before judging.
It has not been recorded yet due to network constraints during the
hackathon.