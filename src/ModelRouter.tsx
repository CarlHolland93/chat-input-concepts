import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { AnimatePresence, motion, useAnimate } from 'framer-motion';

/* ─────────────────────────────────────────────────────────────────────────
   Concept · Model router
   A lightweight classifier reads what you're typing and picks a tier on
   your behalf — fast/cheap for lookups, balanced for nuanced writing,
   strongest for multi-step reasoning and long code.

   The model pill IS the router:
   • In auto mode it changes as you type. Each time it swaps tiers it gives
     a single shake — a micro-interaction that says "I just re-routed."
   • Hover the pill for the one-line rationale and a cost delta.
   • Click it to pin a model manually, or stay on Auto.

   Default is Balanced — the safe anchor. The classifier nudges from there.
   ───────────────────────────────────────────────────────────────────────── */

const EASE = [0.22, 1, 0.36, 1] as const;

type ModelId = 'fast' | 'balanced' | 'strong';

type ModelSpec = {
  id: ModelId;
  name: string;
  blurb: string;
  cost: number; // ~per-call USD estimate, 500 in / 800 out
  tier: 1 | 2 | 3;
  dot: string;
};

const MODELS: Record<ModelId, ModelSpec> = {
  fast: {
    id: 'fast',
    name: 'Haiku',
    blurb: 'Fast & cheap — quick lookups, formatting, short answers',
    cost: 0.005,
    tier: 1,
    dot: '#7BC4E0',
  },
  balanced: {
    id: 'balanced',
    name: 'Sonnet',
    blurb: 'Balanced — nuanced writing, structured analysis',
    cost: 0.014,
    tier: 2,
    dot: '#C8C8CD',
  },
  strong: {
    id: 'strong',
    name: 'Opus',
    blurb: 'Strongest — multi-step reasoning, long code, trade-offs',
    cost: 0.068,
    tier: 3,
    dot: '#E0B86B',
  },
};

const ORDER: ModelId[] = ['fast', 'balanced', 'strong'];

const SAMPLES = [
  "What's the capital of Portugal?",
  'Rewrite this paragraph to sound more confident, no jargon',
  'Refactor this React hook to use Suspense and explain the trade-offs',
];

/* Heuristic stand-in for the on-device classifier. */
function classify(text: string): { model: ModelId; rationale: string } | null {
  const t = text.trim();
  if (t.length < 6) return null;
  const lower = t.toLowerCase();
  const len = t.length;
  const words = t.split(/\s+/).length;

  const codeHit = /\b(refactor|function|hook|component|debug|stack trace|regex|async|typescript|migration|sql|test suite|class\b)\b/.test(lower);
  const reasonHit = /\b(why|trade-?offs?|weigh|evaluate|compare|analy[sz]e|architect|design (the )?system|root cause|step by step|reason)\b/.test(lower);
  const multiStep = /\b(then|after that|also|finally|next,|step \d|and then|followed by)\b/.test(lower) || (t.match(/\?/g)?.length ?? 0) >= 2;
  const longForm = /\b(write|draft) (an? )?(essay|article|spec|proposal|brief|memo|report)\b/.test(lower);
  const simpleLookup = /^(what|when|who|where|how many|define|convert|capital of|spell|translate)\b/.test(lower);
  const formatOnly = /\b(fix typo|uppercase|lowercase|capitali[sz]e|format as|to json|to csv|bullet list|markdown)\b/.test(lower);
  const rephrase = /\b(rewrite|rephrase|polish|tighten|make.*sound|tone down|punch up|edit this)\b/.test(lower);
  const summarise = /\b(summar[iy][sz]e|tl;?dr|recap|key points?)\b/.test(lower);

  let score = 0;
  if (simpleLookup) score -= 2;
  if (formatOnly) score -= 2;
  if (len < 60 && words < 10) score -= 1;
  if (rephrase) score += 0;
  if (summarise) score += 0;
  if (longForm) score += 1;
  if (codeHit) score += 2;
  if (reasonHit) score += 2;
  if (multiStep) score += 1;
  if (len > 280) score += 1;
  if (len > 500) score += 1;

  let model: ModelId;
  let rationale: string;

  if (score <= -2) {
    model = 'fast';
    rationale = simpleLookup ? 'Single-step lookup — Haiku is plenty.' : 'Short formatting task — no need for a bigger model.';
  } else if (score <= 0) {
    model = 'balanced';
    rationale = rephrase
      ? 'Nuanced rewrite — Sonnet handles tone well.'
      : summarise
      ? 'Summary at a normal length — balanced tier fits.'
      : 'Medium complexity — balanced tier is the safe pick.';
  } else if (score <= 2) {
    model = 'balanced';
    rationale = codeHit ? 'Code task — Sonnet handles most of these cleanly.' : 'Looks involved — balanced tier should cope.';
  } else {
    model = 'strong';
    if (codeHit && reasonHit) rationale = 'Code + trade-offs — Opus is worth the spend.';
    else if (reasonHit) rationale = 'Multi-step reasoning — Opus thinks this through.';
    else if (multiStep) rationale = 'Several sub-steps — Opus keeps them straight.';
    else rationale = 'Long, layered ask — Opus gives the best shot at one-go.';
  }

  return { model, rationale };
}

