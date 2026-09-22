import React, {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  motion,
  AnimatePresence,
  animate,
  useAnimationControls,
} from 'framer-motion';

/* ─────────────────────────────────────────────────────────────────────────
   Types
   ───────────────────────────────────────────────────────────────────────── */

type RubricItem = {
  label: string;
  score: number;
  max: number;
  hit: boolean;
};

type ScoreResult = { total: number; rubric: RubricItem[] };

type HighlightType = 'verb' | 'format' | 'spec' | 'example' | 'role';

type Highlight = {
  start: number;
  end: number;
  type: HighlightType;
  label: string;
};

type Starter = { id: string; label: string; body: string };

/* ─────────────────────────────────────────────────────────────────────────
   Rubric heuristics — single source of truth for all three variants.
   Weights: 30 + 15 + 15 + 15 + 15 + 10 = 100.
     - Length:        ramps to 30 by 80 chars, flat to 400, tapers to 20.
     - Clear ask:     imperative verb keyword.
     - Output format: format/output/return/table/json/markdown/bullet/...
     - Specificity:   digit OR mid-sentence capitalised word OR "quoted str".
     - Example:       "for example" family OR triple-backtick code fence.
     - Role:          "you are" / "act as" / "your role" / "persona".
   ───────────────────────────────────────────────────────────────────────── */

const VERB_RE =
  /\b(write|create|analyze|summarize|explain|rewrite|extract|translate|generate|review|compare|outline|draft|list|describe|build|design)\b/gi;
const FORMAT_RE =
  /\b(format|output|return|respond in|as a list|in json|in markdown|bullet|table)\b/gi;
const EXAMPLE_RE = /(for example|e\.g\.|example:|sample:)/gi;
const ROLE_RE = /(you are|act as|your role|persona)/gi;
const DIGIT_RE = /\b\d+\b/g;
const QUOTE_RE = /"[^"]{2,}"/g;
const CAP_RE = /\b([A-Z][a-z]+)\b/g;
const FENCE_RE = /```[\s\S]*?(```|$)/g;

function scoreLength(len: number): number {
  if (len === 0) return 0;
  if (len < 80) return (len / 80) * 30;
  if (len <= 400) return 30;
  const over = len - 400;
  return Math.max(20, 30 - (over / 400) * 10);
}

function reTest(re: RegExp, text: string): boolean {
  re.lastIndex = 0;
  const r = re.test(text);
  re.lastIndex = 0;
  return r;
}

function hasMidCap(text: string): boolean {
  CAP_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CAP_RE.exec(text)) !== null) {
    if (m.index === 0) continue;
    const before = text.slice(Math.max(0, m.index - 3), m.index);
    if (!/[.!?]\s*$/.test(before)) {
      CAP_RE.lastIndex = 0;
      return true;
    }
  }
  CAP_RE.lastIndex = 0;
  return false;
}

function scorePrompt(text: string): ScoreResult {
  const len = text.length;
  const lenScore = scoreLength(len);

  const hasVerb = reTest(VERB_RE, text);
  const hasFormat = reTest(FORMAT_RE, text);
  const hasDigit = /\d/.test(text);
  const hasQuote = reTest(QUOTE_RE, text);
  const hasSpec = hasDigit || hasQuote || hasMidCap(text);
  const hasExampleText = reTest(EXAMPLE_RE, text);
  const hasCodeFence = text.includes('```');
  const hasExample = hasExampleText || hasCodeFence;
  const hasRole = reTest(ROLE_RE, text);

  const rubric: RubricItem[] = [
    { label: 'Length', score: lenScore, max: 30, hit: lenScore > 1 },
    { label: 'Clear ask', score: hasVerb ? 15 : 0, max: 15, hit: hasVerb },
    { label: 'Output format', score: hasFormat ? 15 : 0, max: 15, hit: hasFormat },
    { label: 'Specificity', score: hasSpec ? 15 : 0, max: 15, hit: hasSpec },
    { label: 'Example', score: hasExample ? 15 : 0, max: 15, hit: hasExample },
    { label: 'Role', score: hasRole ? 10 : 0, max: 10, hit: hasRole },
  ];

  const total = Math.max(
    0,
    Math.min(100, Math.round(rubric.reduce((a, b) => a + b.score, 0)))
  );
  return { total, rubric };
}

