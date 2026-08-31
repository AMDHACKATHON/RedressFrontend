import { tavily } from '@tavily/core';

const tvly = tavily({ apiKey: process.env.TAVILY_API_KEY });

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PRIORITY_KEYWORDS = [
  'complaint',
  'complaints',
  'support',
  'customer',
  'service',
  'help',
  'care',
  'feedback',
  'contact',
  'info',
];

export interface RegulatorSearch {
  snippets: string;
  candidates: {
    name: string;
    contact: string;
  }[];
}

/**
 * Searches for regulatory body information based on country and sector.
 * @param country The country to search in.
 * @param sector The industry sector (e.g., banking, telecom).
 * @returns A string containing snippets from the top search results and structured candidates.
 */
export async function searchRegulator(country: string, sector: string): Promise<RegulatorSearch> {
  try {
    const query = `"${country} ${sector} regulatory body consumer complaint contact email"`;
    const response = await tvly.search(query, {
      searchDepth: 'basic',
      maxResults: 3,
    });

    if (!response.results || response.results.length === 0) {
      return { snippets: '', candidates: [] };
    }

    const snippets = response.results
      .map((result: any) => result.content)
      .join('\n\n');

    const candidates = response.results
      .filter((r: any) => r.title && r.url)
      .map((r: any) => ({
        name: r.title,
        contact: r.url,
      }));

    return { snippets, candidates };
  } catch (error) {
    console.error('Tavily search failed:', error);
    return { snippets: '', candidates: [] };
  }
}

export interface CompanyContactSearch {
  /** Concatenated raw text from the top search results — used as grounding context for the letter prompt. */
  snippets: string;
  /**
   * Distinct email addresses extracted directly from the snippets, ordered by likely relevance
   * (customer-service / complaints / support inboxes first). Empty if nothing was found.
   */
  candidateEmails: string[];
}

async function runTavily(query: string, maxResults = 5): Promise<string> {
  try {
    const response = await tvly.search(query, { searchDepth: 'basic', maxResults });
    if (!response.results || response.results.length === 0) return '';
    return response.results.map((r: any) => `${r.url || ''}\n${r.content || ''}`).join('\n\n');
  } catch (error) {
    console.error(`Tavily query failed (${query}):`, error);
    return '';
  }
}

function extractAndRankEmails(text: string): string[] {
  if (!text) return [];
  const found = text.match(EMAIL_RE) || [];
  // Normalise + dedupe (case-insensitive)
  const seen = new Set<string>();
  const distinct: string[] = [];
  for (const raw of found) {
    const e = raw.trim().replace(/[.,;:>]+$/, '').toLowerCase();
    if (!seen.has(e)) {
      seen.add(e);
      distinct.push(e);
    }
  }
  // Filter out obvious noise (image hosts, tracking, common false-positive domains)
  const filtered = distinct.filter((e) => {
    const domain = e.split('@')[1] || '';
    if (!domain) return false;
    if (/(^|\.)example\.(com|org|net)$/.test(domain)) return false;
    if (/(^|\.)(sentry|cloudfront|amazonaws|google|gstatic|tavily)\./.test(domain)) return false;
    return true;
  });
  // Rank: emails whose local-part contains a customer-service keyword first
  filtered.sort((a, b) => {
    const aScore = scoreEmail(a);
    const bScore = scoreEmail(b);
    return bScore - aScore;
  });
  return filtered;
}

function scoreEmail(email: string): number {
  const local = (email.split('@')[0] || '').toLowerCase();
  let score = 0;
  for (const kw of PRIORITY_KEYWORDS) {
    if (local.includes(kw)) score += 5;
  }
  return score;
}

/**
 * Searches for the public customer service / complaints contact email of a company.
 * Tries multiple queries to increase the chance of finding a real, current address,
 * and returns both the raw snippets (for prompt grounding) and a vetted list of
 * email candidates extracted directly from the search results.
 */
export async function searchCompanyContact(
  company: string,
  country?: string
): Promise<CompanyContactSearch> {
  if (!company) return { snippets: '', candidateEmails: [] };

  const scope = country ? ` ${country}` : '';
  const queries = [
    `"${company}${scope}" customer service complaint contact email`,
    `"${company}" complaints support email address`,
    `"${company}${scope}" contact us email`,
  ];

  // Run queries in order; stop early once we have at least one extracted email.
  let combinedSnippets = '';
  let candidateEmails: string[] = [];
  for (const q of queries) {
    const snip = await runTavily(q, 4);
    if (!snip) continue;
    combinedSnippets = combinedSnippets ? `${combinedSnippets}\n\n${snip}` : snip;
    candidateEmails = extractAndRankEmails(combinedSnippets);
    if (candidateEmails.length > 0) break;
  }

  return { snippets: combinedSnippets, candidateEmails };
}
