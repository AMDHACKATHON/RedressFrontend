import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import Complaint from '@/lib/models/Complaint';
import Message from '@/lib/models/Message';
import Letter from '@/lib/models/Letter';
import User from '@/lib/models/User';
import { searchRegulator, searchCompanyContact } from '@/lib/search';
import { applySenderName } from '@/lib/letter-utils';

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userSession = await getSessionUser(req);
    if (!userSession) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    await connectDB();

    const complaint = await Complaint.findById(id);
    if (!complaint) {
      return NextResponse.json({ error: 'Complaint not found' }, { status: 404 });
    }

    if (complaint.userId.toString() !== userSession.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const letter = await Letter.findOne({ complaintId: id });
    if (!letter) {
      return NextResponse.json({ error: 'Letter not found' }, { status: 404 });
    }

    return NextResponse.json(letter);
  } catch (error: any) {
    console.error('Error fetching letter:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const userSession = await getSessionUser(req);
    if (!userSession) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;
    await connectDB();

    const complaint = await Complaint.findById(id);
    if (!complaint) {
      return NextResponse.json({ error: 'Complaint not found' }, { status: 404 });
    }

    // Verify ownership
    if (complaint.userId.toString() !== userSession.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Check stage
    if (complaint.stage !== 'draft') {
      return NextResponse.json({ error: 'Not ready for letter generation.', code: 409 }, { status: 409 });
    }

    // Check if exists
    const existingLetter = await Letter.findOne({ complaintId: id });
    if (existingLetter) {
      return NextResponse.json(existingLetter);
    }

    // Fetch message history for context
    const messages = await Message.find({ complaintId: id }).sort({ createdAt: 1 });
    const messageContext = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');

    // Extract country, sector, and company; then search the web in parallel for
    // (a) the relevant regulatory body and (b) the company's public complaint email.
    let searchResults = '';
    let regulatorCandidates: { name: string, contact: string }[] = [];
    let companyContactSnippets = '';
    let candidateEmails: string[] = [];
    try {
      const extractionPrompt = `Based on this complaint conversation, extract three fields and respond ONLY with valid JSON, nothing else:
{
  "country": "the country this complaint is about",
  "sector": "one of: banking, telecom, utility, housing, government, ecommerce, other",
  "company": "the exact name of the organization being complained about"
}`;

      const extractionResponse = await fetch(process.env.GROQ_API_URL!, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'openai/gpt-oss-20b',
          messages: [
            { role: 'system', content: extractionPrompt },
            { role: 'user', content: messageContext }
          ],
          temperature: 0,
          response_format: { type: 'json_object' }
        })
      });

      if (extractionResponse.ok) {
        const extractionData = await extractionResponse.json();
        const extracted = JSON.parse(
          extractionData.choices[0].message.content.trim().replace(/^```json/, '').replace(/```$/, '')
        );
        const [regulator, companyContact] = await Promise.all([
          extracted.country && extracted.sector
            ? searchRegulator(extracted.country, extracted.sector)
            : Promise.resolve({ snippets: '', candidates: [] }),
          extracted.company
            ? searchCompanyContact(extracted.company, extracted.country)
            : Promise.resolve({ snippets: '', candidateEmails: [] as string[] }),
        ]);
        searchResults = regulator.snippets;
        regulatorCandidates = regulator.candidates;
        companyContactSnippets = companyContact.snippets;
        candidateEmails = companyContact.candidateEmails;
      }
    } catch (e) {
      console.error('Extraction/Search failed, proceeding without it:', e);
    }

    const senderUser = await User.findById(userSession.id).select('name address state country');
    const senderName = (senderUser?.name || userSession.name || '').trim();
    const senderAddress = (senderUser?.address || '').trim();
    const senderState = (senderUser?.state || '').trim();
    const senderCountry = (senderUser?.country || '').trim();
    const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    const senderInfoLines: string[] = [];
    if (senderName) senderInfoLines.push(`- name = ${senderName}`);
    if (senderAddress) senderInfoLines.push(`- address = ${senderAddress}`);
    if (senderState) senderInfoLines.push(`- state/region = ${senderState}`);
    if (senderCountry) senderInfoLines.push(`- country = ${senderCountry}`);
    const senderInfoBlock = senderInfoLines.length
      ? senderInfoLines.join('\n')
      : '- (no sender info on file — extract any sender address mentioned in the conversation; otherwise use only the name from the conversation)';

    let systemPrompt = `You are a professional legal letter writer. Based on the complaint conversation provided, write a formal complaint letter.

SENDER INFO (use these exact values, do not paraphrase):
${senderInfoBlock}

Format the letter using this EXACT structure, with one blank line between each section:

Section 1 — Sender address block at the top-left. REQUIRED. Render the sender info as separate lines, using ONLY the values that are provided:
   - Line 1: the sender's name
   - Line 2 (only if address provided): the sender's address
   - Line 3 (only if state/region provided AND not already present in the address line): the sender's state/region
   - Line 4 (only if country provided AND not already present in the address or state line): the sender's country
   Skip any line whose value isn't provided. Never duplicate the same place name across two lines (e.g. if the address line ends with "Lagos, Nigeria", omit the standalone state and country lines).

Section 2 — The current date on its own line: ${today}
   Render the date itself only. DO NOT prefix it with "DATE:", "Date:", or any other label.

Section 3 — Recipient block:
   - Line 1: title and organization (e.g. "Customer Service Manager, Acme Corp.")
   - Line 2 (only if commonly known): organization HQ city, country
   - Do NOT invent a fake street address or postal code.

Section 4 — Salutation (e.g. "Dear Customer Service Manager,")

Section 5 — Body paragraphs:
   - Clear description of the issue
   - Resolution requested
   - 14-day response deadline

Section 6 — Closing ("Sincerely," or "Yours faithfully,") on its own line, followed on a new line by the actual sender name${senderName ? `: ${senderName}` : ''}.

Critical rules:
- Use \\n for line breaks within a block, and \\n\\n between sections.
- ABSOLUTELY NO placeholders such as [Your Name], [Your Address], [Your Email], [Your Phone], [Your City], [Your State], [Your Zip Code]. If a value is unknown, omit the line.
- Do NOT label sections in the output (no "DATE:", "RECIPIENT:", "BODY:", etc.). Render only the actual content for each section.
- Use the literal name and address values shown above — copy them verbatim.

Also identify:
- The recipient title and organization
- The recommended channel to send this letter (email or post)
- The relevant regulatory body for this type of complaint and country, including their contact details

${searchResults ? `Additional regulatory information from web search:
${searchResults}

