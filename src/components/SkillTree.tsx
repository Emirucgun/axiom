import React from 'react';
import { Lock, CheckCircle2, Unlock, ChevronRight } from 'lucide-react';
import type { LevelTier, SkillLevel } from '../types';

interface SkillTreeProps {
  levels: SkillLevel[];
  selectedLevelNumber: number;
  onSelectLevel: (levelNumber: number) => void;
}

const TIER_META: Record<LevelTier, { label: string; range: string; description: string }> = {
  foundation: {
    label: 'Tier 1 · Foundation',
    range: 'Levels 01–02',
    description: 'Core definitions, physical intuition & conceptual sanity checks',
  },
  application: {
    label: 'Tier 2 · Application',
    range: 'Levels 03–05',
    description: 'Single-step theorem mechanics & standard problem solving',
  },
  exam: {
    label: 'Tier 3 · Exam Simulation',
    range: 'Levels 06–08',
    description: 'Multi-step engineering problems modeled after past exams',
  },
  distinction: {
    label: 'Tier 4 · Distinction',
    range: 'Levels 09–10',
    description: 'Coupled synthesis, proofs & high-rigor edge cases',
  },
};

const TIER_ORDER: LevelTier[] = ['foundation', 'application', 'exam', 'distinction'];

export const SkillTree: React.FC<SkillTreeProps> = ({
  levels,
  selectedLevelNumber,
  onSelectLevel,
}) => {
  return (
    <div className="space-y-6">
      {TIER_ORDER.map((tier) => {
        const tierLevels = levels.filter((l) => l.tier === tier);
        if (tierLevels.length === 0) return null;
        const meta = TIER_META[tier];

        return (
          <section key={tier} className="space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-slate-200 dark:border-slate-800 pb-2">
              <div className="flex items-baseline gap-2.5">
                <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                  {meta.label}
                </h3>
                <span className="text-xs font-mono text-slate-500 dark:text-slate-400">
                  {meta.range}
                </span>
              </div>
              <p className="text-xs text-slate-500 dark:text-slate-400">{meta.description}</p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {tierLevels.map((lvl) => {
                const isSelected = lvl.levelNumber === selectedLevelNumber;
                const isLocked = !lvl.unlocked;
                const isMastered = lvl.mastered;
                const progressPct = lvl.bestScore !== null ? Math.min(100, lvl.bestScore) : 0;

                return (
                  <button
                    key={lvl.levelNumber}
                    type="button"
                    disabled={isLocked}
                    onClick={() => onSelectLevel(lvl.levelNumber)}
                    className={`group relative text-left rounded-xl border p-4 transition-all duration-150 flex flex-col justify-between gap-3 ${
                      isLocked
                        ? 'border-slate-200/80 dark:border-slate-800/70 bg-slate-100/60 dark:bg-slate-900/30 opacity-65 cursor-not-allowed'
                        : isSelected
                          ? 'border-sky-600 dark:border-sky-400 bg-white dark:bg-slate-900 ring-1 ring-sky-600/20 dark:ring-sky-400/20 cursor-pointer'
                          : 'border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900/70 hover:border-slate-300 dark:hover:border-slate-700 cursor-pointer'
                    }`}
                  >
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between gap-2 text-xs">
                        <span className="font-mono font-medium text-slate-500 dark:text-slate-400 tabular-nums">
                          Level {String(lvl.levelNumber).padStart(2, '0')}
                        </span>
                        <span
                          className={`inline-flex items-center gap-1 font-medium whitespace-nowrap shrink-0 ${
                            isMastered
                              ? 'text-emerald-700 dark:text-emerald-400'
                              : isLocked
                                ? 'text-slate-500 dark:text-slate-500'
                                : 'text-sky-700 dark:text-sky-400'
                          }`}
                        >
                          {isMastered ? (
                            <>
                              <CheckCircle2 className="w-3.5 h-3.5" />
                              <span>Mastered</span>
                            </>
                          ) : isLocked ? (
                            <>
                              <Lock className="w-3.5 h-3.5" />
                              <span>Pass L{lvl.levelNumber - 1} ≥ 80%</span>
                            </>
                          ) : (
                            <>
                              <Unlock className="w-3.5 h-3.5" />
                              <span>Unlocked</span>
                            </>
                          )}
                        </span>
                      </div>

                      <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100 leading-snug line-clamp-2">
                        {lvl.title}
                      </h4>
                      <p className="text-xs text-slate-600 dark:text-slate-400 line-clamp-2 leading-relaxed">
                        {lvl.summary}
                      </p>
                    </div>

                    <div className="space-y-1.5 pt-1">
                      <div className="flex items-center justify-between text-xs text-slate-500 dark:text-slate-400 tabular-nums">
                        <span>
                          Best: {lvl.bestScore !== null ? `${lvl.bestScore}%` : '—'} · Reflex:{' '}
                          {lvl.reflexPassed}
                          {lvl.feynmanBestClarity !== null ? ` · Clarity: ${lvl.feynmanBestClarity}%` : ''}
                        </span>
                        {!isLocked && (
                          <ChevronRight
                            className={`w-3.5 h-3.5 transition-transform ${
                              isSelected ? 'text-sky-600 dark:text-sky-400 translate-x-0.5' : 'group-hover:translate-x-0.5'
                            }`}
                          />
                        )}
                      </div>
                      <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
                        <div
                          className={`h-full transition-all duration-300 ${
                            isMastered
                              ? 'bg-emerald-600 dark:bg-emerald-500'
                              : 'bg-sky-600 dark:bg-sky-500'
                          }`}
                          style={{ width: `${progressPct}%` }}
                        />
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
};