const fmtCost = (c: number) => `${(c * 100).toFixed(1)}¢`;
const fmtDelta = (delta: number) => {
  if (Math.abs(delta) < 0.0005) return 'same cost';
  const sign = delta > 0 ? '+' : '−';
  return `${sign}${fmtCost(Math.abs(delta))}`;
};

export default function ModelRouter({ onSend }: { onSend?: (t: string) => void }) {
  const [text, setText] = useState('');
  // null = auto-routing. A ModelId means the user has pinned that tier.
  const [pinned, setPinned] = useState<ModelId | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [open, setOpen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const lastAutoRef = useRef<ModelId>('balanced');
  const [pillScope, animatePill] = useAnimate();

  const suggestion = useMemo(() => classify(text), [text]);
  const isEmpty = text.trim().length === 0;
  const active = !isEmpty && !submitting;

  const autoModel: ModelId = suggestion?.model ?? 'balanced';
  const effective: ModelId = pinned ?? autoModel;
  const current = MODELS[effective];

  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(Math.max(ta.scrollHeight, 52), 220)}px`;
  }, [text]);

  /* Shake the pill whenever the classifier's pick changes (auto mode only).
     The micro-interaction is the cue that something just re-routed — hover
     reveals the why. */
  useEffect(() => {
    if (pinned) return;
    if (autoModel === lastAutoRef.current) return;
    lastAutoRef.current = autoModel;
    if (pillScope.current) {
      animatePill(
        pillScope.current,
        { x: [0, -4, 4, -3, 3, -1.5, 0] },
        { duration: 0.45, ease: 'easeOut' },
      );
    }
  }, [autoModel, pinned, animatePill, pillScope]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!popRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const submit = async () => {
    if (!active) return;
    setSubmitting(true);
    onSend?.(`[${current.name}] ${text}`);
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

  // Cost delta vs the previous effective model — only meaningful in auto when re-routing.
  const previousModel = lastAutoRef.current;
  const delta = current.cost - MODELS[previousModel].cost;

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

        {/* Textarea */}
        <div className="relative z-10 px-4 pt-3.5">
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

        {/* Toolbar */}
        <div className="relative z-10 flex items-center gap-1.5 px-2.5 pb-2.5 pt-1">
          <div className="ml-auto flex items-center gap-1.5" ref={popRef}>
            {/* Model pill — shakes on auto re-route, hover reveals the why */}
            <div
              className="relative"
              onMouseEnter={() => setHovered(true)}
              onMouseLeave={() => setHovered(false)}
            >
              <motion.button
                ref={pillScope}
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpen((o) => !o);
                }}
                className="flex items-center gap-1.5 rounded-full border border-[#26262B] bg-transparent px-2 py-1 text-[12px] text-[#C8C8CD] transition-colors hover:bg-[#16161A]"
                aria-label={pinned ? `Pinned to ${current.name}` : `Auto-routed to ${current.name}`}
              >
                <motion.span
                  layout
                  className="h-1.5 w-1.5 rounded-full"
                  animate={{ backgroundColor: current.dot }}
                  transition={{ duration: 0.25, ease: EASE }}
                />
                <AnimatePresence mode="popLayout" initial={false}>
                  <motion.span
                    key={current.name}
                    initial={{ y: 6, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ y: -6, opacity: 0 }}
                    transition={{ duration: 0.18, ease: EASE }}
                  >
                    {current.name}
                  </motion.span>
                </AnimatePresence>
                {!pinned && (
                  <span className="rounded-sm bg-[#16161A] px-1 py-px text-[9.5px] uppercase tracking-wide text-[#6A6A72]">
                    auto
                  </span>
                )}
                <svg viewBox="0 0 24 24" className="h-2.5 w-2.5 text-[#6A6A72]" fill="none" stroke="currentColor" strokeWidth={2.4}>
                  <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </motion.button>

              {/* Hover tooltip — quick rationale for whatever the pill is showing */}
              <AnimatePresence>
                {hovered && !open && (
                  <motion.div
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 4, transition: { duration: 0.1 } }}
                    transition={{ duration: 0.16, ease: EASE }}
                    className="pointer-events-none absolute bottom-full right-0 z-20 mb-2 w-[260px] rounded-lg border border-[#2A2A30] p-2.5"
                    style={{ background: '#1F1F22', boxShadow: '0 12px 28px -8px rgba(0,0,0,0.6)' }}
                  >
                    <div className="flex items-center gap-1.5">
                      <span className="h-1.5 w-1.5 rounded-full" style={{ background: current.dot }} />
                      <span className="text-[12px] font-medium text-[#ECECEE]">{current.name}</span>
                      <span className="text-[10px] uppercase tracking-wide text-[#6A6A72]">
                        {pinned ? 'pinned' : 'auto'}
                      </span>
                      <span className="ml-auto tabular-nums text-[11px] text-[#9A9AA2]">{fmtCost(current.cost)}</span>
                    </div>
                    <p className="mt-1.5 text-[11px] leading-snug text-[#C8C8CD]">
                      {pinned
                        ? current.blurb
                        : suggestion
                        ? suggestion.rationale
                        : 'Auto-routing — start typing to see this adjust.'}
                    </p>
                    {!pinned && suggestion && Math.abs(delta) > 0.0005 && previousModel !== effective && (
                      <p className="mt-1 text-[10.5px] text-[#6A6A72]">
                        from {MODELS[previousModel].name} · <span className="text-[#9A9AA2]">{fmtDelta(delta)}</span>
                      </p>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>

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

            {/* Chooser popover */}
            <AnimatePresence>
              {open && (
                <motion.div
                  initial={{ opacity: 0, y: 8, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.1 } }}
                  transition={{ duration: 0.18, ease: EASE }}
                  onClick={(e) => e.stopPropagation()}
                  className="absolute bottom-full right-0 z-30 mb-2.5 w-[300px] rounded-xl border border-[#2A2A30] p-1.5"
                  style={{ background: '#1F1F22', transformOrigin: 'bottom right', boxShadow: '0 20px 48px -12px rgba(0,0,0,0.7)' }}
                >
                  {/* Auto toggle */}
                  <button
                    type="button"
                    onClick={() => {
                      setPinned(null);
                      setOpen(false);
                    }}
                    className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-[#26262B]"
                  >
                    <span className="mt-1 flex h-3 w-3 shrink-0 items-center justify-center">
                      <svg viewBox="0 0 24 24" className="h-3 w-3 text-[#9A9AA2]" fill="none" stroke="currentColor" strokeWidth={2.2}>
                        <path d="M3 12a9 9 0 0 1 15-6.7M21 5v5h-5M21 12a9 9 0 0 1-15 6.7M3 19v-5h5" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <div className="flex items-center gap-1.5">
                        <span className="text-[13px] font-medium text-[#ECECEE]">Auto-route</span>
                        {!pinned && <span className="text-[10px] text-[#5BD0A0]">on</span>}
                      </div>
                      <span className="text-[11px] leading-snug text-[#6A6A72]">
                        {suggestion
                          ? `Currently routing to ${MODELS[autoModel].name} — ${suggestion.rationale.toLowerCase()}`
                          : 'Pick a tier as you type'}
                      </span>
                    </div>
                  </button>

                  <div className="my-1 h-px bg-[#26262B]" />

                  {ORDER.map((id) => {
                    const m = MODELS[id];
                    const isPinned = pinned === id;
                    const isAutoPick = !pinned && autoModel === id;
                    const d = m.cost - current.cost;
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => {
                          setPinned(id);
                          setOpen(false);
                        }}
                        className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-[#26262B]"
                      >
                        <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: m.dot }} />
                        <div className="flex min-w-0 flex-1 flex-col">
                          <div className="flex items-center gap-1.5">
                            <span className="text-[13px] font-medium text-[#ECECEE]">{m.name}</span>
                            {isPinned && <span className="text-[10px] text-[#5BD0A0]">pinned</span>}
                            {isAutoPick && <span className="text-[10px] text-[#9A9AA2]">routing here</span>}
                          </div>
                          <span className="text-[11px] leading-snug text-[#6A6A72]">{m.blurb}</span>
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-0.5 pl-1.5">
                          <span className="tabular-nums text-[11px] text-[#C8C8CD]">{fmtCost(m.cost)}</span>
                          {id !== effective && (
                            <span className="tabular-nums text-[10px] text-[#6A6A72]">{fmtDelta(d)}</span>
                          )}
                        </div>
                      </button>
                    );
                  })}
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