Use this information to ensure the regulator name, contact details, and filing channel are accurate.

${regulatorCandidates.length > 0 ? `Verified regulator candidates extracted from live web search results:
${regulatorCandidates.map((c, i) => `${i + 1}. Name: "${c.name}", Contact: "${c.contact}"`).join('\n')}

Choose ONE of the regulator candidates above. Use the exact name and contact verbatim.` : `No structured regulator candidates were found.`}` : ''}

${candidateEmails.length > 0 ? `Verified email candidates extracted from live web search results for this company (ranked by likely relevance):
${candidateEmails.map((e, i) => `${i + 1}. ${e}`).join('\n')}

Web search snippets the candidates were drawn from (for context):
${companyContactSnippets}

Choose ONE of the candidate emails above for "recipient_contact" — pick the one most clearly meant for customer service, complaints, or general support. Use the email exactly as it appears in the list above (verbatim, lowercase).` : companyContactSnippets ? `Web search snippets for this company:
${companyContactSnippets}

No clear customer-service email was extracted from these snippets. Set "recipient_contact" to null.` : `No web search results were available for this company. Set "recipient_contact" to null.`}

Respond ONLY with a valid JSON object in this exact format and nothing else:
{
  "letter": "full letter text here",
  "recipient": "Customer Service Manager, [Organization]",
  "recipient_contact": ${candidateEmails.length > 0 ? `"<one of the candidate emails listed above, verbatim — or null if none of them look right>"` : `null`},
  "channel": "email",
  "regulator": {
    "name": ${regulatorCandidates.length > 0 ? `"<one of the candidate names listed above, verbatim — or null>"` : `null`},
    "contact": ${regulatorCandidates.length > 0 ? `"<the corresponding candidate contact, verbatim — or null>"` : `null`},
    "country": "country"
  }
}

STRICT RULE FOR "recipient_contact":
- The value MUST be either null or one of the verified email candidates listed above.
- NEVER invent, guess, paraphrase, or modify an email address. Do not derive an email from a company name (e.g. "company name → support@company.com" is FORBIDDEN unless that exact address appears in the candidate list).
- When in doubt, return null. A missing email is far better than a wrong one.

STRICT RULE FOR "regulator":
- If regulator candidates are provided, the "name" and "contact" MUST exactly match one of the candidates, or be null.
- NEVER invent a regulator that is not in the candidate list.`;

    let aiResponseContent = '';
    try {
      const response = await fetch(process.env.GROQ_API_URL!, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'openai/gpt-oss-20b',
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: `Conversation history:\n${messageContext}` }
          ],
          max_tokens: 2048,
          temperature: 0.7,
          response_format: { type: 'json_object' }
        })
      });

      if (!response.ok) {
        throw new Error(`Groq API error: ${response.statusText}`);
      }

      const data = await response.json();
      aiResponseContent = data.choices[0].message.content;
    } catch (error) {
      console.error('Groq API Call failed:', error);
      return NextResponse.json({ error: 'Agent unavailable. Please try again.', code: 500 }, { status: 500 });
    }

    let parsedLetter;
    try {
      // Clean up markdown code blocks if AI included them
      const cleaned = aiResponseContent.replace(/^```json/, '').replace(/```$/, '').trim();
      parsedLetter = JSON.parse(cleaned);
    } catch (error) {
      console.error('Failed to parse AI response as JSON:', aiResponseContent);
      return NextResponse.json({ error: 'Failed to generate a valid letter structure. Please try again.', code: 500 }, { status: 500 });
    }

    const finalLetterText = applySenderName(parsedLetter.letter, senderName);
    const recipientContact = (() => {
      const v = parsedLetter.recipient_contact;
      if (!v || typeof v !== 'string') return null;
      const trimmed = v.trim().toLowerCase();
      if (!trimmed || /^null$/i.test(trimmed)) return null;
      // Reject obviously invalid email shapes
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return null;
      // Hard anti-fabrication: the email MUST be one of the candidates we extracted
      // directly from web search results. Anything else means the LLM invented it.
      if (candidateEmails.length === 0) {
        console.warn('No candidate emails available, dropping LLM email:', trimmed);
        return null;
      }
      const verified = candidateEmails.some((c) => c.toLowerCase() === trimmed);
      if (!verified) {
        console.warn(
          'recipient_contact does not match any candidate, dropping:',
          trimmed,
          'candidates:',
          candidateEmails
        );
        return null;
      }
      return trimmed;
    })();

    let regulatorName = parsedLetter.regulator?.name || null;
    let regulatorContact = parsedLetter.regulator?.contact || null;
    let regulatorCountry = parsedLetter.regulator?.country || null;
    let regulatorVerified = true;

    if (regulatorCandidates.length > 0) {
      const isVerified = regulatorCandidates.some(c => 
        c.name === regulatorName && c.contact === regulatorContact
      );
      if (!isVerified) {
        console.warn('regulator does not match any candidate, dropping:', { name: regulatorName, contact: regulatorContact }, 'candidates:', regulatorCandidates);
        regulatorName = null;
        regulatorContact = null;
        regulatorCountry = null;
        regulatorVerified = false;
      }
    } else {
      // If there were no candidates but LLM guessed something, we mark it unverified
      // and keep or drop it? The requirement says:
      // "If it doesn't match (hallucinated / not grounded), set regulator to null"
      // If we have NO candidates, any answer is not grounded in structured candidates.
      console.warn('no regulator candidates, dropping LLM guess.');
      regulatorName = null;
      regulatorContact = null;
      regulatorCountry = null;
      regulatorVerified = false;
    }

    // Save to MongoDB
    const letter = await Letter.create({
      complaintId: id,
      letter: finalLetterText,
      recipient: parsedLetter.recipient,
      recipientContact,
      channel: parsedLetter.channel,
      regulatorName,
      regulatorContact,
      regulatorCountry,
      regulatorVerified
    });

    // Drop a confirmation message into the chat so the agent acknowledges the letter
    const firstName = senderName.split(/\s+/)[0] || '';
    const greet = firstName ? `${firstName}, your` : 'Your';
    const emailHint = recipientContact
      ? ` If you'd rather send it manually, the recipient's email is ${recipientContact}.`
      : '';
    const confirmation =
      `${greet} formal complaint letter is ready and addressed to ${parsedLetter.recipient}. ` +
      `You can review it in the preview, hit Send via Gmail, or download it as a PDF.${emailHint}`;
    try {
      await Message.create({
        complaintId: id,
        role: 'agent',
        content: confirmation,
      });
    } catch (e) {
      console.error('Failed to save confirmation message:', e);
    }

    // Update complaint
    complaint.letterGenerated = true;
    await complaint.save();

    return NextResponse.json(letter, { status: 201 });

  } catch (error: any) {
    console.error('Error in POST letter:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