function getHighlights(text: string): Highlight[] {
  const out: Highlight[] = [];

  const pushAll = (re: RegExp, type: HighlightType, label: string) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      out.push({ start: m.index, end: m.index + m[0].length, type, label });
    }
  };

  pushAll(VERB_RE, 'verb', 'Clear ask');
  pushAll(FORMAT_RE, 'format', 'Output format');
  pushAll(DIGIT_RE, 'spec', 'Specificity');
  pushAll(QUOTE_RE, 'spec', 'Specificity');
  pushAll(EXAMPLE_RE, 'example', 'Example');
  pushAll(FENCE_RE, 'example', 'Example');
  pushAll(ROLE_RE, 'role', 'Role');

  // Mid-sentence capitals: not the first word, not right after .!?
  CAP_RE.lastIndex = 0;
  let cm: RegExpExecArray | null;
  while ((cm = CAP_RE.exec(text)) !== null) {
    if (cm.index === 0) continue;
    const before = text.slice(Math.max(0, cm.index - 3), cm.index);
    if (/[.!?]\s*$/.test(before)) continue;
    out.push({
      start: cm.index,
      end: cm.index + cm[0].length,
      type: 'spec',
      label: 'Specificity',
    });
  }
  CAP_RE.lastIndex = 0;

  out.sort((a, b) => a.start - b.start || b.end - a.end);

  const filtered: Highlight[] = [];
  let lastEnd = -1;
  for (const h of out) {
    if (h.start >= lastEnd) {
      filtered.push(h);
      lastEnd = h.end;
    }
  }
  return filtered;
}

/* ─────────────────────────────────────────────────────────────────────────
   Smooth red → amber → green interpolation. Never snaps across thresholds.
   ───────────────────────────────────────────────────────────────────────── */

const COLOR_RED: [number, number, number] = [224, 122, 122];
const COLOR_AMBER: [number, number, number] = [224, 184, 107];
const COLOR_GREEN: [number, number, number] = [91, 208, 160];

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const toHex = (n: number) => Math.round(n).toString(16).padStart(2, '0');

function scoreColor(score: number): string {
  const s = Math.max(0, Math.min(100, score));
  let c: [number, number, number];
  if (s <= 50) {
    const t = s / 50;
    c = [
      lerp(COLOR_RED[0], COLOR_AMBER[0], t),
      lerp(COLOR_RED[1], COLOR_AMBER[1], t),
      lerp(COLOR_RED[2], COLOR_AMBER[2], t),
    ];
  } else {
    const t = (s - 50) / 50;
    c = [
      lerp(COLOR_AMBER[0], COLOR_GREEN[0], t),
      lerp(COLOR_AMBER[1], COLOR_GREEN[1], t),
      lerp(COLOR_AMBER[2], COLOR_GREEN[2], t),
    ];
  }
  return `#${toHex(c[0])}${toHex(c[1])}${toHex(c[2])}`;
}

/* ─────────────────────────────────────────────────────────────────────────
   Starter prompts — each is engineered to light up most of the rubric.
   ───────────────────────────────────────────────────────────────────────── */

const STARTERS: Starter[] = [
  {
    id: 'reviewer',
    label: 'Code review',
    body:
      'You are a senior engineer. Review the following TypeScript code for bugs, performance issues, and security risks. Return findings as a markdown table with columns: File, Line, Severity (1-3), and Description. For example:\n\n```ts\nfunction parse(input: string) { return JSON.parse(input); }\n```',
  },
  {
    id: 'summarize',
    label: 'Summarize',
    body:
      'Summarize the meeting notes below into 5 bullet points. Focus on decisions and action items. Format each bullet as: "Decision/Action — Owner — Deadline". For example: "Migrate to Postgres — Sarah — May 30".',
  },
  {
    id: 'rewrite',
    label: 'Rewrite tone',
    body:
      'Act as an experienced editor. Rewrite the paragraph below in a more professional tone. Keep the output under 100 words. Return only the rewritten paragraph in markdown. Example tone: corporate but warm.',
  },
  {
    id: 'extract',
    label: 'Extract data',
    body:
      'You are a data extraction agent. Extract all dates, dollar amounts, and proper names from the text. Return as JSON in this format: {"dates": [], "amounts": [], "names": []}. For example: {"dates": ["2026-05-19"], "amounts": ["$1,200"], "names": ["Acme Corp"]}.',
  },
  {
    id: 'translate',
    label: 'Translate',
    body:
      'Translate the following English text into French. Preserve formatting and tone. Return the translation only, in markdown. Example: "Hello world" should become "Bonjour le monde".',
  },
  {
    id: 'plan',
    label: 'Plan a feature',
    body:
      'Act as a senior product manager. Draft a 6-step implementation plan for adding 2FA to a SaaS dashboard. Output as a numbered list. Each step should include goal, owner, and estimated days. For example: "1. API endpoints — Backend — 3 days".',
  },
  {
    id: 'compare',
    label: 'Compare frameworks',
    body:
      'You are a staff engineer. Compare React, Vue, and Svelte for building a real-time dashboard with 50000 concurrent users. Return as a markdown table with columns: Framework, Pros, Cons, Best for. Cite at least 2 real benchmarks, e.g. bundle size and hydration cost.',
  },
  {
    id: 'outline',
    label: 'Outline post',
    body:
      'You are a technical writer. Outline a 1500-word blog post about prompt engineering for non-technical readers. Format the outline as a hierarchical list with H2 and H3 headings. Include 1 example per section, e.g. "Show, don\'t tell".',
  },
];

/* ─────────────────────────────────────────────────────────────────────────
   Hook: tween a number toward target — used by Variants A & B so digits
   never snap, they ride the same easing curve as the rest of the motion.
   ───────────────────────────────────────────────────────────────────────── */

function useAnimatedNumber(target: number, durationMs = 480): number {
  const [display, setDisplay] = useState(target);
  const fromRef = useRef(target);
  useEffect(() => {
    const controls = animate(fromRef.current, target, {
      duration: durationMs / 1000,
      ease: [0.22, 1, 0.36, 1],
      onUpdate: (v) => {
        fromRef.current = v;
        setDisplay(v);
      },
    });
    return () => controls.stop();
  }, [target, durationMs]);
  return display;
}

const EASE = [0.22, 1, 0.36, 1] as const;

/* ─────────────────────────────────────────────────────────────────────────
   Shared chat input — single source of typing for all three variants.
   ───────────────────────────────────────────────────────────────────────── */

