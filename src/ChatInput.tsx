import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import {
  AnimatePresence,
  motion,
  useAnimationControls,
  useMotionValueEvent,
  useSpring,
} from 'framer-motion';

type Slot = { id: string; label: string; placeholder?: string };
type StarterPrompt = { id: string; label: string; body: string; slots: Slot[] };

const STARTER_PROMPTS: StarterPrompt[] = [
  {
    id: 'summarize',
    label: 'Summarize document',
    body: 'Summarize the document below in 5 concise bullet points, capturing key decisions, risks, and action items. Return the output as a markdown list.',
    slots: [
      { id: 'focus', label: 'Focus on', placeholder: 'e.g. decisions and risks' },
      { id: 'audience', label: 'Audience', placeholder: 'e.g. exec team' },
    ],
  },
  {
    id: 'rewrite',
    label: 'Rewrite for clarity',
    body: 'You are a clear-writing editor. Rewrite the following text — short sentences, plain English, preserved meaning. Return only the rewritten version.',
    slots: [
      { id: 'tone', label: 'Tone', placeholder: 'e.g. friendly, formal, neutral' },
      { id: 'audience', label: 'Audience', placeholder: 'e.g. customers, engineers' },
    ],
  },
  {
    id: 'actions',
    label: 'Extract action items',
    body: 'Extract every action item from the text below. For each, return owner, task, and due date if mentioned. Format the output as a markdown table.',
    slots: [
      { id: 'project', label: 'Project name', placeholder: 'e.g. Q3 launch' },
      { id: 'default_owner', label: 'Default owner if unspecified', placeholder: 'e.g. me' },
    ],
  },
  {
    id: 'explain',
    label: 'Explain simply',
    body: 'You are a patient teacher. Explain the concept below to someone new to the field. Use one short analogy, avoid jargon, and respond in 3 short paragraphs.',
    slots: [
      { id: 'audience', label: 'Audience', placeholder: 'e.g. a new grad' },
      { id: 'length', label: 'Length', placeholder: 'e.g. 2 short paragraphs' },
    ],
  },
  {
    id: 'review',
    label: 'Code review',
    body: 'You are a senior engineer. Review the code below for correctness, readability, and edge cases. For example, flag missing null checks or unclear naming. Return findings as a markdown list.',
    slots: [
      { id: 'language', label: 'Language', placeholder: 'e.g. TypeScript' },
      { id: 'focus', label: 'Focus areas', placeholder: 'e.g. security, performance' },
    ],
  },
  {
    id: 'compare',
    label: 'Compare options',
    body: 'Compare the 2 options below across price, quality, and timeline. Return a markdown table and a one-sentence recommendation.',
    slots: [
      { id: 'criteria', label: 'Criteria that matter most', placeholder: 'e.g. cost, reliability' },
      { id: 'urgency', label: 'Decision urgency', placeholder: 'e.g. this week' },
    ],
  },
  {
    id: 'email',
    label: 'Draft an email',
    body: 'You are a Communications lead. Draft a professional email about the topic below. Keep it under 150 words and format with a clear subject line.',
    slots: [
      { id: 'recipient', label: 'Recipient', placeholder: 'e.g. board members' },
      { id: 'tone', label: 'Tone', placeholder: 'e.g. confident, warm' },
    ],
  },
  {
    id: 'tradeoffs',
    label: 'Analyze tradeoffs',
    body: 'Analyze the tradeoffs in the proposal below. For example, weigh cost vs. speed and risk vs. reward. Return a markdown table: option, pros, cons, recommendation.',
    slots: [
      { id: 'deadline', label: 'Decision deadline', placeholder: 'e.g. end of quarter' },
      { id: 'constraints', label: 'Key constraints', placeholder: 'e.g. fixed budget' },
    ],
  },
];

/* ─────────────────────────────────────────────────────────────────────────
   Scoring engine — six weighted dimensions + anti-pattern penalties.
   Anchored on what's known to make LLM prompts work: a clear scoped ask,
   concrete specs, an output shape, audience/goal, guardrails, and examples.
   Penalties for filler, hedging, and vague directives.
   ───────────────────────────────────────────────────────────────────────── */

type Dim = {
  id: string;
  label: string;
  weight: number;
  score: number;
  hit: boolean;
  hint: string;
};

type Penalty = {
  id: string;
  label: string;
  applied: number;
  hint: string;
};

type ScoreResult = {
  total: number;
  dimensions: Dim[];
  penalties: Penalty[];
};

const HINTS: Record<string, string> = {
  task_clarity:
    'Lead with an imperative on the input — "Summarize the document below"',
  specificity:
    'Quantify the output or name the entity — "in 5 bullet points"',
  output_format:
    'State the output shape — "as a markdown table" or "in JSON"',
  context:
    'Add audience or goal — "for execs" or "the goal is to…"',
  constraints:
    'Add guardrails — tone, things to avoid, or scope',
  examples:
    'Show an example — "for example: …" or a fenced sample',
};

const IMPERATIVE_RE =
  /\b(write|create|analyze|analyse|summarize|summarise|explain|rewrite|extract|translate|generate|review|compare|outline|draft|list|describe|build|design|find|identify|categorize|categorise|classify|evaluate|critique|propose|recommend|suggest|return)\b/i;
const SCOPING_RE =
  /\b(below|above|following|attached|the (document|text|email|code|article|message|passage|content|input|data)|here is|here's)\b/i;
const QUANTIFIED_RE =
  /\b\d+\s+(bullet|point|paragraph|word|sentence|column|item|row|line|step|reason|example|option|idea|page|section)/i;
const LENGTH_LIMIT_RE =
  /\b(under|at most|no more than|maximum|max|within|≤|<=)\s+\d+\s*(word|character|paragraph|sentence|line|page)/i;
const PROPER_NOUN_RE = /[a-z]\s+[A-Z][a-z]{2,}/;
const QUOTED_RE = /["'`][^"'`]{5,}["'`]/;
const FENCED_RE = /```/;
const FORMAT_KEYWORD_RE =
  /\b(markdown|json|yaml|table|list|csv|html|xml|bullet|outline)\b/i;
const STRUCTURE_RE =
  /\b(return only|respond in|format as|in the form of|with columns?|with fields?|structured? as|grouped by|labelled|labeled)\b/i;
const AUDIENCE_RE =
  /\b(for (a |the |an )?(\w+ )?(engineer|developer|exec|customer|user|reader|audience|junior|senior|student|beginner|expert|stakeholder)|audience:|for our|for my)\b/i;
const GOAL_RE =
  /\b(the goal is|the purpose is|we need to|in order to|so that|so we can|to help (us|me))\b/i;
const NEGATIVE_CONSTRAINT_RE =
  /\b(don't|do not|avoid|exclude|without|no preamble|no commentary|no apologies)\b/i;
const TONE_RE =
  /\b(tone|formal|casual|warm|neutral|professional|friendly|concise|terse|verbose|playful)\b/i;
const EXAMPLE_PHRASE_RE = /\b(for example|e\.g\.|example:|sample:|such as)\b/i;

const FILLER_RE =
  /\b(please|kindly|if you can|if you could|if you don't mind|i'd appreciate|i would appreciate|thanks in advance)\b/gi;
const HEDGING_RE =
  /\b(maybe|perhaps|kind of|kinda|sort of|sorta|i think|i guess|possibly|might be)\b/gi;
const VAGUE_DIRECTIVE_RE =
  /\b(do your best|be creative|do whatever|figure it out|as you see fit|as you like|use your judgement|use your judgment)\b/i;

function firstSentence(text: string): string {
  const t = text.trim();
  const m = t.match(/^[^.!?\n]+/);
  return m ? m[0] : t.slice(0, 200);
}

function emptyDims(): Dim[] {
  return [
    { id: 'task_clarity', label: 'Task clarity', weight: 25, score: 0, hit: false, hint: HINTS.task_clarity },
    { id: 'specificity', label: 'Specificity', weight: 20, score: 0, hit: false, hint: HINTS.specificity },
    { id: 'output_format', label: 'Output format', weight: 20, score: 0, hit: false, hint: HINTS.output_format },
    { id: 'context', label: 'Context', weight: 15, score: 0, hit: false, hint: HINTS.context },
    { id: 'constraints', label: 'Constraints', weight: 10, score: 0, hit: false, hint: HINTS.constraints },
    { id: 'examples', label: 'Examples', weight: 10, score: 0, hit: false, hint: HINTS.examples },
  ];
}

function scorePrompt(text: string): ScoreResult {
  if (text.length === 0) {
    return { total: 0, dimensions: emptyDims(), penalties: [] };
  }

  const firstSent = firstSentence(text);

  // 1. Task clarity (25): imperative-in-first-sentence + scoped input reference.
  let taskScore = 0;
  if (IMPERATIVE_RE.test(firstSent)) taskScore += 15;
  if (SCOPING_RE.test(text)) taskScore += 10;

  // 2. Specificity (20): quantified output, named entity/digit, delimited input.
  let specScore = 0;
  if (QUANTIFIED_RE.test(text) || LENGTH_LIMIT_RE.test(text)) specScore += 10;
  if (PROPER_NOUN_RE.test(text) || /\b\d+\b/.test(text)) specScore += 5;
  if (QUOTED_RE.test(text) || FENCED_RE.test(text)) specScore += 5;

  // 3. Output format (20): explicit format keyword + structural specification.
  let formatScore = 0;
  if (FORMAT_KEYWORD_RE.test(text)) formatScore += 10;
  if (STRUCTURE_RE.test(text)) formatScore += 10;

  // 4. Context (15): audience and/or goal/success criteria.
  let contextScore = 0;
  if (AUDIENCE_RE.test(text)) contextScore += 8;
  if (GOAL_RE.test(text)) contextScore += 7;

  // 5. Constraints (10): negative constraints and/or tone/voice.
  let constraintsScore = 0;
  if (NEGATIVE_CONSTRAINT_RE.test(text)) constraintsScore += 5;
  if (TONE_RE.test(text)) constraintsScore += 5;

  // 6. Examples (10): named example phrase + actual fenced/quoted exemplar.
  let exampleScore = 0;
  if (EXAMPLE_PHRASE_RE.test(text)) exampleScore += 5;
  if (FENCED_RE.test(text)) exampleScore += 5;

  // Penalties
  const fillerCount = (text.match(FILLER_RE) || []).length;
  const fillerPenalty = Math.min(fillerCount * 2, 6);
  const hedgingCount = (text.match(HEDGING_RE) || []).length;
  const hedgingPenalty = Math.min(hedgingCount * 3, 6);
  const vaguePenalty = VAGUE_DIRECTIVE_RE.test(text) ? 4 : 0;

  const raw =
    taskScore + specScore + formatScore + contextScore + constraintsScore + exampleScore;
  const total = Math.max(0, Math.min(100, raw - fillerPenalty - hedgingPenalty - vaguePenalty));

  const dimensions: Dim[] = [
    { id: 'task_clarity', label: 'Task clarity', weight: 25, score: taskScore, hit: taskScore >= 18, hint: HINTS.task_clarity },
    { id: 'specificity', label: 'Specificity', weight: 20, score: specScore, hit: specScore >= 14, hint: HINTS.specificity },
    { id: 'output_format', label: 'Output format', weight: 20, score: formatScore, hit: formatScore >= 14, hint: HINTS.output_format },
    { id: 'context', label: 'Context', weight: 15, score: contextScore, hit: contextScore >= 11, hint: HINTS.context },
    { id: 'constraints', label: 'Constraints', weight: 10, score: constraintsScore, hit: constraintsScore >= 7, hint: HINTS.constraints },
    { id: 'examples', label: 'Examples', weight: 10, score: exampleScore, hit: exampleScore >= 7, hint: HINTS.examples },
  ];

  const penalties: Penalty[] = [];
  if (fillerPenalty > 0)
    penalties.push({ id: 'filler', label: 'Filler / politeness', applied: fillerPenalty, hint: 'Drop "please", "kindly", "if you can" — tokens, not signal' });
  if (hedgingPenalty > 0)
    penalties.push({ id: 'hedging', label: 'Hedging language', applied: hedgingPenalty, hint: 'Remove "maybe", "kind of", "I think" — be direct' });
  if (vaguePenalty > 0)
    penalties.push({ id: 'vague', label: 'Vague directive', applied: vaguePenalty, hint: 'Replace "do your best" with concrete criteria' });

  return { total, dimensions, penalties };
}

// 4-tier thresholds: Underspecified < 30, Workable < 55, Solid < 80, Excellent.
function thresholdLevel(score: number): 0 | 1 | 2 | 3 {
  if (score < 30) return 0;
  if (score < 55) return 1;
  if (score < 80) return 2;
  return 3;
}

function colorForScore(score: number): string {
  if (score < 30) return '#E07A7A';
  if (score < 55) return '#E0B86B';
  return '#5BD0A0';
}

function colorForTokens(tokens: number): string {
  if (tokens > 4000) return '#E07A7A';
  if (tokens > 1000) return '#E0B86B';
  return '#6A6A72';
}

const EASE = [0.22, 1, 0.36, 1] as const;
const SPRING = { type: 'spring' as const, stiffness: 320, damping: 28 };

function ArrowUpIcon({ className = 'w-3.5 h-3.5' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" />
    </svg>
  );
}

function ChevronDownIcon({ className = 'w-3 h-3' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M4 6.5l4 4 4-4" />
    </svg>
  );
}

function ChevronLeftIcon({ className = 'w-3 h-3' }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10 4L6 8l4 4" />
    </svg>
  );
}

export default function ChatInput({ onSend }: { onSend?: (text: string) => void }) {
  const [text, setText] = useState('');
  const [startersOpen, setStartersOpen] = useState(false);
  const [configStarterId, setConfigStarterId] = useState<string | null>(null);
  const [draggingChipId, setDraggingChipId] = useState<string | null>(null);
  const [isOverTextarea, setIsOverTextarea] = useState(false);
  const [showRubric, setShowRubric] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pulseToken, setPulseToken] = useState<number | null>(null);
  // contexts: { [starterId]: { [slotId]: value } }
  const [contexts, setContexts] = useState<Record<string, Record<string, string>>>({});

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const startersRef = useRef<HTMLDivElement>(null);
  const pendingCaretRef = useRef<number | null>(null);
  const prevThresholdRef = useRef<0 | 1 | 2 | 3>(0);
  const prevHasTextRef = useRef(false);
  const popControls = useAnimationControls();
  const wellControls = useAnimationControls();

  const { total: score, dimensions, penalties } = useMemo(
    () => scorePrompt(text),
    [text],
  );
  const tokens = Math.ceil(text.length / 4);
  const barColor = colorForScore(score);
  const trimmed = text.trim();
  const isEmpty = text.length === 0;
  const active = trimmed.length > 0 && !isSubmitting;

  const scoreSpring = useSpring(0, { stiffness: 200, damping: 26 });
  const [displayScore, setDisplayScore] = useState(0);
  useMotionValueEvent(scoreSpring, 'change', (v) => setDisplayScore(Math.round(v)));
  useEffect(() => {
    scoreSpring.set(score);
  }, [score, scoreSpring]);

  const tokensSpring = useSpring(0, { stiffness: 240, damping: 28 });
  const [displayTokens, setDisplayTokens] = useState(0);
  useMotionValueEvent(tokensSpring, 'change', (v) => setDisplayTokens(Math.round(v)));
  useEffect(() => {
    tokensSpring.set(tokens);
  }, [tokens, tokensSpring]);

  useEffect(() => {
    const level = thresholdLevel(score);
    if (level > prevThresholdRef.current) {
      setPulseToken(Date.now());
    }
    prevThresholdRef.current = level;
  }, [score]);

  useEffect(() => {
    if (active && !prevHasTextRef.current) {
      popControls.start({ scale: [0.96, 1] }, { duration: 0.24, ease: EASE });
    }
    prevHasTextRef.current = active;
  }, [active, popControls]);

  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    const next = Math.min(Math.max(ta.scrollHeight, 84), 260);
    ta.style.height = `${next}px`;
  }, [text]);

  useEffect(() => {
    if (pendingCaretRef.current !== null && textareaRef.current) {
      const pos = pendingCaretRef.current;
      textareaRef.current.focus();
      textareaRef.current.setSelectionRange(pos, pos);
      pendingCaretRef.current = null;
    }
  }, [text]);

  useEffect(() => {
    if (!startersOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!startersRef.current?.contains(e.target as Node)) {
        setStartersOpen(false);
        setConfigStarterId(null);
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [startersOpen]);

  const insertAtCaret = (insertion: string) => {
    const ta = textareaRef.current;
    if (!ta || text.length === 0) {
      setText(insertion);
      pendingCaretRef.current = insertion.length;
      return;
    }
    const start = ta.selectionStart ?? text.length;
    const end = ta.selectionEnd ?? text.length;
    const next = text.slice(0, start) + insertion + text.slice(end);
    setText(next);
    pendingCaretRef.current = start + insertion.length;
  };

  const buildFinalText = (p: StarterPrompt): string => {
    const ctx = contexts[p.id] || {};
    const filled = p.slots
      .map((s) => ({ slot: s, value: (ctx[s.id] || '').trim() }))
      .filter((x) => x.value.length > 0);
    if (filled.length === 0) return p.body;
    const lines = filled.map((x) => `- ${x.slot.label}: ${x.value}`).join('\n');
    return `${p.body}\n\nPersonal context:\n${lines}`;
  };

  const setSlotValue = (starterId: string, slotId: string, value: string) => {
    setContexts((prev) => ({
      ...prev,
      [starterId]: { ...(prev[starterId] || {}), [slotId]: value },
    }));
  };

  const pointInTextarea = (x: number, y: number) => {
    const r = textareaRef.current?.getBoundingClientRect();
    if (!r) return false;
    return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
  };

  const submit = async () => {
    if (!active) return;
    setIsSubmitting(true);
    onSend?.(text);
    await new Promise((r) => setTimeout(r, 140));
    setText('');
    setIsSubmitting(false);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const configStarter = useMemo(
    () =>
      configStarterId
        ? STARTER_PROMPTS.find((s) => s.id === configStarterId) ?? null
        : null,
    [configStarterId],
  );

  return (
    <motion.div
      layout
      transition={{ layout: { duration: 0.22, ease: EASE } }}
      className="relative w-full max-w-2xl rounded-xl border border-[#26262B] text-[#ECECEE] flex flex-col"
      style={{
        background: '#1A1A1D',
        boxShadow: '0 1px 0 rgba(0,0,0,0.5), 0 12px 28px -16px rgba(0,0,0,0.7)',
      }}
    >
      {/* Ambient border shimmer */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 overflow-hidden rounded-xl"
        style={{
          padding: 1,
          WebkitMask:
            'linear-gradient(#000, #000) content-box, linear-gradient(#000, #000)',
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

      {/* Textarea region */}
      <motion.div animate={wellControls} className="relative px-4 pt-4 pb-1">
        <motion.div
          animate={{ opacity: isSubmitting ? 0 : 1 }}
          transition={{ duration: 0.13 }}
          className="relative"
        >
          <textarea
            ref={textareaRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={3}
            className="w-full resize-none bg-transparent text-[14px] leading-relaxed text-[#ECECEE] outline-none placeholder:text-[#5A5A60]"
            style={{ minHeight: 84, maxHeight: 260 }}
          />
        </motion.div>

        <AnimatePresence>
          {isOverTextarea && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.16 }}
              className="pointer-events-none absolute inset-2 rounded-md"
              style={{ boxShadow: 'inset 0 0 0 1px rgba(91,208,160,0.45)' }}
            />
          )}
        </AnimatePresence>
      </motion.div>

      {/* Footer */}
      <div className="relative flex items-center gap-2 px-2.5 pb-2.5 pt-1">
        {/* Starters dropdown */}
        <div ref={startersRef} className="relative">
          <motion.button
            type="button"
            onClick={() => {
              setStartersOpen((o) => !o);
              setConfigStarterId(null);
            }}
            aria-label="Starter prompts"
            aria-expanded={startersOpen}
            whileTap={{ scale: 0.98 }}
            animate={{
              backgroundColor: startersOpen ? '#222227' : 'rgba(34,34,39,0)',
              color: startersOpen ? '#ECECEE' : '#9A9AA2',
            }}
            transition={{ duration: 0.15 }}
            className="flex items-center gap-1 rounded-md px-1.5 py-1 text-[13px] hover:!bg-[#222227] hover:!text-[#ECECEE]"
          >
            <span>Starters</span>
            <ChevronDownIcon className="w-3 h-3 opacity-70" />
          </motion.button>

          <AnimatePresence>
            {startersOpen && (
              <motion.div
                initial={{ opacity: 0, y: 6, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, transition: { duration: 0.1 } }}
                transition={{ duration: 0.16, ease: EASE }}
                className="absolute bottom-full left-0 z-30 mb-2 w-80 overflow-hidden rounded-lg border border-[#26262B]"
                style={{
                  background: '#1F1F22',
                  transformOrigin: 'bottom left',
                  boxShadow:
                    '0 16px 40px -8px rgba(0,0,0,0.65), 0 4px 12px -2px rgba(0,0,0,0.4)',
                }}
              >
                <AnimatePresence mode="wait" initial={false}>
                  {configStarter ? (
                    <motion.div
                      key="config"
                      initial={{ opacity: 0, x: 14 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: 14 }}
                      transition={{ duration: 0.18, ease: EASE }}
                      className="p-2"
                    >
                      {/* Header with back button */}
                      <button
                        type="button"
                        onClick={() => setConfigStarterId(null)}
                        className="mb-2 flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-[12px] text-[#9A9AA2] hover:bg-[#222227] hover:text-[#ECECEE]"
                      >
                        <ChevronLeftIcon className="w-3 h-3" />
                        <span>Starters</span>
                      </button>
                      <div className="mb-2.5 px-1.5 text-[13px] text-[#ECECEE]">
                        {configStarter.label}
                      </div>

                      {/* Slot inputs */}
                      <div className="flex flex-col gap-2">
                        {configStarter.slots.map((slot) => (
                          <div key={slot.id} className="flex flex-col gap-1 px-1.5">
                            <label className="text-[11px] text-[#9A9AA2]">
                              {slot.label}
                            </label>
                            <input
                              type="text"
                              value={contexts[configStarter.id]?.[slot.id] || ''}
                              onChange={(e) =>
                                setSlotValue(configStarter.id, slot.id, e.target.value)
                              }
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  insertAtCaret(buildFinalText(configStarter));
                                  setStartersOpen(false);
                                  setConfigStarterId(null);
                                }
                              }}
                              placeholder={slot.placeholder}
                              className="w-full rounded-md border border-transparent bg-[#16161A] px-2 py-1.5 text-[13px] text-[#ECECEE] outline-none placeholder:text-[#5A5A60] focus:border-[#3A3A40]"
                            />
                          </div>
                        ))}
                      </div>

                      {/* Action row */}
                      <div className="mt-3 flex items-center justify-between px-1.5">
                        <span className="text-[11px] text-[#6A6A72]">
                          Leave fields empty to skip
                        </span>
                        <motion.button
                          type="button"
                          whileTap={{ scale: 0.97 }}
                          transition={SPRING}
                          onClick={() => {
                            insertAtCaret(buildFinalText(configStarter));
                            setStartersOpen(false);
                            setConfigStarterId(null);
                          }}
                          className="rounded-md bg-[#2E2E33] px-2.5 py-1 text-[12.5px] text-[#ECECEE] hover:bg-[#3A3A40]"
                        >
                          Use prompt
                        </motion.button>
                      </div>
                    </motion.div>
                  ) : (
                    <motion.div
                      key="list"
                      initial={{ opacity: 0, x: -14 }}
                      animate={{ opacity: 1, x: 0 }}
                      exit={{ opacity: 0, x: -14 }}
                      transition={{ duration: 0.18, ease: EASE }}
                      className="p-1"
                    >
                      <motion.ul
                        className="flex flex-col"
                        initial="hidden"
                        animate="show"
                        variants={{ show: { transition: { staggerChildren: 0.02 } } }}
                      >
                        {STARTER_PROMPTS.map((p) => {
                          const ctxFilled = Object.values(contexts[p.id] || {}).some(
                            (v) => v.trim().length > 0,
                          );
                          return (
                            <motion.li
                              key={p.id}
                              className="relative"
                              variants={{
                                hidden: { opacity: 0, y: 3 },
                                show: {
                                  opacity: 1,
                                  y: 0,
                                  transition: { duration: 0.15, ease: EASE },
                                },
                              }}
                            >
                              {draggingChipId === p.id && (
                                <div
                                  className="absolute inset-0 rounded-md pointer-events-none"
                                  style={{ background: 'rgba(255,255,255,0.03)' }}
                                />
                              )}
                              <motion.button
                                type="button"
                                drag
                                dragSnapToOrigin
                                dragElastic={0.03}
                                dragMomentum={false}
                                whileHover={{ backgroundColor: '#222227' }}
                                whileTap={{ scale: 0.98 }}
                                whileDrag={{
                                  scale: 1.02,
                                  zIndex: 50,
                                  cursor: 'grabbing',
                                }}
                                transition={SPRING}
                                onDragStart={() => setDraggingChipId(p.id)}
                                onDrag={(_, info) =>
                                  setIsOverTextarea(
                                    pointInTextarea(info.point.x, info.point.y),
                                  )
                                }
                                onDragEnd={(_, info) => {
                                  const over = pointInTextarea(
                                    info.point.x,
                                    info.point.y,
                                  );
                                  setIsOverTextarea(false);
                                  setDraggingChipId(null);
                                  if (over) {
                                    insertAtCaret(buildFinalText(p));
                                    setStartersOpen(false);
                                    setConfigStarterId(null);
                                    wellControls.start(
                                      { scale: [1, 1.004, 1] },
                                      { duration: 0.26, ease: EASE },
                                    );
                                  }
                                }}
                                onClick={() => setConfigStarterId(p.id)}
                                className="flex w-full cursor-grab select-none items-center justify-between rounded-md px-2 py-1.5 text-left text-[13px] text-[#C8C8CD]"
                                style={{ background: 'transparent' }}
                              >
                                <span>{p.label}</span>
                                <span className="flex items-center gap-1.5 text-[#6A6A72]">
                                  {ctxFilled && (
                                    <span
                                      className="h-1 w-1 rounded-full"
                                      style={{ background: '#5BD0A0' }}
                                      aria-label="Personal context saved"
                                    />
                                  )}
                                  <ChevronLeftIcon className="w-3 h-3 rotate-180 opacity-60" />
                                </span>
                              </motion.button>
                            </motion.li>
                          );
                        })}
                      </motion.ul>
                      <div className="mt-1 border-t border-[#26262B] px-2 pt-1.5 pb-1 text-[11px] text-[#6A6A72]">
                        Click to configure · drag to use directly
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Radial quality meter */}
        <AnimatePresence>
          {!isEmpty && (
            <motion.div
              key="meter"
              initial={{ opacity: 0, scale: 0.85, x: -6 }}
              animate={{ opacity: 1, scale: 1, x: 0 }}
              exit={{ opacity: 0, scale: 0.85, x: -6 }}
              transition={{ duration: 0.22, ease: EASE }}
              className="relative ml-1 flex items-center gap-1.5"
              onMouseEnter={() => setShowRubric(true)}
              onMouseLeave={() => setShowRubric(false)}
            >
              <svg width="22" height="22" viewBox="0 0 24 24" className="flex-none">
                <circle
                  cx="12"
                  cy="12"
                  r="9"
                  fill="none"
                  stroke="#2A2A2F"
                  strokeWidth="2"
                />
                <g transform="rotate(-90 12 12)">
                  <motion.circle
                    cx="12"
                    cy="12"
                    r="9"
                    fill="none"
                    strokeWidth="2"
                    strokeLinecap="round"
                    pathLength={1}
                    initial={{ pathLength: 0 }}
                    animate={{ pathLength: score / 100, stroke: barColor }}
                    transition={{
                      pathLength: { duration: 0.26, ease: EASE },
                      stroke: { duration: 0.4 },
                    }}
                  />
                  <AnimatePresence>
                    {pulseToken !== null && (
                      <motion.circle
                        key={pulseToken}
                        cx="12"
                        cy="12"
                        r="9"
                        fill="none"
                        strokeWidth="2"
                        strokeLinecap="round"
                        stroke={barColor}
                        pathLength={1}
                        style={{ transformOrigin: '12px 12px' }}
                        initial={{ pathLength: score / 100, opacity: 0.7, scale: 1 }}
                        animate={{
                          scale: [1, 1.35, 1],
                          opacity: [0.7, 0.95, 0],
                        }}
                        transition={{ duration: 0.34, ease: EASE }}
                        onAnimationComplete={() => setPulseToken(null)}
                      />
                    )}
                  </AnimatePresence>
                </g>
              </svg>
              <motion.span
                className="cursor-default text-[12px] tabular-nums"
                animate={{ color: barColor }}
                transition={{ duration: 0.4 }}
              >
                {displayScore}%
              </motion.span>

              <AnimatePresence>
                {showRubric && (
                  <motion.div
                    initial={{ opacity: 0, y: 6, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, transition: { duration: 0.1 } }}
                    transition={{ duration: 0.16, ease: EASE }}
                    className="absolute bottom-full left-1/2 z-30 mb-2 w-80 -translate-x-1/2 rounded-lg border border-[#26262B] p-2.5"
                    style={{
                      background: '#1F1F22',
                      transformOrigin: 'bottom center',
                      boxShadow:
                        '0 16px 40px -8px rgba(0,0,0,0.65), 0 4px 12px -2px rgba(0,0,0,0.4)',
                    }}
                  >
                    <motion.ul
                      className="flex flex-col gap-1.5"
                      initial="hidden"
                      animate="show"
                      variants={{ show: { transition: { staggerChildren: 0.02 } } }}
                    >
                      {dimensions.map((d) => (
                        <motion.li
                          key={d.id}
                          variants={{
                            hidden: { opacity: 0, y: 4 },
                            show: {
                              opacity: 1,
                              y: 0,
                              transition: { duration: 0.16, ease: EASE },
                            },
                          }}
                          className="flex flex-col text-[12px]"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <span className="flex items-center gap-2">
                              <span
                                className="inline-flex h-3 w-3 items-center justify-center rounded-full text-[9px]"
                                style={{
                                  background: d.hit ? '#5BD0A0' : 'transparent',
                                  color: d.hit ? '#18181B' : '#5A5A60',
                                  border: d.hit ? 'none' : '1px solid #2E2E33',
                                }}
                              >
                                {d.hit ? '✓' : ''}
                              </span>
                              <span className="text-[#C8C8CD]">{d.label}</span>
                            </span>
                            <span className="tabular-nums text-[#6A6A72]">
                              {d.score}/{d.weight}
                            </span>
                          </div>
                          {d.score < d.weight && (
                            <div className="mt-0.5 pl-5 text-[11px] leading-snug text-[#6A6A72]">
                              {d.hint}
                            </div>
                          )}
                        </motion.li>
                      ))}
                      {penalties.length > 0 && (
                        <>
                          <li className="my-1 h-px bg-[#26262B]" aria-hidden />
                          {penalties.map((p) => (
                            <motion.li
                              key={p.id}
                              variants={{
                                hidden: { opacity: 0, y: 4 },
                                show: {
                                  opacity: 1,
                                  y: 0,
                                  transition: { duration: 0.16, ease: EASE },
                                },
                              }}
                              className="flex flex-col text-[12px]"
                            >
                              <div className="flex items-center justify-between gap-3">
                                <span className="flex items-center gap-2">
                                  <span
                                    className="inline-flex h-3 w-3 items-center justify-center rounded-full text-[9px] font-medium"
                                    style={{ background: '#E07A7A', color: '#1F1F22' }}
                                  >
                                    !
                                  </span>
                                  <span className="text-[#C8C8CD]">{p.label}</span>
                                </span>
                                <span
                                  className="tabular-nums"
                                  style={{ color: '#E07A7A' }}
                                >
                                  −{p.applied}
                                </span>
                              </div>
                              <div className="mt-0.5 pl-5 text-[11px] leading-snug text-[#6A6A72]">
                                {p.hint}
                              </div>
                            </motion.li>
                          ))}
                        </>
                      )}
                    </motion.ul>
                  </motion.div>
                )}
              </AnimatePresence>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Tokens */}
        <AnimatePresence>
          {!isEmpty && (
            <motion.span
              key="tokens"
              initial={{ opacity: 0, x: -4 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -4 }}
              transition={{ duration: 0.2, ease: EASE }}
              className="ml-1 text-[12px] tabular-nums"
              style={{ color: colorForTokens(tokens) }}
            >
              ~{displayTokens.toLocaleString()} tokens
            </motion.span>
          )}
        </AnimatePresence>

        {/* Send */}
        <motion.div animate={popControls} className="ml-auto">
          <motion.button
            type="button"
            onClick={submit}
            disabled={!active}
            aria-label="Send"
            whileTap={active ? { scale: 0.94 } : undefined}
            animate={{
              backgroundColor: active ? '#3A3A40' : '#222227',
              color: active ? '#ECECEE' : '#5A5A60',
            }}
            transition={{
              backgroundColor: { duration: 0.22, ease: EASE },
              color: { duration: 0.22, ease: EASE },
              scale: SPRING,
            }}
            className="flex h-7 w-7 items-center justify-center rounded-full disabled:cursor-not-allowed"
          >
            <ArrowUpIcon />
          </motion.button>
        </motion.div>
      </div>
    </motion.div>
  );
}
