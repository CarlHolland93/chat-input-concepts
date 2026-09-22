import { useState } from 'react';
import ChatInput from './ChatInput';
import ContextBudget from './ContextBudget';
import IntentMirror from './IntentMirror';
import ModelRouter from './ModelRouter';

type ConceptId = 'quality' | 'budget' | 'intent' | 'router' | 'all';

const CONCEPTS: { id: ConceptId; label: string; caption: string }[] = [
  { id: 'quality', label: 'Prompt quality', caption: 'Tokens + a live quality score for what you write' },
  { id: 'budget', label: 'Context budget', caption: '' },
  { id: 'intent', label: 'Intent mirror', caption: '' },
  { id: 'router', label: 'Model router', caption: '' },
  { id: 'all', label: 'Compare all', caption: '' },
];

const GRID_TILES: { id: Exclude<ConceptId, 'all'>; label: string; sub: string }[] = [
  { id: 'quality', label: 'Prompt quality', sub: 'Live signals as you write' },
  { id: 'budget', label: 'Context budget', sub: 'What’s filling the window' },
  { id: 'intent', label: 'Intent mirror', sub: '200ms pre-flight on ambiguous asks' },
  { id: 'router', label: 'Model router', sub: 'Right tier, with a cost delta' },
];

export default function App() {
  const [concept, setConcept] = useState<ConceptId>('quality');
  const [sent, setSent] = useState<string[]>([]);

  const current = CONCEPTS.find((c) => c.id === concept)!;
  const push = (t: string) => setSent((prev) => [...prev, t]);
  const isAll = concept === 'all';

  return (
    <div className="min-h-screen w-full flex flex-col">
      {/* Concept switcher — pinned to the very top */}
      <div className="sticky top-0 z-50 flex justify-center border-b border-[#1F1F22] bg-[#141416]/80 px-8 py-3 backdrop-blur">
        <div className="inline-flex w-fit gap-1 rounded-lg border border-[#26262B] bg-[#16161A] p-1">
          {CONCEPTS.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => {
                setConcept(c.id);
                setSent([]);
              }}
              className="rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors"
              style={{
                background: concept === c.id ? '#2E2E33' : 'transparent',
                color: concept === c.id ? '#ECECEE' : '#9A9AA2',
              }}
            >
              {c.label}
            </button>
          ))}
        </div>
      </div>

      <div className={`flex w-full flex-1 flex-col items-center ${isAll ? 'justify-start py-10' : 'justify-center p-8'}`}>
        <div className={`w-full ${isAll ? 'max-w-[1400px] px-8' : 'max-w-2xl'} flex flex-col gap-5`}>
          {current.caption && <span className="text-[12px] text-[#6A6A72]">{current.caption}</span>}

          {/* Active concept */}
          {concept === 'quality' && <ChatInput onSend={push} />}
          {concept === 'budget' && <ContextBudget onSend={push} />}
          {concept === 'intent' && <IntentMirror onSend={push} />}
          {concept === 'router' && <ModelRouter onSend={push} />}

          {isAll && (
            <div className="grid grid-cols-1 gap-x-8 gap-y-10 lg:grid-cols-2">
              {GRID_TILES.map((tile) => (
                <section key={tile.id} className="flex flex-col gap-3">
                  <header className="flex items-baseline gap-2">
                    <h2 className="text-[13px] font-medium text-[#ECECEE]">{tile.label}</h2>
                    <span className="text-[11px] text-[#6A6A72]">{tile.sub}</span>
                  </header>
                  <div className="flex">
                    {tile.id === 'quality' && <ChatInput onSend={push} />}
                    {tile.id === 'budget' && <ContextBudget onSend={push} />}
                    {tile.id === 'intent' && <IntentMirror onSend={push} />}
                    {tile.id === 'router' && <ModelRouter onSend={push} />}
                  </div>
                </section>
              ))}
            </div>
          )}

          {!isAll && sent.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-xs text-[#9A9AA2]">Sent</span>
              <ul className="flex flex-col gap-1">
                {sent.map((t, i) => (
                  <li
                    key={i}
                    className="rounded-lg border border-[#2E2E33] bg-[#26262B] px-3 py-2 text-sm text-[#ECECEE] whitespace-pre-wrap"
                  >
                    {t}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