function ChatInput({
  text,
  setText,
  tokens,
  sending,
  onSend,
}: {
  text: string;
  setText: (v: string) => void;
  tokens: number;
  sending: boolean;
  onSend: () => void;
}) {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const sendControls = useAnimationControls();
  const prevHasContent = useRef(false);

  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = Math.min(260, Math.max(76, ta.scrollHeight)) + 'px';
  }, [text]);

  const hasContent = text.trim().length > 0;

  // One-shot pop the first time the textarea becomes non-empty after empty.
  useEffect(() => {
    if (hasContent && !prevHasContent.current) {
      sendControls.start({
        scale: [0.98, 1.04, 1],
        transition: { duration: 0.3, ease: EASE },
      });
    }
    prevHasContent.current = hasContent;
  }, [hasContent, sendControls]);

  const insertAtCaret = (body: string) => {
    const ta = taRef.current;
    if (!ta) {
      setText(text + body);
      return;
    }
    const start = ta.selectionStart ?? text.length;
    const end = ta.selectionEnd ?? text.length;
    const next = text.slice(0, start) + body + text.slice(end);
    setText(next);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + body.length;
      ta.setSelectionRange(pos, pos);
    });
  };

  const tokenColor = tokens > 4000 ? '#E07A7A' : tokens > 1000 ? '#E0B86B' : '#6A6A72';

  return (
    <motion.div
      layout
      transition={{ duration: 0.22, ease: EASE }}
      className="rounded-xl border p-4"
      style={{
        background: '#1F1F22',
        borderColor: '#2E2E33',
        boxShadow: '0 8px 24px rgba(0,0,0,0.25)',
      }}
    >
      <div
        className="mb-3 flex gap-2 overflow-x-auto pb-1"
        style={{ scrollbarWidth: 'thin' }}
      >
        {STARTERS.map((s) => (
          <motion.button
            key={s.id}
            type="button"
            onClick={() => insertAtCaret(s.body)}
            whileHover={{ y: -1, backgroundColor: '#26262A', borderColor: '#33333A' }}
            whileTap={{ scale: 0.97 }}
            whileDrag={{ scale: 1.04, zIndex: 30, cursor: 'grabbing' }}
            drag
            dragSnapToOrigin
            dragElastic={0.5}
            // Treat a drag past either axis threshold as a drop onto the textarea.
            onDragEnd={(_, info) => {
              if (Math.abs(info.offset.y) > 30 || Math.abs(info.offset.x) > 80) {
                insertAtCaret(s.body);
              }
            }}
            transition={{ duration: 0.22, ease: EASE }}
            className="shrink-0 select-none rounded-full border px-3 py-1 text-[12px]"
            style={{
              background: '#18181B',
              borderColor: '#2E2E33',
              color: '#ECECEE',
              cursor: 'grab',
              whiteSpace: 'nowrap',
            }}
          >
            {s.label}
          </motion.button>
        ))}
      </div>

      <motion.div
        layout
        transition={{ duration: 0.22, ease: EASE }}
        className="rounded-lg p-3"
        style={{ background: '#18181B', border: '1px solid #2E2E33' }}
      >
        <motion.textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="Ask anything. Drag a chip in, or just start typing."
          animate={{ opacity: sending ? 0 : 1 }}
          transition={{ duration: 0.12 }}
          className="block w-full resize-none bg-transparent text-[14px] leading-relaxed outline-none placeholder:text-[#6A6A72]"
          style={{
            color: '#ECECEE',
            minHeight: 76,
            maxHeight: 260,
            fontFamily: 'inherit',
          }}
        />
      </motion.div>

      <div className="mt-3 flex items-center">
        <div
          className="text-[12px] tabular-nums"
          style={{ color: tokenColor, transition: 'color 220ms' }}
        >
          ~{tokens.toLocaleString()} tokens
        </div>
        <motion.button
          type="button"
          disabled={!hasContent || sending}
          onClick={onSend}
          initial={false}
          animate={
            hasContent
              ? { opacity: 1, backgroundColor: '#ECECEE', color: '#141416' }
              : { opacity: 0.5, backgroundColor: '#2E2E33', color: '#6A6A72' }
          }
          whileTap={hasContent ? { scale: 0.96 } : undefined}
          transition={{ duration: 0.22, ease: EASE }}
          className="ml-auto rounded-md px-3 py-1.5 text-[13px] font-medium"
          style={{ cursor: hasContent ? 'pointer' : 'not-allowed' }}
        >
          <motion.span animate={sendControls} style={{ display: 'inline-block' }}>
            Send
          </motion.span>
        </motion.button>
      </div>
    </motion.div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   Variant A — Linear meter. The "shippable today" reference.
   ───────────────────────────────────────────────────────────────────────── */

function VariantA({ score, rubric }: { score: number; rubric: RubricItem[] }) {
  const animated = useAnimatedNumber(score);
  const color = scoreColor(animated);

  const prevScore = useRef(score);
  const pulseControls = useAnimationControls();

  useEffect(() => {
    const crossed =
      (prevScore.current < 40 && score >= 40) ||
      (prevScore.current < 75 && score >= 75);
    if (crossed) {
      pulseControls.start({
        scaleY: [1, 1.6, 1],
        filter: ['brightness(1)', 'brightness(1.6)', 'brightness(1)'],
        transition: { duration: 0.4, ease: EASE },
      });
    }
    prevScore.current = score;
  }, [score, pulseControls]);

  return (
    <div className="flex h-full flex-col items-center justify-center px-6 pb-5 pt-12">
      <div
        className="overflow-hidden rounded-full"
        style={{ width: 220, height: 6, background: '#2E2E33' }}
      >
        <motion.div
          animate={pulseControls}
          style={{ height: '100%', transformOrigin: 'center' }}
        >
          <motion.div
            className="h-full rounded-full"
            initial={false}
            animate={{ width: `${score}%`, backgroundColor: color }}
            transition={{ duration: 0.22, ease: EASE }}
          />
        </motion.div>
      </div>

      <div className="mt-5 text-center">
        <div
          className="text-[32px] font-medium leading-none tabular-nums"
          style={{ color }}
        >
          {Math.round(animated)}%
        </div>
        <div
          className="mt-1.5 text-[11px] uppercase tracking-wider"
          style={{ color: '#6A6A72' }}
        >
          Prompt quality
        </div>
      </div>

      <div className="mt-5 w-full space-y-1.5">
        <AnimatePresence initial={false}>
          {rubric.map((item, i) => (
            <motion.div
              key={item.label}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: i * 0.025, duration: 0.22, ease: EASE }}
              className="flex items-center gap-2 text-[12px]"
            >
              <motion.span
                animate={{
                  color: item.hit ? scoreColor(80) : '#3A3A40',
                  scale: item.hit ? 1 : 0.85,
                }}
                transition={{ duration: 0.22 }}
                style={{ width: 10, display: 'inline-block', textAlign: 'center' }}
              >
                {item.hit ? '●' : '○'}
              </motion.span>
              <span className="flex-1" style={{ color: '#ECECEE' }}>
                {item.label}
              </span>
              <div
                className="relative overflow-hidden rounded-full"
                style={{ width: 40, height: 3, background: '#2E2E33' }}
              >
                <motion.div
                  className="absolute inset-y-0 left-0 rounded-full"
                  initial={false}
                  animate={{
                    width: `${(item.score / item.max) * 100}%`,
                    backgroundColor: scoreColor(
                      40 + (item.score / item.max) * 50
                    ),
                  }}
                  transition={{ duration: 0.22, ease: EASE }}
                />
              </div>
              <span
                className="tabular-nums text-[11px]"
                style={{ color: '#6A6A72', width: 36, textAlign: 'right' }}
              >
                {Math.round(item.score)}/{item.max}
              </span>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   Variant B — Radar. The instrument-panel concept.
   ───────────────────────────────────────────────────────────────────────── */

function VariantB({ score, rubric }: { score: number; rubric: RubricItem[] }) {
  const animated = useAnimatedNumber(score);
  const color = scoreColor(animated);

  const SIZE = 220;
  const CENTER = SIZE / 2;
  const RADIUS = 76;

  const axisPoint = (i: number, r: number): [number, number] => {
    const angle = (Math.PI * 2 * i) / 6 - Math.PI / 2;
    return [CENTER + Math.cos(angle) * r, CENTER + Math.sin(angle) * r];
  };

  const polygonPoints = rubric
    .map((item, i) => {
      const [x, y] = axisPoint(i, (item.score / item.max) * RADIUS);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(' ');

  const guideRings = [0.25, 0.5, 0.75, 1].map((t) =>
    Array.from({ length: 6 }, (_, i) => {
      const [x, y] = axisPoint(i, RADIUS * t);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(' ')
  );

  const prevScore = useRef(score);
  const pulseControls = useAnimationControls();
  useEffect(() => {
    const crossed =
      (prevScore.current < 40 && score >= 40) ||
      (prevScore.current < 75 && score >= 75);
    if (crossed) {
      pulseControls.start({
        scale: [1, 1.04, 1],
        transition: { duration: 0.4, ease: EASE },
      });
    }
    prevScore.current = score;
  }, [score, pulseControls]);

  return (
    <div className="flex h-full flex-col items-center justify-center pt-10">
      <div
        className="mb-1 text-[13px] tabular-nums"
        style={{ color }}
      >
        {Math.round(animated)} / 100
      </div>
      <motion.svg
        width={SIZE}
        height={SIZE}
        animate={pulseControls}
        style={{ transformOrigin: 'center' }}
      >
        {guideRings.map((pts, i) => (
          <polygon
            key={i}
            points={pts}
            fill="none"
            stroke="#2E2E33"
            strokeWidth={1}
          />
        ))}
        {rubric.map((_, i) => {
          const [x, y] = axisPoint(i, RADIUS);
          return (
            <line
              key={i}
              x1={CENTER}
              y1={CENTER}
              x2={x}
              y2={y}
              stroke="#2E2E33"
              strokeWidth={0.5}
            />
          );
        })}
        {/* The data polygon: spring-tweened vertices for organic morphing. */}
        <motion.polygon
          animate={{ points: polygonPoints }}
          transition={{ type: 'spring', stiffness: 220, damping: 26 }}
          fill={color}
          fillOpacity={0.18}
          stroke={color}
          strokeWidth={1.5}
        />
        {rubric.map((item, i) => {
          const [x, y] = axisPoint(i, (item.score / item.max) * RADIUS);
          return (
            <motion.circle
              key={i}
              animate={{ cx: x, cy: y }}
              transition={{ type: 'spring', stiffness: 220, damping: 26 }}
              r={2.5}
              fill={color}
            />
          );
        })}
        {rubric.map((item, i) => {
          const [x, y] = axisPoint(i, RADIUS + 16);
          return (
            <text
              key={i}
              x={x}
              y={y}
              textAnchor="middle"
              dominantBaseline="middle"
              fontSize={10}
              fill="#6A6A72"
            >
              {item.label}
            </text>
          );
        })}
      </motion.svg>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   Variant C — Inline annotations. The "marked up by an editor" approach.
   ───────────────────────────────────────────────────────────────────────── */

const HIGHLIGHT_COLOR: Record<HighlightType, string> = {
  verb: '#5BD0A0',
  format: '#7BAFFF',
  spec: '#B89BFF',
  example: '#E0B86B',
  role: '#F092C5',
};

function VariantC({
  text,
  score,
  rubric,
}: {
  text: string;
  score: number;
  rubric: RubricItem[];
}) {
  const highlights = useMemo(() => getHighlights(text), [text]);
  const animated = useAnimatedNumber(score);

  const segments = useMemo(() => {
    const out: Array<{ text: string; highlight?: Highlight; key: string }> = [];
    let pos = 0;
    for (let i = 0; i < highlights.length; i++) {
      const h = highlights[i];
      if (h.start > pos) {
        out.push({ text: text.slice(pos, h.start), key: `p-${pos}` });
      }
      out.push({
        text: text.slice(h.start, h.end),
        highlight: h,
        key: `h-${h.start}-${h.end}-${h.type}`,
      });
      pos = h.end;
    }
    if (pos < text.length) {
      out.push({ text: text.slice(pos), key: `p-${pos}` });
    }
    return out;
  }, [text, highlights]);

  // Glow the summary strip briefly when a hit toggles on. Tracked via signature.
  const hitsSignature = rubric.map((r) => (r.hit ? '1' : '0')).join('');
  const prevHits = useRef(hitsSignature);
  const glowControls = useAnimationControls();
  useEffect(() => {
    const gained =
      hitsSignature.split('').filter((b, i) => b === '1' && prevHits.current[i] !== '1').length > 0;
    if (gained) {
      glowControls.start({
        borderColor: ['#2E2E33', scoreColor(80), '#2E2E33'],
        transition: { duration: 0.6, ease: EASE },
      });
    }
    prevHits.current = hitsSignature;
  }, [hitsSignature, glowControls]);

  return (
    <div className="flex h-full flex-col px-4 pb-4 pt-10">
      <motion.div
        animate={glowControls}
        className="mb-2 flex items-center justify-between rounded-md border px-2.5 py-1.5"
        style={{ background: '#18181B', borderColor: '#2E2E33' }}
      >
        <div className="flex items-center gap-1.5">
          {rubric.map((r) => (
            <motion.div
              key={r.label}
              animate={{
                scale: r.hit ? 1 : 0.7,
                opacity: r.hit ? 1 : 0.35,
                backgroundColor: r.hit
                  ? HIGHLIGHT_COLOR[
                      r.label === 'Clear ask'
                        ? 'verb'
                        : r.label === 'Output format'
                        ? 'format'
                        : r.label === 'Specificity'
                        ? 'spec'
                        : r.label === 'Example'
                        ? 'example'
                        : r.label === 'Role'
                        ? 'role'
                        : 'verb'
                    ]
                  : '#2E2E33',
              }}
              transition={{ duration: 0.22, ease: EASE }}
              style={{ width: 7, height: 7, borderRadius: 9999 }}
              title={r.label}
            />
          ))}
        </div>
        <div className="text-[12px] tabular-nums" style={{ color: '#ECECEE' }}>
          {Math.round(animated)} / 100
        </div>
      </motion.div>

      <div
        className="flex-1 overflow-y-auto rounded-md border p-3 text-[12px] leading-relaxed"
        style={{
          background: '#18181B',
          borderColor: '#2E2E33',
          color: '#ECECEE',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {!text && (
          <div
            className="flex h-full items-center justify-center text-center text-[12px]"
            style={{ color: '#6A6A72' }}
          >
            Type to see what lights up.
          </div>
        )}
        <AnimatePresence initial={false}>
          {segments.map((seg) => {
            if (!seg.highlight) {
              return <span key={seg.key}>{seg.text}</span>;
            }
            const c = HIGHLIGHT_COLOR[seg.highlight.type];
            return (
              <motion.span
                key={seg.key}
                initial={{ opacity: 0.3 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.16, ease: EASE }}
                style={{
                  borderBottom: `1.5px solid ${c}`,
                  paddingBottom: 1,
                }}
                title={seg.highlight.label}
              >
                {seg.text}
              </motion.span>
            );
          })}
        </AnimatePresence>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   Variant card chrome
   ───────────────────────────────────────────────────────────────────────── */

function VariantCard({
  label,
  caption,
  children,
}: {
  label: string;
  caption: string;
  children: ReactNode;
}) {
  return (
    <motion.div
      whileHover={{ borderColor: '#33333A' }}
      transition={{ duration: 0.22, ease: EASE }}
      className="relative aspect-square overflow-hidden rounded-xl border"
      style={{ background: '#1F1F22', borderColor: '#2E2E33' }}
    >
      <div
        className="pointer-events-none absolute left-3 top-3 text-[11px] uppercase tracking-wider"
        style={{ color: '#6A6A72' }}
      >
        {label}
      </div>
      <div
        className="pointer-events-none absolute right-3 top-3 text-[11px]"
        style={{ color: '#9A9AA2' }}
      >
        {caption}
      </div>
      <div className="h-full w-full">{children}</div>
    </motion.div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   Page
   ───────────────────────────────────────────────────────────────────────── */

export default function PromptQualityExploration() {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  const { total, rubric } = useMemo(() => scorePrompt(text), [text]);
  const tokens = Math.ceil(text.length / 4);

  const handleSend = () => {
    if (!text.trim() || sending) return;
    setSending(true);
    // Fade text out (120ms), then clear — variants drain naturally on empty.
    window.setTimeout(() => {
      setText('');
      setSending(false);
    }, 120);
  };

  return (
    <div
      className="min-h-screen"
      style={{
        background: '#141416',
        fontFamily:
          '-apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif',
        fontFeatureSettings: '"tnum" 1, "cv11" 1',
      }}
    >
      <div className="mx-auto max-w-[1080px] px-6 py-12">
        <div className="mb-6">
          <div
            className="text-[11px] uppercase tracking-wider"
            style={{ color: '#6A6A72' }}
          >
            Concept · Prompt quality feedback
          </div>
          <h1
            className="mt-1.5 text-[18px] font-medium"
            style={{ color: '#ECECEE' }}
          >
            How should a chat input score your prompt?
          </h1>
        </div>

        <ChatInput
          text={text}
          setText={setText}
          tokens={tokens}
          sending={sending}
          onSend={handleSend}
        />

        <motion.div
          layout
          transition={{ duration: 0.22, ease: EASE }}
          className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3"
        >
          <VariantCard label="Variant A" caption="Linear meter">
            <VariantA score={total} rubric={rubric} />
          </VariantCard>
          <VariantCard label="Variant B" caption="Radar">
            <VariantB score={total} rubric={rubric} />
          </VariantCard>
          <VariantCard label="Variant C" caption="Inline annotations">
            <VariantC text={text} score={total} rubric={rubric} />
          </VariantCard>
        </motion.div>

        <div
          className="mt-4 text-center text-[12px]"
          style={{ color: '#6A6A72' }}
        >
          All three variants score the same prompt with the same heuristic. The
          visualization is the variable.
        </div>
      </div>
    </div>
  );
}
