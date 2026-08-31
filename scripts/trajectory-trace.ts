import * as fs from 'fs';
import * as path from 'path';
import dotenv from 'dotenv';
import { runBaseline } from './baseline';

dotenv.config({ path: path.join(__dirname, '../.env.local') });
dotenv.config({ path: path.join(__dirname, '../.env') });

import { searchRegulator } from '../lib/search';

const SUBSET = [
  {
    id: 3,
    country: 'Canada',
    sector: 'telecom',
    description: "Rogers added a $15 premium channel package to my bill without my consent. I called to cancel it but the charge is still there."
  },
  {
    id: 6,
    country: 'Australia',
    sector: 'utility',
    description: "Origin Energy estimated my meter reading and overcharged me by $800. I sent a photo of the actual meter but they are threatening disconnection."
  },
  {
    id: 10,
    country: 'New Zealand',
    sector: 'government',
    description: "Inland Revenue Department miscalculated my tax return and is now demanding a penalty for their own error."
  }
];

async function main() {
  for (const tc of SUBSET) {
    console.log(`\n===== CASE ${tc.id}: ${tc.country} / ${tc.sector} =====`);
    console.log(`Description: ${tc.description}\n`);

    console.log('--- TAVILY SEARCH (searchRegulator) ---');
    const reg = await searchRegulator(tc.country, tc.sector);
    console.log(`snippets_length: ${reg.snippets ? reg.snippets.length : 0} chars`);
    if (reg.snippets) {
      console.log(`snippets_head: ${reg.snippets.slice(0, 600).replace(/\n/g, ' ')}`);
    }
    console.log(`candidate_count: ${reg.candidates.length}`);
    reg.candidates.forEach((c, i) => console.log(`candidate[${i}]: name="${c.name}" contact="${c.contact}"`));

    console.log('\n--- BASELINE CALL ---');
    const base = await runBaseline(tc.description);
    console.log(`baseline_regulator: ${base?.regulator?.name || 'N/A'}`);
    console.log(`baseline_contact:   ${base?.regulator?.contact || 'N/A'}`);
    if (base?.note) console.log(`baseline_note:      ${base.note}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });