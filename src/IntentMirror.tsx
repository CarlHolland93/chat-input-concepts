import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

/* ─────────────────────────────────────────────────────────────────────────
   Concept · Intent Mirror (the pre-flight check)
   Most "bad outputs" are misunderstood prompts. A ~200ms pre-flight restates
   what was heard — but the value isn't in the restatement, it's in surfacing
   the gaps you'd never have noticed and letting you fix them in one click.

   Sharpened design:
   • Headline = the action verb + the target. One short line, no hedging.
   • Specs sit in a grid: solid = you said it, dashed = I assumed it. Click
     any assumed chip to swap the value inline — no need to dismiss + retype.
   • A single consequence line tells you what the most-load-bearing assumption
     will actually do to the output.
   • A one-line "you'll get" preview shows the shape of the response.
   ───────────────────────────────────────────────────────────────────────── */

const EASE = [0.22, 1, 0.36, 1] as const;

type Mode = 'smart' | 'always' | 'off';

const SAMPLES = [
  'summarise this for the execs',
  'Rewrite this in plain English, no jargon',
  'Compare these options in a table for the board',
];

type SpecId = 'length' | 'audience' | 'tone' | 'format';

type Spec = { id: SpecId; label: string; value: string; assumed: boolean };

const SPEC_OPTIONS: Record<SpecId, string[]> = {
  length: ['one sentence', 'one paragraph', '~3 short paragraphs', '5 bullet points', 'a markdown table'],
  audience: ['execs', 'engineers', 'customers', 'a general reader', 'a new hire'],
  tone: ['no jargon', 'formal', 'casual', 'confident', 'neutral'],
  format: ['prose', 'bulleted list', 'markdown table', 'numbered steps'],
};

type Intent = {
  action: string;
  object: string;
  objectVague: boolean;
  specs: Spec[];
  confidence: number;
};

function readIntent(text: string): Intent {
  const t = text.trim();
  const lower = t.toLowerCase();

  const taskMap: { re: RegExp; verb: string }[] = [
    { re: /\b(summar[iy][sz]e|summary|tl;?dr|recap)\b/, verb: 'summarise' },
    { re: /\b(rewrite|rephrase|edit|polish|clean up)\b/, verb: 'rewrite' },
    { re: /\b(compare|contrast|vs\.?|versus|weigh|trade-?offs?)\b/, verb: 'compare' },
    { re: /\b(draft|write|compose) (an? )?(email|message|note|reply)\b/, verb: 'draft an email about' },
    { re: /\b(explain|teach|what is|how does|help me understand)\b/, verb: 'explain' },
    { re: /\b(review|audit|check) (the |my )?(code|pr|function)\b/, verb: 'review the code in' },
    { re: /\b(extract|pull out|list) (the )?(action items?|tasks?|key points?)\b/, verb: 'extract the key points from' },
    { re: /\b(translate)\b/, verb: 'translate' },
  ];
  const action = taskMap.find((x) => x.re.test(lower))?.verb ?? 'answer';

  let object = 'your request';
  let objectVague = true;
  if (/\b(this|the) (pdf|document|doc|file|deck|report)\b/.test(lower)) { object = 'this document'; objectVague = false; }
  else if (/\b(this|the) (code|function|pr|snippet)\b/.test(lower)) { object = 'this code'; objectVague = false; }
  else if (/\b(this|the) (text|passage|paragraph|article)\b/.test(lower)) { object = 'this text'; objectVague = false; }
  else if (/\b(below|above|attached|following)\b/.test(lower)) { object = 'the attached content'; objectVague = false; }
  else if (/\b(it|this|that)\b/.test(lower) && t.split(/\s+/).length < 14) { object = 'whatever you point me at'; objectVague = true; }

  const specs: Spec[] = [];

  const lengthMatch =
    /\bone paragraph|a paragraph\b/.test(lower) ? 'one paragraph'
    : /\bbullet points?|bullets\b/.test(lower) ? '5 bullet points'
    : /\ba table|markdown table\b/.test(lower) ? 'a markdown table'
    : /\b(\d+) (words?|sentences?|paragraphs?)\b/.test(lower) ? (lower.match(/\b(\d+) (words?|sentences?|paragraphs?)\b/)?.[0] ?? '')
    : /\bshort|brief|concise\b/.test(lower) ? 'one paragraph'
    : null;
  specs.push(
    lengthMatch
      ? { id: 'length', label: 'Length', value: lengthMatch, assumed: false }
      : { id: 'length', label: 'Length', value: '~3 short paragraphs', assumed: true },
  );

  const audMatch = lower.match(/\b(?:for|aimed at|to)\s+(execs?|executives?|the exec team|the board|leadership|customers?|engineers?|beginners?|a new grad|clients?|stakeholders?)\b/);
  const audValue = audMatch
    ? audMatch[1].replace(/^execs?$|^executives?$|^the exec team$/, 'execs')
    : null;
  specs.push(
    audValue
      ? { id: 'audience', label: 'For', value: audValue, assumed: false }
      : { id: 'audience', label: 'For', value: 'a general reader', assumed: true },
  );

  const noJargon = /\bno jargon|plain english|jargon-free|simple language\b/.test(lower);
  const toneM = lower.match(/\b(formal|casual|friendly|professional|confident|warm|neutral|technical)\b(?:\s+tone)?/);
  const toneVal = noJargon ? 'no jargon' : toneM ? toneM[1] : null;
  specs.push(
    toneVal
      ? { id: 'tone', label: 'Tone', value: toneVal, assumed: false }
      : { id: 'tone', label: 'Tone', value: 'neutral', assumed: true },
  );

  const formatVal =
    /\ba table|markdown table\b/.test(lower) ? 'markdown table'
    : /\bbullet|bullets\b/.test(lower) ? 'bulleted list'
    : /\bstep by step|numbered steps?\b/.test(lower) ? 'numbered steps'
    : null;
  specs.push(
    formatVal
      ? { id: 'format', label: 'Format', value: formatVal, assumed: false }
      : { id: 'format', label: 'Format', value: 'prose', assumed: true },
  );

  const stated = specs.filter((s) => !s.assumed).length;
  let confidence = 0.3;
  if (action !== 'answer') confidence += 0.25;
  if (!objectVague) confidence += 0.2;
  confidence += Math.min(0.25, stated * 0.1);
  confidence = Math.max(0, Math.min(1, confidence));

  return { action, object, objectVague, specs, confidence };
}

