import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import Complaint from '@/lib/models/Complaint';
import Message from '@/lib/models/Message';
import Letter from '@/lib/models/Letter';
import EscalationLetter from '@/lib/models/EscalationLetter';
import User from '@/lib/models/User';
import { searchRegulator } from '@/lib/search';
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

    const escalation = await EscalationLetter.findOne({ complaintId: id });
    if (!escalation) {
      return NextResponse.json({ error: 'Escalation letter not found' }, { status: 404 });
    }

    return NextResponse.json(escalation);
  } catch (error: any) {
    console.error('Error fetching escalation letter:', error);
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

    // Check letterGenerated
    if (!complaint.letterGenerated) {
      return NextResponse.json({ error: 'Generate a complaint letter first.', code: 409 }, { status: 409 });
    }

    // Check if exists
    const existingEscalation = await EscalationLetter.findOne({ complaintId: id });
    if (existingEscalation) {
      return NextResponse.json(existingEscalation);
    }

    // Fetch original letter and history
    const originalLetter = await Letter.findOne({ complaintId: id });
    const messages = await Message.find({ complaintId: id }).sort({ createdAt: 1 });
    const messageContext = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');

    // Search for additional regulatory info
    let searchResults = '';
    let regulatorCandidates: { name: string, contact: string }[] = [];
    try {
      const country = originalLetter?.regulatorCountry || complaint.country;
      const sector = complaint.complaintType || 'consumer';
      if (country && sector) {
        const regulator = await searchRegulator(country, sector);
        searchResults = regulator.snippets;
        regulatorCandidates = regulator.candidates;
      }
    } catch (e) {
      console.error('Search failed, proceeding without it:', e);
    }

    const senderUser = await User.findById(userSession.id).select('name address state country');
    const senderName = (senderUser?.name || userSession.name || '').trim();
    const senderAddress = (senderUser?.address || '').trim();
    const senderState = (senderUser?.state || '').trim();
    const senderCountry = (senderUser?.country || '').trim();
    const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    const senderLines: string[] = [];
    if (senderName) senderLines.push(`- Sender's name: ${senderName}`);
    if (senderAddress) senderLines.push(`- Sender's address: ${senderAddress}`);
    if (senderState) senderLines.push(`- Sender's state/region: ${senderState}`);
    if (senderCountry) senderLines.push(`- Sender's country: ${senderCountry}`);
    const senderBlockHints = senderLines.length
      ? senderLines.join('\n')
      : '- (No sender address provided — skip the sender address block entirely)';

    const systemPrompt = `You are a professional legal letter writer specializing in regulatory complaints. Based on the original complaint letter and conversation provided, write a formal escalation letter addressed to the relevant regulatory body.

Format the escalation letter using this exact structure, with a single blank line between each section:

1. SENDER ADDRESS BLOCK (top-left of the letter):
${senderBlockHints}

2. DATE: ${today}

3. RECIPIENT BLOCK (the regulator):
- The regulator's name and the relevant department
- The regulator's contact (email/website) if known on the next line
- Do NOT invent a fake street address

4. SALUTATION (e.g. "To Whom It May Concern,")

5. BODY:
- Reference to the original complaint and the date it was sent
- The fact that no satisfactory response was received
- A clear request for regulatory intervention

6. CLOSING ("Sincerely," or "Yours faithfully,") followed by the signature line${senderName ? `: ${senderName}` : ''}

Critical rules:
- Use \\n for line breaks within a block, and \\n\\n for blank lines between sections.
- Do NOT use placeholders like [Your Name], [Your Address], [Your Email]. Only include real provided values.
- If a piece of sender info is missing, OMIT that line entirely.

Also provide step-by-step filing instructions for submitting to this regulator.

Also provide step-by-step filing instructions for submitting to this regulator.

${searchResults ? `Additional regulatory information from web search:
${searchResults}

Use this information to ensure the regulator name, contact details, and filing instructions are accurate.

${regulatorCandidates.length > 0 ? `Verified regulator candidates extracted from live web search results:
${regulatorCandidates.map((c, i) => `${i + 1}. Name: "${c.name}", Contact: "${c.contact}"`).join('\n')}

Choose ONE of the regulator candidates above. Use the exact name and contact verbatim.` : `No structured regulator candidates were found.`}` : ''}

Respond ONLY with a valid JSON object in this exact format and nothing else:
{
  "escalation_letter": "full escalation letter text here",
  "regulator": {
    "name": ${regulatorCandidates.length > 0 ? `"<one of the candidate names listed above, verbatim — or null>"` : `null`},
    "contact": ${regulatorCandidates.length > 0 ? `"<the corresponding candidate contact, verbatim — or null>"` : `null`},
    "filing_instructions": "step by step instructions on how to file"
  }
}

STRICT RULE FOR "regulator":
- If regulator candidates are provided, the "name" and "contact" MUST exactly match one of the candidates, or be null.
- NEVER invent a regulator that is not in the candidate list.`;

    const userContent = `Original Complaint Letter:\n${originalLetter?.letter}\n\nConversation history:\n${messageContext}`;

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
            { role: 'user', content: userContent }
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

    let parsedEscalation;
    try {
      const cleaned = aiResponseContent.replace(/^```json/, '').replace(/```$/, '').trim();
      parsedEscalation = JSON.parse(cleaned);
    } catch (error) {
      console.error('Failed to parse AI response as JSON:', aiResponseContent);
      return NextResponse.json({ error: 'Failed to generate a valid escalation letter structure.', code: 500 }, { status: 500 });
    }

    let regulatorName = parsedEscalation.regulator?.name || null;
    let regulatorContact = parsedEscalation.regulator?.contact || null;
    let filingInstructions = parsedEscalation.regulator?.filing_instructions || null;
    let regulatorVerified = true;

    if (regulatorCandidates.length > 0) {
      const isVerified = regulatorCandidates.some(c => 
        c.name === regulatorName && c.contact === regulatorContact
      );
      if (!isVerified) {
        console.warn('regulator does not match any candidate, dropping:', { name: regulatorName, contact: regulatorContact }, 'candidates:', regulatorCandidates);
        regulatorName = null;
        regulatorContact = null;
        filingInstructions = null;
        regulatorVerified = false;
      }
    } else {
      console.warn('no regulator candidates, dropping LLM guess.');
      regulatorName = null;
      regulatorContact = null;
      filingInstructions = null;
      regulatorVerified = false;
    }

    // Save to MongoDB
    const escalation = await EscalationLetter.create({
      complaintId: id,
      escalationLetter: applySenderName(parsedEscalation.escalation_letter, senderName),
      regulatorName,
      regulatorContact,
      filingInstructions,
      regulatorVerified
    });

    // Update complaint
    complaint.escalationGenerated = true;
    complaint.stage = 'escalate';
    await complaint.save();

    return NextResponse.json(escalation, { status: 201 });

  } catch (error: any) {
    console.error('Error in POST escalation:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
