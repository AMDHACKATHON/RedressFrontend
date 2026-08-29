import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '@/lib/auth';
import { connectDB } from '@/lib/mongodb';
import Complaint from '@/lib/models/Complaint';
import Message from '@/lib/models/Message';
import Letter from '@/lib/models/Letter';
import User from '@/lib/models/User';
import { applySenderName } from '@/lib/letter-utils';

const GROQ_API_URL = process.env.GROQ_API_URL!;
const GROQ_API_KEY = process.env.GROQ_API_KEY!;
const MODEL = 'openai/gpt-oss-20b';

async function callLLM(
  messages: { role: string; content: string }[],
  opts: { jsonMode?: boolean; temperature?: number; maxTokens?: number } = {}
): Promise<string> {
  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${GROQ_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxTokens ?? 1024,
      ...(opts.jsonMode ? { response_format: { type: 'json_object' } } : {}),
    }),
  });
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    console.error('Groq API Error:', errorData);
    throw new Error(`Groq API Error: ${response.statusText}`);
  }
  const data = await response.json();
  return data.choices[0].message.content as string;
}

function tryParseJson(text: string): any | null {
  const trimmed = text.trim().replace(/^```json/, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

/**
 * Pull a JSON action signal out of an agent reply, even if the LLM appended
 * it after conversational prose. Returns the parsed JSON (if any) and the
 * reply with the JSON block removed so the user never sees it.
 */
function extractJsonAction(text: string): { json: any | null; cleaned: string } {
  if (!text) return { json: null, cleaned: '' };
  const original = text;
  const trimmed = text.trim();
  if (!trimmed) return { json: null, cleaned: '' };

  // 1. Fenced ```json { ... } ``` block
  const fenceRegex = /```json\s*(\{[\s\S]*?\})\s*```/i;
  const fenceMatch = trimmed.match(fenceRegex);
  if (fenceMatch) {
    try {
      return {
        json: JSON.parse(fenceMatch[1]),
        cleaned: trimmed.replace(fenceRegex, '').trim(),
      };
    } catch {
      // fall through
    }
  }

  // 2. The whole reply is JSON
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      return { json: JSON.parse(trimmed), cleaned: '' };
    } catch {
      // fall through
    }
  }

  // 3. JSON appended to prose — find the last balanced { ... } that parses
  const lastOpen = trimmed.lastIndexOf('{');
  const lastClose = trimmed.lastIndexOf('}');
  if (lastOpen !== -1 && lastClose > lastOpen) {
    const candidate = trimmed.slice(lastOpen, lastClose + 1);
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && 'action' in parsed) {
        return {
          json: parsed,
          cleaned: trimmed.slice(0, lastOpen).trim(),
        };
      }
    } catch {
      // fall through
    }
  }

  return { json: null, cleaned: original };
}

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

    const messages = await Message.find({ complaintId: id }).sort({ createdAt: 1 });

    return NextResponse.json(messages);
  } catch (error: any) {
    console.error('Error fetching messages:', error);
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
    const { content } = await req.json();

    if (!content) {
      return NextResponse.json({ error: 'Content is required' }, { status: 400 });
    }

    await connectDB();

    const complaint = await Complaint.findById(id);
    if (!complaint) {
      return NextResponse.json({ error: 'Complaint not found' }, { status: 404 });
    }

    if (complaint.userId.toString() !== userSession.id) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    // Save user message
    await Message.create({ complaintId: id, role: 'user', content });

    // Fetch full history (including the just-saved user message)
    const history = await Message.find({ complaintId: id }).sort({ createdAt: 1 });

    // Load existing letter if past the understand stage
    const existingLetter =
      complaint.stage === 'understand'
        ? null
        : await Letter.findOne({ complaintId: id });

    // Look up the user record so the agent knows what's already on file
    const userRecord = await User.findById(userSession.id).select('name address state country');
    const fullName = ((userRecord?.name || userSession.name || '') as string).trim();
    const firstName = fullName.split(/\s+/)[0] || '';
    const senderAddress = (userRecord?.address || '').trim();
    const senderState = (userRecord?.state || '').trim();
    const senderCountry = (userRecord?.country || '').trim();

    const knownProfile: string[] = [];
    if (fullName) knownProfile.push(`Name: ${fullName}`);
    if (senderAddress) knownProfile.push(`Address: ${senderAddress}`);
    if (senderState) knownProfile.push(`State/region: ${senderState}`);
    if (senderCountry) knownProfile.push(`Country: ${senderCountry}`);
    const profileBlock = knownProfile.length
      ? knownProfile.join('\n')
      : '(no profile info on file)';

    const missingFields: string[] = [];
    if (!senderAddress) missingFields.push('mailing address');
    if (!senderState) missingFields.push('state/region');
    if (!senderCountry) missingFields.push('country');

    const userContextLine = fullName
      ? `You are speaking with ${fullName}${firstName && firstName !== fullName ? ` (first name: ${firstName})` : ''}. Address them by their first name when it feels natural — but don't force it into every reply.`
      : `You don't yet know the user's name. If it comes up naturally, you can ask, otherwise don't.`;

    // Stage-specific system prompt
    let systemPrompt = '';
    if (complaint.stage === 'understand') {
      const missingClause = missingFields.length
        ? `IMPORTANT: the user's ${missingFields.join(' and ')} ${missingFields.length === 1 ? 'is' : 'are'} not on file. Before emitting the ready_for_letter signal, ask once for the missing piece(s) so the letter can include a proper sender block. Phrase it naturally — e.g. "What address should I put at the top of the letter?" Do NOT ask if the info is already on file.`
        : 'The user already has their address and country on file — do NOT ask for these again.';

      systemPrompt = `You are Redress, an AI complaint resolution agent. Your job is to help users draft formal complaint letters and escalate to regulators if needed.

${userContextLine}

Profile on file:
${profileBlock}

${missingClause}

Rules:
1. Gather: the organization name, what happened, the country, the date, what outcome the user wants — plus the sender's mailing address if not already on file.
2. Keep it tight: at most 3 short clarifying questions total. Combine related questions when possible.
3. Once you have enough information AND no clarifying questions remain, respond with EXACTLY this JSON object and nothing else (no prose before or after):
{"action": "ready_for_letter", "summary": "<one sentence summary of the complaint>", "complaint_type": "<bank|telco|utility|landlord|government|other>", "country": "<country name>", "sender_state": "<the user's state/province/region if mentioned in the conversation, otherwise null>", "sender_address": "<the user's mailing address if mentioned in the conversation, otherwise null>"}
4. If the user says their complaint was ignored or rejected, respond with EXACTLY this JSON object and nothing else:
{"action": "escalate"}
5. For all other turns, reply in plain conversational English. Be empathetic, clear, professional. No markdown, no bullet points.

CRITICAL OUTPUT RULES — read carefully:
- Each reply MUST be EITHER plain conversational English OR a single JSON action object. NEVER both in the same reply.
- If you are still asking the user any question (even a confirmation), reply with prose only and DO NOT include any JSON.
- Only emit a JSON action when your reply contains zero questions and zero conversational text.
- JSON signals are never wrapped in markdown code fences. They are raw JSON, alone.`;
    } else if (complaint.stage === 'draft') {
      const letterText = existingLetter?.letter || '(letter not yet generated)';
      systemPrompt = `You are Redress, the complaint resolution agent. The user's formal complaint letter has already been generated. Here it is:

---
${letterText}
---

Recipient: ${existingLetter?.recipient || 'unknown'}
Channel: ${existingLetter?.channel || 'unknown'}
Regulator: ${existingLetter?.regulatorName || 'unknown'} (${existingLetter?.regulatorCountry || 'unknown'})
Sender's name (for any signature): ${fullName || 'unknown'}

${userContextLine}

The user can do four things in this stage:

A. Ask follow-up questions about the letter — answer naturally in plain English. No JSON, no markdown bullets.

B. Request EDITS to the letter (e.g. "make paragraph 3 sound more human", "shorter", "add a sentence about X", "change the tone"). When you detect an edit request, respond with EXACTLY this JSON object and nothing else:
{"action": "edit_letter", "instructions": "<clear, faithful summary of what the user wants changed>"}

C. Say their complaint was ignored / they want to escalate to a regulator. When this happens, respond with EXACTLY this JSON object and nothing else:
{"action": "escalate"}

D. Tell you the matter has been resolved or settled (e.g. "they replied and refunded me", "it's settled", "they apologized and sorted it"). When you detect resolution success, respond with EXACTLY this JSON object and nothing else:
{"action": "mark_resolved"}

CRITICAL OUTPUT RULES — read carefully:
- Each reply MUST be EITHER plain conversational English OR a single JSON action object. NEVER both in the same reply.
- If you are answering a question or asking for clarification, reply with prose only — no JSON.
- Only emit a JSON action when your reply contains zero questions and zero prose.
- JSON signals are never wrapped in markdown code fences. They are raw JSON, alone.`;
    } else if (complaint.stage === 'escalate') {
      systemPrompt = `You are Redress, the complaint resolution agent. An escalation letter has been sent to the regulator.

${userContextLine}

Answer the user's questions helpfully and conversationally. If the user tells you the matter has been resolved or settled (e.g. "the regulator replied and they refunded me", "it's sorted"), respond with EXACTLY this JSON object and nothing else:
{"action": "mark_resolved"}

For all other turns, reply in plain conversational English. No markdown bullets, no JSON.`;
    } else {
      // resolved
      systemPrompt = `You are Redress, the complaint resolution agent. This complaint has been marked as resolved.

${userContextLine}

Answer the user's questions warmly and briefly. Don't suggest new escalations or letter edits — the case is closed. No JSON signals are needed in this stage.`;
    }

    const conversation = [
      { role: 'system', content: systemPrompt },
      ...history.map((m) => ({
        role: m.role === 'user' ? 'user' : 'assistant',
        content: m.content,
      })),
    ];

    let agentReply: string;
    try {
      agentReply = await callLLM(conversation, { temperature: 0.7, maxTokens: 1024 });
    } catch (err) {
      console.error('Chat LLM call failed:', err);
      return NextResponse.json(
        { error: 'Agent unavailable. Please try again.', code: 500 },
        { status: 500 }
      );
    }

    // Detect a JSON action signal in the reply and strip it from the displayed text
    const { json: parsed, cleaned: prose } = extractJsonAction(agentReply);

    // If the model emitted prose AND a signal in the same turn, the prose usually
    // contains a clarifying question — in that case we ignore the premature signal,
    // show only the prose, and let the next user reply trigger the real signal.
    const proseHasQuestion = /[?？]/.test(prose);
    const honorAction = !!parsed?.action && !(parsed.action === 'ready_for_letter' && proseHasQuestion);

    let displayReply = prose || agentReply;
    let stage = complaint.stage;
    let ready_for_letter = false;
    let action: string | null = null;
    let updatedLetter: any = null;

    const namePrefix = firstName ? `${firstName}, ` : '';
    if (honorAction && parsed?.action === 'ready_for_letter' && complaint.stage === 'understand') {
      stage = 'draft';
      complaint.stage = 'draft';
      complaint.summary = parsed.summary || complaint.summary;
      complaint.complaintType = parsed.complaint_type || complaint.complaintType;
      complaint.country = parsed.country || complaint.country;
      await complaint.save();

      // If the agent collected info that's missing from the user's profile, persist it
      // so future letters automatically include a proper sender block.
      if (userRecord) {
        let userDirty = false;
        const collectedAddress = (parsed.sender_address || '').toString().trim();
        if (collectedAddress && !userRecord.address && !/^null$/i.test(collectedAddress)) {
          userRecord.address = collectedAddress;
          userDirty = true;
        }
        const collectedState = (parsed.sender_state || '').toString().trim();
        if (collectedState && !userRecord.state && !/^null$/i.test(collectedState)) {
          userRecord.state = collectedState;
          userDirty = true;
        }
        const collectedCountry = (parsed.country || '').toString().trim();
        if (collectedCountry && !userRecord.country) {
          userRecord.country = collectedCountry;
          userDirty = true;
        }
        if (userDirty) {
          try {
            await userRecord.save();
          } catch (e) {
            console.error('Failed to persist sender info to user profile:', e);
          }
        }
      }

      ready_for_letter = true;
      action = 'ready_for_letter';
      displayReply = `${namePrefix}I have everything I need. Click Generate Letter to get your formal complaint letter.`;
    } else if (honorAction && parsed?.action === 'escalate') {
      stage = 'escalate';
      complaint.stage = 'escalate';
      await complaint.save();
      action = 'escalate';
      displayReply = `Understood${firstName ? `, ${firstName}` : ''}. Click Escalate to Regulator to generate your escalation letter.`;
    } else if (
      honorAction &&
      parsed?.action === 'mark_resolved' &&
      (complaint.stage === 'draft' || complaint.stage === 'escalate')
    ) {
      stage = 'resolved';
      complaint.stage = 'resolved';
      complaint.resolvedAt = new Date();
      await complaint.save();
      action = 'mark_resolved';
      displayReply = `Wonderful${firstName ? `, ${firstName}` : ''}. I've marked this complaint as resolved. Glad it worked out — you can always start a fresh complaint from the dashboard if anything else comes up.`;
    } else if (honorAction && parsed?.action === 'edit_letter' && existingLetter) {
      const instructions = (parsed.instructions || '').toString().trim() || 'improve the letter';
      const senderName = userSession.name || '';
      try {
        const editPrompt = `You are revising a formal complaint letter based on the user's feedback.

Current letter (JSON):
${JSON.stringify(
  {
    letter: existingLetter.letter,
    recipient: existingLetter.recipient,
    channel: existingLetter.channel,
    regulator: {
      name: existingLetter.regulatorName,
      contact: existingLetter.regulatorContact,
      country: existingLetter.regulatorCountry,
    },
  },
  null,
  2
)}

User's edit request: "${instructions}"

Apply the edit while preserving:
- The signature with the sender's name${senderName ? `: "${senderName}"` : ''} (do NOT use placeholders like [Your Name])
- A 14-day response deadline (unless the user explicitly removes it)
- Recipient and regulator details (do not invent or change names/contacts)
- The professional tone

Respond ONLY with a valid JSON object in this exact format and nothing else:
{"letter": "<full updated letter text>", "recipient": "<unchanged>", "channel": "<unchanged>", "regulator": {"name": "<unchanged>", "contact": "<unchanged>", "country": "<unchanged>"}}`;

        const revisedRaw = await callLLM(
          [{ role: 'user', content: editPrompt }],
          { jsonMode: true, maxTokens: 2048, temperature: 0.6 }
        );
        const revised = tryParseJson(revisedRaw);
        if (!revised || typeof revised.letter !== 'string') {
          throw new Error('Edit response was not valid JSON');
        }

        existingLetter.letter = applySenderName(revised.letter, senderName);
        if (revised.recipient) existingLetter.recipient = revised.recipient;
        if (revised.channel) existingLetter.channel = revised.channel;
        if (revised.regulator) {
          if (revised.regulator.name) existingLetter.regulatorName = revised.regulator.name;
          if (revised.regulator.contact) existingLetter.regulatorContact = revised.regulator.contact;
          if (revised.regulator.country) existingLetter.regulatorCountry = revised.regulator.country;
        }
        await existingLetter.save();

        updatedLetter = existingLetter.toObject();
        action = 'edit_letter';
        displayReply = "I've updated the letter — take a look at the preview.";
      } catch (err) {
        console.error('Edit letter regen failed:', err);
        displayReply = "I couldn't apply that edit. Try rephrasing what you'd like changed.";
      }
    } else if (parsed?.action && !prose) {
      // Model emitted an action we couldn't act on, with no prose — never expose raw JSON
      displayReply = "Got it. What would you like to do next?";
    }

    // Save agent reply (the displayed text, not raw JSON signals)
    const agentMessage = await Message.create({
      complaintId: id,
      role: 'agent',
      content: displayReply,
    });

    return NextResponse.json({
      messageId: agentMessage._id,
      reply: displayReply,
      stage,
      ready_for_letter,
      clarifying_questions_done: ready_for_letter,
      action,
      letter: updatedLetter,
      summary: complaint.summary,
    });
  } catch (error: any) {
    console.error('Error in POST messages:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