/* The most load-bearing assumption — the one that most shapes the output.
   Object > audience > length > tone. Only one shown to keep the surface calm.
   `fix` is the SpecId to open when the user clicks it; null = needs the prompt. */
function topConsequence(i: Intent): { message: string; fix: SpecId | null; cta: string } | null {
  if (i.objectVague)
    return {
      message: "I can't see what to act on — attach a file or paste the text.",
      fix: null,
      cta: 'Back to prompt',
    };
  const aud = i.specs.find((s) => s.id === 'audience');
  if (aud?.assumed)
    return {
      message: 'No audience set — I’ll hedge more and lead softer.',
      fix: 'audience',
      cta: 'Set audience',
    };
  const len = i.specs.find((s) => s.id === 'length');
  if (len?.assumed)
    return {
      message: 'No length given — I’ll aim for around 200 words.',
      fix: 'length',
      cta: 'Set length',
    };
  const ton = i.specs.find((s) => s.id === 'tone');
  if (ton?.assumed)
    return {
      message: 'No tone set — I’ll stay neutral and professional.',
      fix: 'tone',
      cta: 'Set tone',
    };
  return null;
}

function shapePreview(i: Intent): string {
  const format = i.specs.find((s) => s.id === 'format')?.value;
  const length = i.specs.find((s) => s.id === 'length')?.value;
  const tone = i.specs.find((s) => s.id === 'tone')?.value;
  return [format, length, tone].filter(Boolean).join(' · ');
}

type Phase = 'idle' | 'checking' | 'mirror';

