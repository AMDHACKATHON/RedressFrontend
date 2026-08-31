import { Info, Mail, Send } from 'lucide-react';

interface LetterDisplayProps {
  title: string;
  letter: string;
  recipient: string;
  recipientContact?: string | null;
  channel: string;
  regulator: {
    name?: string | null;
    contact?: string | null;
    country?: string | null;
    filing_instructions?: string | null;
  } | null;
  regulatorVerified?: boolean;
  /** Subject line used by the Send-via-Gmail button. Defaults to the title. */
  emailSubject?: string;
}

export default function LetterDisplay({
  title,
  letter,
  recipient,
  recipientContact,
  channel,
  regulator,
  regulatorVerified = true,
  emailSubject,
}: LetterDisplayProps) {
  const channelLower = channel.toLowerCase();
  const ChannelIcon = channelLower.includes('mail') || channelLower === 'email' ? Mail : Send;

  const cleanContact = (recipientContact || '').trim();
  const isEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanContact);
  // Always offer the Gmail compose link. If we have a verified email we pre-fill
  // the recipient; otherwise Gmail opens with subject + body so the user can type
  // the recipient address themselves.
  const gmailParams = [
    `view=cm`,
    `fs=1`,
    isEmail ? `to=${encodeURIComponent(cleanContact)}` : '',
    `su=${encodeURIComponent(emailSubject || title)}`,
    `body=${encodeURIComponent(letter)}`,
  ].filter(Boolean).join('&');
  const gmailUrl = `https://mail.google.com/mail/?${gmailParams}`;

  return (
    <div className="glass-card rounded-2xl overflow-hidden">
      <div className="p-5 sm:p-6 space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-base sm:text-lg font-bold text-slate-900 dark:text-white leading-tight">
            {title}
          </h2>
          <div className="shrink-0 inline-flex items-center gap-1.5 text-[10px] font-semibold px-2.5 py-1 bg-indigo-500/10 text-indigo-600 dark:text-indigo-300 rounded-full border border-indigo-500/20 uppercase tracking-wider">
            <ChannelIcon size={10} />
            <span>{channel}</span>
          </div>
        </div>

        {/* Recipient + Regulator — 2-column on md+, single card with grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 bg-slate-100/50 dark:bg-white/[0.02] p-4 rounded-xl border border-slate-200/60 dark:border-white/5">
          <div className="space-y-1 min-w-0">
            <p className="text-[9px] font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400">
              Recipient
            </p>
            <p className="text-xs font-semibold text-slate-900 dark:text-white leading-snug break-words">
              {recipient}
            </p>
            {cleanContact && (
              <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-snug break-all">
                {cleanContact}
              </p>
            )}
          </div>
          <div className="space-y-1 min-w-0">
            <p className="text-[9px] font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400">
              Regulator
            </p>
            {!regulatorVerified || !regulator ? (
              <div className="bg-amber-500/10 border border-amber-500/20 text-amber-700 dark:text-amber-300 p-2 rounded text-[11px] leading-snug">
                We couldn't confidently verify this regulator — please double check before sending.
              </div>
            ) : (
              <>
                <p className="text-xs font-semibold text-slate-900 dark:text-white leading-snug break-words">
                  {regulator.name}
                </p>
                <p className="text-[11px] text-slate-500 dark:text-slate-400 leading-snug break-words">
                  {regulator.contact}
                </p>
                {regulator.country && (
                  <p className="text-[11px] text-slate-500 dark:text-slate-500">
                    {regulator.country}
                  </p>
                )}
              </>
            )}
          </div>
        </div>

        {/* Filing Instructions */}
        {regulator && regulator.filing_instructions && (
          <div className="flex gap-3 bg-blue-500/5 dark:bg-blue-500/10 p-4 rounded-xl border border-blue-500/20">
            <Info className="text-blue-500 shrink-0 mt-0.5" size={16} />
            <div className="space-y-1 min-w-0">
              <p className="text-[10px] font-bold text-blue-700 dark:text-blue-300 uppercase tracking-wider">
                Filing Instructions
              </p>
              <p className="text-xs text-blue-800 dark:text-blue-200/90 leading-relaxed">
                {regulator.filing_instructions}
              </p>
            </div>
          </div>
        )}

        {/* Letter Content */}
        <div className="space-y-2">
          <p className="text-[9px] font-bold uppercase tracking-widest text-slate-500 dark:text-slate-400">
            Letter Preview
          </p>
          <div className="relative rounded-xl overflow-hidden border border-slate-200 dark:border-white/10 bg-[#fdfcf7] dark:bg-[#1a1a1a]">
            <div className="max-h-[420px] overflow-y-auto custom-scrollbar p-5 sm:p-6">
              <div className="font-serif text-[13px] sm:text-sm text-slate-800 dark:text-slate-200 leading-[1.7] whitespace-pre-wrap">
                {letter}
              </div>
            </div>
            <div className="absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-[#fdfcf7] dark:from-[#1a1a1a] to-transparent pointer-events-none" />
          </div>
        </div>

        {/* Send via Gmail */}
        <div className="space-y-1.5">
          <a
            href={gmailUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-full items-center justify-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold bg-gradient-to-r from-indigo-500 to-purple-600 text-white shadow-lg shadow-indigo-500/20 hover:opacity-95 transition"
          >
            <Mail size={16} />
            Send via Gmail
          </a>
          {!isEmail && (
            <p className="text-[11px] text-slate-500 dark:text-slate-400 text-center px-2">
              We couldn't auto-fill the recipient — add their email in Gmail before sending.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
