# Reproduction Guide

A step-by-step recipe to take this repo from a clean clone to a working
Redress instance + a working baseline + a working eval, on Windows / macOS /
Linux. Tested with Node 20+ (this checkout was developed on Node 26).

## 1. Clone and install

```bash
git clone <your-fork-url> redress
cd redress
npm install
```

`npm install` installs Next.js, TypeScript, the `@tavily/core` search client,
the `groq-sdk`-equivalent `openai`-compat HTTP fetch we use directly, and
dev tools including `tsx` (via `npx`).

## 2. Environment variables

Create a file named `.env` in the repo root with the following keys. The
code reads these exact names — see the **API keys** section in the README
if you're unsure where to obtain any of them.

```env
# AI & Search APIs (required for the letter generator and the eval)
GROQ_API_URL=https://api.groq.com/openai/v1/chat/completions
GROQ_API_KEY=gsk_...

# Required for regulator + email search
TAVILY_API_KEY=tvly-...

# Database (required to persist complaints and letters)
MONGODB_URI=mongodb+srv://<user>:<pass>@<cluster>.mongodb.net/redress

# Authentication (NextAuth + Google) — required for the sign-in flow
NEXTAUTH_SECRET=<any random 32+ char string>
NEXTAUTH_URL=http://localhost:3000
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
```

| Key | Required for | Where to get it |
|-----|--------------|-----------------|
| `GROQ_API_URL` | Letter generation, baseline, eval | Groq console — OpenAI-compatible chat completions endpoint |
| `GROQ_API_KEY` | Letter generation, baseline, eval | Groq console — API keys section |
| `TAVILY_API_KEY` | Regulator + email search (production letter flow + eval) | tavily.com — free tier is enough |
| `MONGODB_URI` | Persisting complaints & letters | Atlas or any MongoDB instance |
| `NEXTAUTH_SECRET` | Signing NextAuth JWTs | `openssl rand -base64 32` |
| `NEXTAUTH_URL` | NextAuth callback URL | `http://localhost:3000` for dev |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | "Sign in with Google" | Google Cloud Console → OAuth client |

`dotenv` loads `.env.local` first then `.env`, so you can keep a `.env` with
non-secret defaults and a `.env.local` with real keys.

## 3. Run the app

```bash
npm run dev
```

You should see `Local: http://localhost:3000`. Open it in a browser.

**A working page load looks like this:**
- `/` shows the landing page with a "Get started" / "Sign in" button.
- After signing in with Google, you can submit a complaint description.
- The app will (1) extract country + sector from your text, (2) search Tavily
  for the company and the regulator, (3) generate the letter via Groq, (4)
  verify the regulator candidate matched Tavily output, and (5) show the
  letter with a "verified" or "couldn't verify" badge next to the regulator
  name.

If `TAVILY_API_KEY` is missing, regulator and email lookup silently return
empty and the app falls back to an unverified letter — the page will still
load but with the unverified warning.

## 4. Run the baseline (single prompt, no tools)

```bash
npx tsx scripts/baseline.ts "Your bank charged you a $35 fee without authorization"
```

**Expected output:** a JSON object printed to stdout with `letter`,
`recipient`, `recipient_contact`, and `regulator: { name, contact }`. The
baseline deliberately has no search and no candidate constraint — its
hallucinations are the baseline failure mode that the verified path is
designed to prevent. Try several complaints from different countries and
notice that the baseline confidently names regulators for jurisdictions it
has no information about (e.g. it will name a UK agency for a Singapore
complaint). Example: see [TRAJECTORIES.md case 10](TRAJECTORIES.md), where
the baseline confidently named `HMRC` for a New Zealand tax complaint.

## 5. Run the eval

```bash
npx tsx scripts/eval.ts
```

**Expected output:** 10 cases logged one at a time, each printing:

- Case header (`Country / sector` + description)
- Baseline block (`-- Running Baseline --` then `Baseline Regulator` + `Baseline Contact`)
- Verified-Redress block (`-- Running Verified Redress --` then `Candidates Found`, `Redress Regulator`, `Redress Contact`, `Is Verified?`, and an optional `Redress Note` if JSON validation failed)
- Separator line

Then `Evaluation complete.` and exit code 0. Full results and per-case notes
are in [eval-results.md](eval-results.md). Trajectory detail for cases 3, 6,
and 10 is in [TRAJECTORIES.md](TRAJECTORIES.md).

**Approximate runtime:** ~5 minutes with the 25-second inter-case delay that
keeps the run under the Groq 8000 TPM cap.

**Approximate cost:** $0 on free tiers. Each case uses ~2,000–3,500 Groq
tokens (well under Groq's free daily quota), and Tavily free tier allows 1,000
searches/month — the eval uses 10 calls to `searchRegulator` per run
(one per case) plus 10 from the production letter flow's email path, so a
single eval run costs ~20 Tavily calls.

## 6. Optional: re-run with the trajectory tracer

```bash
npx tsx scripts/trajectory-trace.ts
```

This prints, for cases 3, 6, and 10, the full Tavily snippet, the 3 extracted
candidates, and the baseline answer for each. Useful if you want to see what
the LLM was actually given to pick from. Output goes to stdout.

## 7. Build for production

```bash
npm run build
```

Expected: Next.js builds successfully with no type errors. The build
verifies all routes including the verified-regulator path at
`app/api/complaints/[id]/letter/route.ts`. If you see type errors, check that
your `.env` keys are present — some types depend on `process.env` being
declared.

## Troubleshooting

- **`TAVILY_API_KEY` not picked up**: confirm `.env` is at the repo root (not
  in `scripts/`). `lib/search.ts` reads it at module-load time.
- **`Groq 429 / rate limit`**: the eval already spaces cases 25s apart and
  retries transient 429s via `fetchWithRetry`. If you hit this in the dev app,
  wait a minute and retry — your Groq key's per-minute TPM quota is the cap.
- **MongoDB connection error**: verify `MONGODB_URI` and that your IP is
  allow-listed on Atlas. The app will load even if Mongo is down; only letter
  persistence will fail.
- **`json_validate_failed` in the eval log**: the model failed to produce
  valid JSON for that case. The eval marks the case `unverified` and
  continues — that is by design, not a bug. See
  [micro1.md §6](public/docs/micro1.md#6-changelog-to-fill-in-as-work-happens)
  for the rationale.