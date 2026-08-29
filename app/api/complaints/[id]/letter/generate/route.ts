import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import Complaint from '@/lib/models/Complaint';
import Message from '@/lib/models/Message';
import Letter from '@/lib/models/Letter';
import User from '@/lib/models/User';
import { applySenderName } from '@/lib/letter-utils';

const GROQ_API_URL = process.env.GROQ_API_URL;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const MODEL = 'openai/gpt-oss-20b';

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

    // Fetch messages for context
    const messages = await Message.find({ complaintId: id }).sort({ createdAt: 1 });
    const historyText = messages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n');

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
      : '- (no sender info on file — extract any address mentioned in the conversation; otherwise use only the name)';

    const prompt = `Generate a formal complaint letter based on the conversation history below.
Return ONLY a JSON object with no other text.

Conversation History:
${historyText}

SENDER INFO (use these exact values verbatim, do not paraphrase):
${senderInfoBlock}

The "letter" field must follow this EXACT structure, with one blank line between each section:

Section 1 — Sender address block at the top-left. REQUIRED. Render the sender info as separate lines, using ONLY values that are provided:
   - Line 1: the sender's name
   - Line 2 (only if address provided): the sender's address
   - Line 3 (only if state/region provided AND not already present in the address): the sender's state/region
   - Line 4 (only if country provided AND not already present in the address or state line): the sender's country
   Skip any line whose value isn't provided. Never duplicate a place name across two lines.

Section 2 — The current date on its own line: ${today}
   Render the date itself only. DO NOT prefix with "DATE:", "Date:", or any label.

Section 3 — Recipient block: title and organization (and HQ city, country if commonly known). Do NOT invent a fake street address.

Section 4 — Salutation (e.g. "Dear Customer Service Manager,")

Section 5 — Body: clear description of the issue, resolution requested, 14-day response deadline.

Section 6 — Closing ("Sincerely,") on its own line, then the actual sender name${senderName ? `: ${senderName}` : ''} on the next line.

Use \\n for line breaks within a block, and \\n\\n for blank lines between sections.
ABSOLUTELY NO placeholders such as [Your Name], [Your Address], [Your Email]. Omit any line whose value is missing.
Do NOT label sections in the output (no "DATE:", "RECIPIENT:", "BODY:", etc.).

Return ONLY a JSON object in this format:
{
  "letter": "<full letter text>",
  "recipient": "<who it's addressed to>",
  "recipientContact": "<the company's customer service email if commonly known, else null>",
  "channel": "<how to send it>",
  "regulatorName": "<relevant regulatory body>",
  "regulatorContact": "<regulator email or website>",
  "regulatorCountry": "<country>"
}

For "recipientContact": only include a real email address you are confident about. If unsure, return null — do not invent emails.
No markdown, no explanation. Pure JSON only.`;

    const response = await fetch(GROQ_API_URL!, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_API_KEY}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.7,
        response_format: { type: 'json_object' },
      }),
    });

    if (!response.ok) {
      throw new Error(`Groq API error: ${response.statusText}`);
    }

    const data = await response.json();
    let content = data.choices[0].message.content.trim();
    
    // Remove markdown code blocks if present
    content = content.replace(/^```json/, '').replace(/```$/, '').trim();

    const parsedLetter = JSON.parse(content);
    parsedLetter.letter = applySenderName(parsedLetter.letter, senderName);
    if (parsedLetter.recipientContact) {
      const v = String(parsedLetter.recipientContact).trim();
      parsedLetter.recipientContact = v && !/^null$/i.test(v) ? v : null;
    } else {
      parsedLetter.recipientContact = null;
    }

    // Save to Letter collection
    const letter = await Letter.create({
      complaintId: id,
      ...parsedLetter,
    });

    // Update complaint
    complaint.letterGenerated = true;
    await complaint.save();

    return NextResponse.json(letter);

  } catch (error: any) {
    console.error('Error generating letter:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
