import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { runBaseline } from './baseline';

dotenv.config({ path: path.join(__dirname, '../.env.local') });
dotenv.config({ path: path.join(__dirname, '../.env') });

const TEST_CASES = [
  // Straightforward
  {
    id: 1,
    country: "United States",
    sector: "banking",
    description: "Bank of America charged me an unexpected $35 overdraft fee even though I had overdraft protection disabled. Customer service refused to refund it."
  },
  {
    id: 2,
    country: "United Kingdom",
    sector: "telecom",
    description: "My Vodafone UK internet has been dropping out for the past 3 weeks. They keep promising to fix it but haven't, and they are still charging me full price."
  },
  {
    id: 3,
    country: "Canada",
    sector: "telecom",
    description: "Rogers added a $15 premium channel package to my bill without my consent. I called to cancel it but the charge is still there."
  },
  // Obscure / Harder
  {
    id: 4,
    country: "Nigeria",
    sector: "housing",
    description: "My landlord in Lagos is refusing to refund my security deposit after I moved out of the apartment in good condition."
  },
  {
    id: 5,
    country: "India",
    sector: "ecommerce",
    description: "I ordered a laptop on Flipkart but received a box with bricks. The seller is unresponsive and Flipkart closed my ticket."
  },
  {
    id: 6,
    country: "Australia",
    sector: "utility",
    description: "Origin Energy estimated my meter reading and overcharged me by $800. I sent a photo of the actual meter but they are threatening disconnection."
  },
  {
    id: 7,
    country: "South Africa",
    sector: "telecom",
    description: "MTN South Africa keeps deducting airtime from my prepaid balance for a subscription service I never opted into."
  },
  {
    id: 8,
    country: "Ireland",
    sector: "banking",
    description: "AIB blocked my debit card while I was traveling despite me notifying them in advance. I was stranded without funds for 3 days."
  },
  {
    id: 9,
    country: "Singapore",
    sector: "housing",
    description: "The managing agent of my condo is arbitrarily increasing the maintenance fee by 50% without a proper general meeting vote."
  },
  {
    id: 10,
    country: "New Zealand",
    sector: "government",
    description: "Inland Revenue Department miscalculated my tax return and is now demanding a penalty for their own error."
  }
];

const GROQ_API_URL = process.env.GROQ_API_URL;
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// Mock the internal search functionality for the eval script
import { searchRegulator, searchCompanyContact } from '../lib/search';

async function runVerifiedRedress(complaint: any) {
  try {
    const { country, sector, description } = complaint;
    
    // We mock the extraction step here since we already have country and sector
    const regulator = await searchRegulator(country, sector);
    
    // Use the exact prompt format as in route.ts
    const systemPrompt = `You are a professional legal letter writer. Based on the complaint provided, write a formal complaint letter.

Format the letter using standard complaint structure.

Also identify:
- The recipient title and organization
- The relevant regulatory body for this type of complaint and country, including their contact details

${regulator.snippets ? `Additional regulatory information from web search:
${regulator.snippets}

Use this information to ensure the regulator name, contact details, and filing channel are accurate.

${regulator.candidates.length > 0 ? `Verified regulator candidates extracted from live web search results:
${regulator.candidates.map((c, i) => `${i + 1}. Name: "${c.name}", Contact: "${c.contact}"`).join('\n')}

Choose ONE of the regulator candidates above. Use the exact name and contact verbatim.` : `No structured regulator candidates were found.`}` : ''}

Respond ONLY with a valid JSON object in this exact format and nothing else:
{
  "letter": "full letter text here",
  "regulator": {
    "name": ${regulator.candidates.length > 0 ? `"<one of the candidate names listed above, verbatim — or null>"` : `null`},
    "contact": ${regulator.candidates.length > 0 ? `"<the corresponding candidate contact, verbatim — or null>"` : `null`}
  }
}

STRICT RULE FOR "regulator":
- If regulator candidates are provided, the "name" and "contact" MUST exactly match one of the candidates, or be null.
- NEVER invent a regulator that is not in the candidate list.`;

    const response = await fetch(GROQ_API_URL!, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'openai/gpt-oss-20b',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: description }
        ],
        temperature: 0.7,
        response_format: { type: 'json_object' }
      })
    });

    if (!response.ok) throw new Error(`Groq API error: ${response.statusText}`);
    
    const data = await response.json();
    const aiResponseContent = data.choices[0].message.content;
    const cleaned = aiResponseContent.replace(/^```json/, '').replace(/```$/, '').trim();
    const parsedLetter = JSON.parse(cleaned);

    let regulatorName = parsedLetter.regulator?.name || null;
    let regulatorContact = parsedLetter.regulator?.contact || null;
    let regulatorVerified = true;

    if (regulator.candidates.length > 0) {
      const isVerified = regulator.candidates.some(c => 
        c.name === regulatorName && c.contact === regulatorContact
      );
      if (!isVerified) {
        regulatorName = null;
        regulatorContact = null;
        regulatorVerified = false;
      }
    } else {
      regulatorName = null;
      regulatorContact = null;
      regulatorVerified = false;
    }

    return {
      regulatorName,
      regulatorContact,
      regulatorVerified,
      candidatesCount: regulator.candidates.length
    };
  } catch (error) {
    console.error('Error running verified redress:', error);
    return null;
  }
}

async function main() {
  console.log("Starting Evaluation Harness...");
  console.log("=========================================\n");

  for (const tc of TEST_CASES) {
    console.log(\`Evaluating Case \${tc.id}: \${tc.country} / \${tc.sector}\`);
    console.log(\`Description: \${tc.description}\`);
    
    console.log("\\n-- Running Baseline --");
    const baselineResult = await runBaseline(tc.description);
    if (baselineResult) {
      console.log(\`   Baseline Regulator: \${baselineResult.regulator?.name || 'N/A'}\`);
      console.log(\`   Baseline Contact:   \${baselineResult.regulator?.contact || 'N/A'}\`);
    }

    console.log("\\n-- Running Verified Redress --");
    const redressResult = await runVerifiedRedress(tc);
    if (redressResult) {
      console.log(\`   Candidates Found:   \${redressResult.candidatesCount}\`);
      console.log(\`   Redress Regulator:  \${redressResult.regulatorName || 'NULL (Unverified)'}\`);
      console.log(\`   Redress Contact:    \${redressResult.regulatorContact || 'NULL (Unverified)'}\`);
      console.log(\`   Is Verified?:       \${redressResult.regulatorVerified}\`);
    }
    console.log("\\n-----------------------------------------\\n");
  }
  
  console.log("Evaluation complete.");
}

if (require.main === module) {
  main();
}