export default function IntentMirror({ onSend }: { onSend?: (t: string) => void }) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<Mode>('smart');
  const [phase, setPhase] = useState<Phase>('idle');
  const [modeOpen, setModeOpen] = useState(false);
  const [editingSpec, setEditingSpec] = useState<SpecId | null>(null);
  const [overrides, setOverrides] = useState<Partial<Record<SpecId, string>>>({});
  const taRef = useRef<HTMLTextAreaElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  const baseIntent = useMemo(() => readIntent(text), [text]);

  // Apply user's in-mirror edits on top of the classifier's read.
  const intent: Intent = useMemo(() => {
    if (Object.keys(overrides).length === 0) return baseIntent;
    return {
      ...baseIntent,
      specs: baseIntent.specs.map((s) =>
        overrides[s.id] != null ? { ...s, value: overrides[s.id]!, assumed: false } : s,
      ),
    };
  }, [baseIntent, overrides]);

  const isEmpty = text.trim().length === 0;
  const active = !isEmpty && phase === 'idle';
  const lowConfidence = baseIntent.confidence < 0.62;
  const consequence = topConsequence(intent);
  const shape = shapePreview(intent);

  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(Math.max(ta.scrollHeight, 84), 220)}px`;
  }, [text]);

  useEffect(() => {
    if (phase === 'mirror') confirmRef.current?.focus();
  }, [phase]);

  // Reset overrides whenever the textarea changes — the classifier re-reads
  // and any prior fixes would otherwise stick to a different prompt.
  useEffect(() => {
    setOverrides({});
  }, [text]);

  const reallySend = () => {
    onSend?.(text);
    setText('');
    setOverrides({});
    setPhase('idle');
  };

  const requestSend = () => {
    if (isEmpty || phase !== 'idle') return;
    const shouldCheck = mode === 'always' || (mode === 'smart' && lowConfidence);
    if (!shouldCheck) {
      reallySend();
      return;
    }
    setPhase('checking');
    setTimeout(() => setPhase('mirror'), 220);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      requestSend();
    }
  };

  const onMirrorKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (editingSpec) return; // let the chip popover handle its own keys
    if (e.key === 'Enter') {
      e.preventDefault();
      reallySend();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setPhase('idle');
      taRef.current?.focus();
    }
  };

  const MODE_LABEL: Record<Mode, string> = { smart: 'Smart', always: 'Always', off: 'Off' };

  return (
    <div className="flex w-full max-w-2xl flex-col gap-3">
      <motion.div
        layout
        transition={{ layout: { duration: 0.22, ease: EASE } }}
        className="relative w-full rounded-xl border border-[#26262B] text-[#ECECEE] flex flex-col"
        style={{ background: '#1A1A1D', boxShadow: '0 1px 0 rgba(0,0,0,0.5), 0 12px 28px -16px rgba(0,0,0,0.7)' }}
      >
        {/* Ambient border shimmer */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-0 overflow-hidden rounded-xl"
          style={{
            padding: 1,
            WebkitMask: 'linear-gradient(#000, #000) content-box, linear-gradient(#000, #000)',
            WebkitMaskComposite: 'xor',
            mask: 'linear-gradient(#000, #000) content-box, linear-gradient(#000, #000)',
            maskComposite: 'exclude',
          }}
        >
          <motion.div
            className="h-full w-full rounded-xl"
            style={{
              background:
                'conic-gradient(from 0deg, transparent 0deg, transparent 180deg, rgba(255,255,255,0.025) 240deg, rgba(255,255,255,0.11) 325deg, rgba(255,255,255,0.04) 355deg, transparent 360deg)',
            }}
            animate={{ rotate: 360 }}
            transition={{ duration: 4, ease: 'linear', repeat: Infinity }}
          />
        </div>

        <AnimatePresence mode="wait">
          {phase === 'mirror' ? (
            <motion.div
              key="mirror"
              tabIndex={-1}
              onKeyDown={onMirrorKey}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.2, ease: EASE }}
              className="relative z-10 flex flex-col gap-3.5 p-4 outline-none"
            >
              {/* Headline — one short line: action + target */}
              <div className="flex items-start gap-2.5">
                <span
                  className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: lowConfidence ? '#E0B86B' : '#5BD0A0' }}
                />
                <p className="text-[14px] leading-snug text-[#C8C8CD]">
                  Got it — <span className="text-[#ECECEE]">I’ll {intent.action} {intent.object}</span>
                  {(() => {
                    const aud = intent.specs.find((s) => s.id === 'audience');
                    return aud && !aud.assumed ? <span className="text-[#ECECEE]"> for {aud.value}</span> : null;
                  })()}
                  .
                </p>
              </div>

              {/* Specs grid — label | chip. Dashed chips are editable in place. */}
              <div className="grid grid-cols-[60px_1fr] items-start gap-x-3 gap-y-1.5 pl-4">
                {intent.specs.map((spec) => (
                  <SpecRow
                    key={spec.id}
                    spec={spec}
                    editing={editingSpec === spec.id}
                    onOpen={() => setEditingSpec(spec.id)}
                    onClose={() => setEditingSpec(null)}
                    onPick={(value) => {
                      setOverrides((prev) => ({ ...prev, [spec.id]: value }));
                      setEditingSpec(null);
                    }}
                  />
                ))}
              </div>

              {/* Single, specific consequence — the most load-bearing gap.
                  Clicking the row jumps straight to fixing it (opens the spec
                  popover, or returns to the prompt if the target itself is vague). */}
              {consequence && (
                <button
                  type="button"
                  onClick={() => {
                    if (consequence.fix) {
                      setEditingSpec(consequence.fix);
                    } else {
                      setPhase('idle');
                      setEditingSpec(null);
                      requestAnimationFrame(() => taRef.current?.focus());
                    }
                  }}
                  className="group flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-[#16161A] ml-2"
                >
                  <svg viewBox="0 0 24 24" className="mt-px h-3 w-3 shrink-0 text-[#9A9AA2]" fill="none" stroke="currentColor" strokeWidth={2}>
                    <circle cx="12" cy="12" r="9" />
                    <path d="M12 8v4M12 16v.01" strokeLinecap="round" />
                  </svg>
                  <p className="flex-1 text-[11.5px] leading-snug text-[#9A9AA2]">{consequence.message}</p>
                  <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-[#6A6A72] transition-colors group-hover:text-[#ECECEE]">
                    {consequence.cta}
                    <svg viewBox="0 0 24 24" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth={2.4}>
                      <path d="M5 12h14M13 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </span>
                </button>
              )}

              {/* Output shape preview — what you'll actually get */}
              <div className="rounded-md border border-[#26262B] bg-[#16161A] px-2.5 py-1.5 ml-4">
                <span className="text-[10.5px] uppercase tracking-wide text-[#6A6A72]">You’ll get</span>
                <span className="ml-2 text-[12px] text-[#C8C8CD]">{shape}</span>
              </div>

              {/* Actions */}
              <div className="flex items-center gap-2 pl-4 pt-0.5">
                <button
                  ref={confirmRef}
                  type="button"
                  onClick={reallySend}
                  className="rounded-md bg-[#ECECEE] px-3 py-1.5 text-[12px] font-medium text-[#16161A] outline-none transition-colors hover:bg-white focus:ring-2 focus:ring-white/30"
                >
                  Send it ↵
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPhase('idle');
                    setEditingSpec(null);
                    taRef.current?.focus();
                  }}
                  className="rounded-md px-3 py-1.5 text-[12px] font-medium text-[#9A9AA2] transition-colors hover:text-[#ECECEE]"
                >
                  Back to prompt <span className="text-[#6A6A72]">esc</span>
                </button>
              </div>
            </motion.div>
          ) : (
            <motion.div key="input" exit={{ opacity: 0 }} className="relative z-10 flex flex-col">
              <div className="px-4 pt-4">
                <textarea
                  ref={taRef}
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  onKeyDown={onKey}
                  rows={1}
                  placeholder="Describe what you want…"
                  className="w-full resize-none bg-transparent text-[14px] leading-relaxed text-[#ECECEE] outline-none placeholder:text-[#5A5A60]"
                />
              </div>

              <div className="flex items-center gap-2 px-3 pb-2.5 pt-2">
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setModeOpen((o) => !o)}
                    className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[11px] text-[#9A9AA2] transition-colors hover:bg-[#16161A]"
                  >
                    <svg viewBox="0 0 24 24" className="h-3 w-3 text-[#6A6A72]" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path d="M9 12l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
                      <circle cx="12" cy="12" r="9" />
                    </svg>
                    Pre-flight: {MODE_LABEL[mode]}
                    <svg viewBox="0 0 24 24" className="h-2.5 w-2.5 text-[#6A6A72]" fill="none" stroke="currentColor" strokeWidth={2.4}>
                      <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  </button>
                  <AnimatePresence>
                    {modeOpen && (
                      <motion.div
                        initial={{ opacity: 0, y: 6, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={{ opacity: 0, transition: { duration: 0.1 } }}
                        transition={{ duration: 0.16, ease: EASE }}
                        className="absolute bottom-full left-0 z-30 mb-2 w-56 rounded-lg border border-[#26262B] p-1"
                        style={{ background: '#1F1F22', transformOrigin: 'bottom left', boxShadow: '0 16px 40px -8px rgba(0,0,0,0.65)' }}
                      >
                        {([
                          ['smart', 'Smart', 'Only when the ask is unclear'],
                          ['always', 'Always', 'Confirm every prompt'],
                          ['off', 'Off', 'Never interrupt'],
                        ] as [Mode, string, string][]).map(([m, label, desc]) => (
                          <button
                            key={m}
                            type="button"
                            onClick={() => {
                              setMode(m);
                              setModeOpen(false);
                            }}
                            className="flex w-full flex-col rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-[#26262B]"
                          >
                            <span className="flex items-center justify-between text-[12px] text-[#ECECEE]">
                              {label}
                              {mode === m && <span className="text-[#5BD0A0]">✓</span>}
                            </span>
                            <span className="text-[11px] text-[#6A6A72]">{desc}</span>
                          </button>
                        ))}
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                <AnimatePresence>
                  {!isEmpty && mode === 'smart' && lowConfidence && (
                    <motion.span
                      initial={{ opacity: 0, x: -4 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -4 }}
                      className="text-[11px] text-[#6A6A72]"
                    >
                      will confirm intent first
                    </motion.span>
                  )}
                </AnimatePresence>

                <button
                  type="button"
                  onClick={requestSend}
                  disabled={!active && phase !== 'checking'}
                  aria-label="Send"
                  className="ml-auto flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed"
                  style={{ background: active || phase === 'checking' ? '#3A3A40' : '#222227', color: active || phase === 'checking' ? '#ECECEE' : '#5A5A60' }}
                >
                  {phase === 'checking' ? (
                    <motion.span
                      className="h-3 w-3 rounded-full border-2 border-[#9A9AA2] border-t-transparent"
                      animate={{ rotate: 360 }}
                      transition={{ repeat: Infinity, duration: 0.7, ease: 'linear' }}
                    />
                  ) : (
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth={2.4}>
                      <path d="M12 19V5M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  )}
                </button>
              </div>

              <AnimatePresence>
                {phase === 'checking' && (
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="absolute inset-x-0 bottom-0 h-px overflow-hidden rounded-b-xl"
                  >
                    <motion.div
                      className="h-full w-1/3"
                      style={{ background: 'linear-gradient(90deg, transparent, #5BD0A0, transparent)' }}
                      animate={{ x: ['-100%', '300%'] }}
                      transition={{ repeat: Infinity, duration: 0.8, ease: 'linear' }}
                    />
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* Sample prompts */}
      <AnimatePresence>
        {phase === 'idle' && isEmpty && (
          <motion.div
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.2, ease: EASE }}
            className="flex flex-wrap gap-2"
          >
            {SAMPLES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setText(s);
                  requestAnimationFrame(() => taRef.current?.focus());
                }}
                className="rounded-full border border-[#26262B] bg-transparent px-3 py-1.5 text-[12px] text-[#9A9AA2] transition-colors hover:bg-[#16161A] hover:text-[#ECECEE]"
              >
                {s}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/* ── Spec row ────────────────────────────────────────────────────────────── */

function SpecRow({
  spec,
  editing,
  onOpen,
  onClose,
  onPick,
}: {
  spec: Spec;
  editing: boolean;
  onOpen: () => void;
  onClose: () => void;
  onPick: (value: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!editing) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [editing, onClose]);

  const options = SPEC_OPTIONS[spec.id];

  return (
    <>
      <span className="pt-[3px] text-[11px] uppercase tracking-wide text-[#6A6A72]">{spec.label}</span>
      <div className="relative" ref={ref}>
        <button
          type="button"
          onClick={() => (editing ? onClose() : onOpen())}
          className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11.5px] transition-colors"
          style={{
            color: spec.assumed ? '#9A9AA2' : '#ECECEE',
            background: spec.assumed ? 'transparent' : '#16161A',
            border: spec.assumed ? '1px dashed #3A3A40' : '1px solid #2E2E33',
          }}
        >
          <span>{spec.value}</span>
          {spec.assumed && (
            <span className="text-[10px] text-[#6A6A72]">assumed</span>
          )}
          <svg viewBox="0 0 24 24" className="h-2.5 w-2.5 text-[#6A6A72]" fill="none" stroke="currentColor" strokeWidth={2.4}>
            <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>

        <AnimatePresence>
          {editing && (
            <motion.div
              initial={{ opacity: 0, y: 4, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.1 } }}
              transition={{ duration: 0.16, ease: EASE }}
              className="absolute top-full left-0 z-30 mt-1.5 w-56 rounded-lg border border-[#26262B] p-1"
              style={{ background: '#1F1F22', transformOrigin: 'top left', boxShadow: '0 16px 40px -8px rgba(0,0,0,0.65)' }}
            >
              {options.map((opt) => {
                const isCurrent = opt === spec.value;
                return (
                  <button
                    key={opt}
                    type="button"
                    onClick={() => onPick(opt)}
                    className="flex w-full items-center justify-between rounded-md px-2.5 py-1.5 text-left text-[12px] text-[#ECECEE] transition-colors hover:bg-[#26262B]"
                  >
                    <span>{opt}</span>
                    {isCurrent && <span className="text-[#5BD0A0]">✓</span>}
                  </button>
                );
              })}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </>
  );
}
