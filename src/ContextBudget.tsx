import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

/* ─────────────────────────────────────────────────────────────────────────
   Concept · Context budget meter  (minimal)
   The window is a budget you spend — but at rest the composer is a plain
   message box. One quiet "% context" pill is the only always-on signal;
   the full breakdown (what's filling it, how to free space) lives behind a
   click. Calm by default; detailed on demand; loud only near the limit.

   Structure follows the leading composers (ChatGPT / Claude / Mistral):
   attachments as a chip row above the field, a leading + to attach, and a
   left/right split toolbar with a soft focus glow on the whole surface.
   ───────────────────────────────────────────────────────────────────────── */

const EASE = [0.22, 1, 0.36, 1] as const;
const WINDOW = 200_000;
const SYSTEM_TOKENS = 4_200;

type Doc = { id: string; name: string; tokens: number };

const INITIAL_DOCS: Doc[] = [
  { id: 'd1', name: 'Q3-board-deck.pdf', tokens: 41_800 },
  { id: 'd2', name: 'competitor-teardown.md', tokens: 22_400 },
];

// Clicking + cycles through these, so the meter visibly responds.
const ATTACH_POOL = [
  { name: 'support-transcript.txt', tokens: 13_900 },
  { name: 'market-scan.pdf', tokens: 18_600 },
  { name: 'earnings-call.txt', tokens: 26_300 },
  { name: 'brand-guidelines.md', tokens: 9_400 },
];

