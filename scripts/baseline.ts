import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';

dotenv.config({ path: path.join(__dirname, '../.env.local') });
dotenv.config({ path: path.join(__dirname, '../.env') });

const GROQ_API_URL = process.env.GROQ_API_URL;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

if (!GROQ_API_URL || !GROQ_API_KEY) {
  console.error("Missing GROQ_API_URL or GROQ_API_KEY in environment variables.");
  process.exit(1);
}

const prompt = `Given this complaint description, tell me who to contact and draft a complaint letter.
Respond ONLY with a JSON object in this exact format:
{
  "letter": "full complaint letter text here",
  "recipient": "Customer Service Manager, [Organization]",
  "recipient_contact": "email address to contact",
  "regulator": {
    "name": "relevant regulator name",
    "contact": "regulator contact details"
  }
}`;

/**
 * fetch with retry/backoff for transient failures only. Mirrors the helper in
 * eval.ts (duplicated so this script stays independently runnable). Retries
 * thrown network errors and retryable HTTP statuses (429, 5xx); does NOT retry
 * deterministic 4xx such as 400 json_validate_failed.
 */
async function fetchWithRetry(
  url: string,
  init: RequestInit,
  attempts = 3,
  backoffMs = 4000
): Promise<Response> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, init);
      if ((res.status === 429 || res.status >= 500) && i < attempts - 1) {
        console.warn(`Groq HTTP ${res.status}, retrying in ${backoffMs / 1000}s (attempt ${i + 1}/${attempts})...`);
        await new Promise(r => setTimeout(r, backoffMs));
        continue;
      }
      return res;
    } catch (err) {
      lastErr = err;
      if (i < attempts - 1) {
        console.warn(`Network error (${(err as Error).message}), retrying in ${backoffMs / 1000}s (attempt ${i + 1}/${attempts})...`);
        await new Promise(r => setTimeout(r, backoffMs));
      }
    }
  }
  throw lastErr;
}

export async function runBaseline(complaintDescription: string) {
  try {
    const response = await fetchWithRetry(GROQ_API_URL!, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-20b',
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: complaintDescription }
        ],
        temperature: 0.7,
        response_format: { type: 'json_object' }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      // Groq returns HTTP 400 with code "json_validate_failed" when the model's
      // output does not conform to the requested json_object format. Report it
      // as a recoverable per-case failure instead of throwing, so an eval run
      // that calls this for every case is not aborted by a single bad case.
      if (response.status === 400 && /json_validate_failed/.test(errorText)) {
        console.warn('Groq json_validate_failed in baseline — returning empty result.');
        return {
          letter: null,
          recipient: null,
          recipient_contact: null,
          regulator: null,
          note: 'JSON validation failed'
        };
      }
      throw new Error(`Groq API error: ${response.status} ${response.statusText}\n${errorText}`);
    }

    const data = await response.json();
    const aiResponseContent = data.choices[0].message.content;
    const cleaned = aiResponseContent.replace(/^```json/, '').replace(/```$/, '').trim();
    return JSON.parse(cleaned);
  } catch (error) {
    console.error('Error running baseline:', error);
    return null;
  }
}

async function main() {
  const args = process.argv.slice(2);
  const input = args[0] || "I have been overcharged by my electricity provider, E.ON Next in the UK, for the last 3 months despite sending meter readings.";
  
  console.log(`Running baseline for complaint:\n"${input}"\n`);
  
  const result = await runBaseline(input);
  if (result) {
    console.log(JSON.stringify(result, null, 2));
  }
}

if (require.main === module) {
  main();
}
