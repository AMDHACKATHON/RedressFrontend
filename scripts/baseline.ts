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

export async function runBaseline(complaintDescription: string) {
  try {
    const response = await fetch(GROQ_API_URL!, {
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
      throw new Error(`Groq API error: ${response.statusText}`);
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