const SAMPLES = [
  'Summarise the board deck for the exec team',
  'Compare the two documents and flag any contradictions',
  'Pull the key risks from these files into a table',
];

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}K` : `${n}`);

type Segment = { id: string; label: string; tokens: number; color: string };

export default function ContextBudget({ onSend }: { onSend?: (t: string) => void }) {
  const [text, setText] = useState('');
  const [docs, setDocs] = useState<Doc[]>(INITIAL_DOCS);
  const [historyTokens, setHistoryTokens] = useState(31_000);
  const [submitting, setSubmitting] = useState(false);
  const [open, setOpen] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const attachIdx = useRef(0);

  const messageTokens = Math.ceil(text.length / 4);
  const docsTokens = docs.reduce((s, d) => s + d.tokens, 0);

  const segments: Segment[] = useMemo(
    () => [
      { id: 'system', label: 'System prompt', tokens: SYSTEM_TOKENS, color: '#3A3A40' },
      { id: 'history', label: 'Conversation', tokens: historyTokens, color: '#5A6B8C' },
      { id: 'docs', label: `${docs.length} document${docs.length === 1 ? '' : 's'}`, tokens: docsTokens, color: '#5BD0A0' },
      { id: 'message', label: 'This message', tokens: messageTokens, color: '#E0B86B' },
    ],
    [historyTokens, docsTokens, docs.length, messageTokens],
  );

  const used = segments.reduce((s, x) => s + x.tokens, 0);
  const pct = Math.min(100, (used / WINDOW) * 100);
  const remaining = Math.max(0, WINDOW - used);

  const level = pct >= 95 ? 'critical' : pct >= 80 ? 'warn' : 'ok';
  // At rest the pill is muted; it only takes on colour near the limit.
  const tint = level === 'critical' ? '#E07A7A' : level === 'warn' ? '#E0B86B' : '#5A5A60';

  const isEmpty = text.trim().length === 0;
  const active = !isEmpty && !submitting;

  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(Math.max(ta.scrollHeight, 52), 220)}px`;
  }, [text]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!popRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const addDoc = () => {
    const pick = ATTACH_POOL[attachIdx.current % ATTACH_POOL.length];
    attachIdx.current += 1;
    setDocs((prev) => [...prev, { id: `a${Date.now()}`, name: pick.name, tokens: pick.tokens }]);
  };

  const submit = async () => {
    if (!active) return;
    setSubmitting(true);
    onSend?.(text);
    setHistoryTokens((h) => h + messageTokens);
    await new Promise((r) => setTimeout(r, 140));
    setText('');
    setSubmitting(false);
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="flex w-full max-w-2xl flex-col gap-3">
    <motion.div
      layout
      onClick={() => taRef.current?.focus()}
      transition={{ layout: { duration: 0.22, ease: EASE } }}
      className="relative w-full cursor-text rounded-xl border border-[#26262B] text-[#ECECEE] flex flex-col"
      style={{ background: '#1A1A1D', boxShadow: '0 1px 0 rgba(0,0,0,0.5), 0 12px 28px -16px rgba(0,0,0,0.7)' }}
    >
      {/* Ambient border shimmer */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl"
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

      {/* Attachment chip row — above the field, like the leading composers */}
      <AnimatePresence initial={false}>
        {docs.length > 0 && (
          <motion.div
            key="chips"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.22, ease: EASE }}
            className="relative overflow-hidden"
          >
            <div className="flex flex-wrap gap-1.5 px-3.5 pt-3.5">
              <AnimatePresence initial={false}>
                {docs.map((d) => (
                  <motion.span
                    layout
                    key={d.id}
                    initial={{ opacity: 0, scale: 0.85 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.85 }}
                    transition={{ type: 'spring', stiffness: 380, damping: 28 }}
                    className="group inline-flex items-center gap-2 rounded-lg border border-[#2E2E33] bg-[#161619] py-1.5 pl-2 pr-1.5 text-[12px]"
                  >
                    <svg viewBox="0 0 24 24" className="h-3.5 w-3.5 shrink-0 text-[#6A6A72]" fill="none" stroke="currentColor" strokeWidth={2}>
                      <path d="M14 3v4a1 1 0 0 0 1 1h4M5 3h9l5 5v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <span className="max-w-[150px] truncate text-[#C8C8CD]">{d.name}</span>
                    <span className="tabular-nums text-[11px] text-[#6A6A72]">{fmt(d.tokens)}</span>
                    <button
                      type="button"
                      aria-label={`Remove ${d.name}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        setDocs((prev) => prev.filter((x) => x.id !== d.id));
                      }}
                      className="flex h-4 w-4 items-center justify-center rounded-md text-[#6A6A72] transition-colors hover:bg-[#2E2E33] hover:text-[#ECECEE]"
                    >
                      <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2.4}>
                        <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
                      </svg>
                    </button>
                  </motion.span>
                ))}
              </AnimatePresence>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Textarea */}
      <div className="relative px-4 pt-3.5">
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          rows={1}
          placeholder="Message…"
          className="w-full resize-none bg-transparent text-[14px] leading-relaxed text-[#ECECEE] outline-none placeholder:text-[#5A5A60]"
        />
      </div>

      {/* Toolbar — leading attach on the left, context + send on the right */}
      <div className="relative flex items-center px-2.5 pb-2.5 pt-1">
        {/* Attach */}
        <motion.button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            addDoc();
          }}
          whileTap={{ scale: 0.88 }}
          aria-label="Attach a document"
          className="flex h-8 w-8 items-center justify-center rounded-full text-[#9A9AA2] transition-colors hover:bg-[#222227] hover:text-[#ECECEE]"
        >
          <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="none" stroke="currentColor" strokeWidth={2}>
            <path d="M12 5v14M5 12h14" strokeLinecap="round" />
          </svg>
        </motion.button>

        <div className="relative ml-auto flex items-center gap-1" ref={popRef}>
          {/* Quiet context pill — opens the full breakdown */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setOpen((o) => !o);
            }}
            className="flex items-center gap-1.5 rounded-full px-2 py-1.5 text-[12px] tabular-nums transition-colors hover:bg-[#222227]"
            style={{ color: level === 'ok' ? '#6A6A72' : tint }}
            aria-label="Context budget"
          >
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 -rotate-90">
              <circle cx="8" cy="8" r="6" fill="none" stroke="#2E2E33" strokeWidth="2" />
              <motion.circle
                cx="8" cy="8" r="6" fill="none" stroke={level === 'ok' ? '#7A7A82' : tint}
                strokeWidth="2" strokeLinecap="round" strokeDasharray={2 * Math.PI * 6}
                initial={false}
                animate={{ strokeDashoffset: 2 * Math.PI * 6 * (1 - pct / 100) }}
                transition={{ duration: 0.35, ease: EASE }}
              />
            </svg>
            {pct.toFixed(0)}%
          </button>

          {/* Send */}
          <motion.button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              submit();
            }}
            disabled={!active}
            whileTap={active ? { scale: 0.9 } : undefined}
            aria-label="Send"
            animate={{
              backgroundColor: active ? '#ECECEE' : '#26262B',
              color: active ? '#16161A' : '#5A5A60',
            }}
            transition={{ duration: 0.2, ease: EASE }}
            className="flex h-8 w-8 items-center justify-center rounded-full disabled:cursor-not-allowed"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.6}>
              <path d="M12 19V5M5 12l7-7 7 7" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </motion.button>

          {/* Breakdown popover — progressive disclosure */}
          <AnimatePresence>
            {open && (
              <motion.div
                initial={{ opacity: 0, y: 8, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.1 } }}
                transition={{ duration: 0.18, ease: EASE }}
                onClick={(e) => e.stopPropagation()}
                className="absolute bottom-full right-0 z-30 mb-2.5 w-72 rounded-xl border border-[#2A2A30] p-3.5"
                style={{ background: '#1F1F22', transformOrigin: 'bottom right', boxShadow: '0 20px 48px -12px rgba(0,0,0,0.7)' }}
              >
                <div className="mb-2.5 flex items-baseline justify-between">
                  <span className="text-[12px] font-medium text-[#C8C8CD]">Context budget</span>
                  <span className="text-[11px] tabular-nums" style={{ color: tint }}>
                    {fmt(used)} / {fmt(WINDOW)}
                  </span>
                </div>

                {/* Stacked meter */}
                <div className="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-[#141416]">
                  {segments.map((s) => (
                    <motion.div
                      key={s.id}
                      layout
                      initial={false}
                      animate={{ width: `${(s.tokens / WINDOW) * 100}%` }}
                      transition={{ duration: 0.3, ease: EASE }}
                      style={{ background: s.color }}
                    />
                  ))}
                </div>

                {/* Segment rows */}
                <ul className="mt-3 flex flex-col gap-2">
                  {segments.map((s) => (
                    <li key={s.id} className="flex items-center gap-2 text-[12px]">
                      <span className="h-2 w-2 rounded-[3px]" style={{ background: s.color }} />
                      <span className="text-[#9A9AA2]">{s.label}</span>
                      <span className="ml-auto tabular-nums text-[#6A6A72]">{fmt(s.tokens)}</span>
                    </li>
                  ))}
                  <li className="flex items-center gap-2 border-t border-[#2A2A30] pt-2 text-[12px]">
                    <span className="text-[#6A6A72]">Free</span>
                    <span className="ml-auto tabular-nums text-[#9A9AA2]">{fmt(remaining)}</span>
                  </li>
                </ul>

                {historyTokens > 0 && (
                  <button
                    type="button"
                    onClick={() => setHistoryTokens(0)}
                    className="mt-3 w-full rounded-lg bg-[#26262B] py-2 text-[11px] font-medium text-[#ECECEE] transition-colors hover:bg-[#33333a]"
                  >
                    Trim conversation · free {fmt(historyTokens)}
                  </button>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>

      {/* Sample prompts */}
      <AnimatePresence>
        {isEmpty && (
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
