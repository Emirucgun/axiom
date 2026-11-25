import React, { useState, useRef, useEffect } from 'react';
import {
  ArrowRight,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  RotateCcw,
  RefreshCw,
  Loader2,
  Award,
  Clock,
} from 'lucide-react';
import type {
  ClimbGradeResult,
  ClimbQuestion,
  Course,
  SkillLevel,
} from '../types';
import { safeFetchJson } from '../utils/apiClient';
import {
  getLevelCache,
  saveLevelQuestions,
  withLevelPdfContext,
} from '../services/courseService';
import { MathText } from './MathText';
import { MathHelperBar } from './MathHelperBar';

interface LevelClimbModeProps {
  course: Course;
  level: SkillLevel;
  userElo: number;
  onCompleteClimb: (
    levelNumber: number,
    averageScore: number,
    totalEloDelta: number,
    summaryText: string,
  ) => void;
  onApplySingleElo: (delta: number) => void;
  onNotifyError?: (message: string) => void;
}

export const LevelClimbMode: React.FC<LevelClimbModeProps> = ({
  course,
  level,
  userElo,
  onCompleteClimb,
  onApplySingleElo,
  onNotifyError,
}) => {
  const [questions, setQuestions] = useState<ClimbQuestion[]>([]);
  const [currentIdx, setCurrentIdx] = useState(0);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [results, setResults] = useState<Record<number, ClimbGradeResult>>({});
  const [showHint, setShowHint] = useState(false);
  const [loadingGen, setLoadingGen] = useState(false);
  const [loadingGrade, setLoadingGrade] = useState(false);
  const [retryStatus, setRetryStatus] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [completed, setCompleted] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    setQuestions([]);
    setCurrentIdx(0);
    setAnswers({});
    setResults({});
    setShowHint(false);
    setCompleted(false);
    setErrorMsg(null);
    // Show previously generated questions (from any device) without spending Gemini quota
    let cancelled = false;
    getLevelCache(level.id)
      .then((cache) => {
        if (!cancelled && mountedRef.current && cache.questions) setQuestions(cache.questions);
      })
      .catch(() => {
        // Non-fatal: the user can still generate a fresh set
      });
    return () => {
      cancelled = true;
    };
  }, [course.id, level.id]);

  const generateQuestions = async (forceRefresh = false) => {
    if (!forceRefresh) {
      const cached = (await getLevelCache(level.id).catch(() => null))?.questions;
      if (cached && cached.length > 0) {
        setQuestions(cached);
        setResults({});
        setAnswers({});
        setCurrentIdx(0);
        setShowHint(false);
        setCompleted(false);
        return;
      }
    }

    setLoadingGen(true);
    setErrorMsg(null);
    setRetryStatus(null);
    setCompleted(false);
    setResults({});
    setAnswers({});
    setCurrentIdx(0);
    setShowHint(false);

    try {
      const data = await withLevelPdfContext(
        course,
        level,
        (pdfs) =>
          safeFetchJson<{ questions?: ClimbQuestion[] }>('/api/climb/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            timeoutMs: 45000,
            onRetryStatus: (msg) => {
              if (mountedRef.current) setRetryStatus(msg);
            },
            body: JSON.stringify({
              courseName: course.name,
              detectedLanguage: course.detectedLanguage,
              courseDigest: course.courseDigest,
              level,
              pdfs,
            }),
          }),
        2,
      );
      if (!mountedRef.current) return;
      const nextQs = data.questions || [];
      setQuestions(nextQs);
      if (nextQs.length > 0) {
        await saveLevelQuestions(level.id, nextQs);
      }
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = err instanceof Error ? err.message : 'Unable to generate questions.';
      setErrorMsg(msg);
      onNotifyError?.(msg);
    } finally {
      if (mountedRef.current) {
        setLoadingGen(false);
        setRetryStatus(null);
      }
    }
  };

  const handleRetrySameSet = () => {
    setResults({});
    setAnswers({});
    setCurrentIdx(0);
    setShowHint(false);
    setCompleted(false);
    setErrorMsg(null);
  };

  const handleInsertMath = (snippet: string) => {
    const current = answers[currentIdx] || '';
    const el = textareaRef.current;
    if (el) {
      const start = el.selectionStart ?? current.length;
      const end = el.selectionEnd ?? current.length;
      const next = current.slice(0, start) + snippet + current.slice(end);
      setAnswers((prev) => ({ ...prev, [currentIdx]: next }));
      requestAnimationFrame(() => {
        el.focus();
        const pos = start + snippet.length;
        el.setSelectionRange(pos, pos);
      });
    } else {
      setAnswers((prev) => ({ ...prev, [currentIdx]: current + snippet }));
    }
  };

  const handleGradeCurrent = async () => {
    const q = questions[currentIdx];
    const userAnswer = (answers[currentIdx] || '').trim();
    if (!q || !userAnswer) return;

    setLoadingGrade(true);
    setErrorMsg(null);
    setRetryStatus(null);
    try {
      const data = await withLevelPdfContext(
        course,
        level,
        (pdfs) =>
          safeFetchJson<ClimbGradeResult>('/api/climb/grade', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            timeoutMs: 45000,
            onRetryStatus: (msg) => {
              if (mountedRef.current) setRetryStatus(msg);
            },
            body: JSON.stringify({
              courseName: course.name,
              detectedLanguage: course.detectedLanguage,
              courseDigest: course.courseDigest,
              level,
              question: q,
              userAnswer,
              userElo,
              pdfs,
            }),
          }),
        2,
      );
      if (!mountedRef.current) return;
      setResults((prev) => ({ ...prev, [currentIdx]: data }));
      onApplySingleElo(data.eloDelta);
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = err instanceof Error ? err.message : 'Failed to grade your solution.';
      setErrorMsg(msg);
      onNotifyError?.(msg);
    } finally {
      if (mountedRef.current) {
        setLoadingGrade(false);
        setRetryStatus(null);
      }
    }
  };

  const handleFinishClimb = () => {
    const graded = Object.values(results);
    if (graded.length === 0) return;
    const avgScore = Math.round(graded.reduce((acc, r) => acc + r.score, 0) / questions.length);
    const totalDelta = graded.reduce((acc, r) => acc + r.eloDelta, 0);
    setCompleted(true);
    onCompleteClimb(
      level.levelNumber,
      avgScore,
      totalDelta,
      `Level ${level.levelNumber} Climb (${graded.length}/${questions.length} graded)`,
    );
  };

  if (questions.length === 0 && !loadingGen) {
    return (
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 md:p-8 space-y-5">
        <div className="space-y-2 max-w-2xl">
          <div className="text-xs font-medium text-sky-700 dark:text-sky-400">
            Mode A · 5-Question Mastery Climb
          </div>
          <h3 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Level {level.levelNumber}: {level.title}
          </h3>
          <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
            Solve 5 targeted conceptual checks and engineering problems grounded in the matched PDFs for this level. Score{' '}
            <span className="font-semibold text-slate-900 dark:text-slate-100 tabular-nums">≥ 80%</span> to unlock Level{' '}
            {Math.min(10, level.levelNumber + 1)}.
          </p>
        </div>

        {errorMsg && (
          <div className="p-3.5 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 text-sm text-red-700 dark:text-red-300 flex items-start gap-2.5">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        <button
          type="button"
          onClick={() => generateQuestions(false)}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <span>Generate 5 Climb Questions</span>
          <ArrowRight className="w-4 h-4" />
        </button>
      </div>
    );
  }

  if (loadingGen) {
    return (
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-10 flex flex-col items-center justify-center gap-3 text-center">
        <Loader2 className="w-6 h-6 animate-spin text-sky-600 dark:text-sky-400" />
        <div className="space-y-1">
          <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
            {retryStatus || `Drafting 5 calibrated questions for Level ${level.levelNumber}…`}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Slicing only the 1–2 matched PDFs for fast, quota-safe generation.
          </p>
        </div>
      </div>
    );
  }

  if (completed) {
    const scores = questions.map((_, idx) => results[idx]?.score ?? 0);
    const avgScore = Math.round(scores.reduce((a, b) => a + b, 0) / questions.length);
    const passed = avgScore >= 80;

    return (
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 md:p-8 space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-slate-200 dark:border-slate-800 pb-5">
          <div className="space-y-1">
            <div className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 dark:text-slate-400">
              <Award className="w-4 h-4 text-sky-600 dark:text-sky-400" />
              <span>Level {level.levelNumber} Climb Completed</span>
            </div>
            <h3 className="text-2xl font-bold text-slate-900 dark:text-slate-100 tabular-nums">
              Final Score: {avgScore}%
            </h3>
            <p className="text-sm text-slate-600 dark:text-slate-400">
              {passed
                ? level.levelNumber < 10
                  ? `Mastery threshold met (≥ 80%). Level ${level.levelNumber + 1} is now unlocked.`
                  : 'Distinction mastery confirmed across the final capstone level.'
                : 'Score below 80%. Review step-by-step feedback below and retry to unlock the next level.'}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleRetrySameSet}
              className="inline-flex items-center gap-2 px-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 text-slate-800 dark:text-slate-200 text-xs font-medium hover:bg-slate-50 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>Retry Same Set</span>
            </button>
            <button
              type="button"
              onClick={() => generateQuestions(true)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-xs font-medium hover:opacity-90 transition-opacity whitespace-nowrap shrink-0 cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Regenerate Questions</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-5 gap-3">
          {questions.map((q, idx) => {
            const res = results[idx];
            return (
              <button
                key={q.id}
                type="button"
                onClick={() => {
                  setCompleted(false);
                  setCurrentIdx(idx);
                }}
                className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 text-left hover:border-slate-300 dark:hover:border-slate-700 transition-colors cursor-pointer"
              >
                <div className="text-xs font-mono text-slate-500 dark:text-slate-400">Q{idx + 1}</div>
                <div className="text-lg font-semibold text-slate-900 dark:text-slate-100 tabular-nums mt-0.5">
                  {res ? `${res.score}%` : '—'}
                </div>
                <div className="text-xs text-slate-500 dark:text-slate-400 truncate mt-0.5">
                  {q.kind === 'conceptual' ? 'Conceptual' : 'Problem'}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  const activeQ = questions[currentIdx];
  const activeResult = results[currentIdx];
  const allGraded = questions.every((_, idx) => Boolean(results[idx]));

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-6">
      {/* Stepper bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-4">
        <div className="flex items-center gap-1.5">
          {questions.map((q, idx) => {
            const graded = results[idx];
            const isActive = idx === currentIdx;
            return (
              <button
                key={q.id}
                type="button"
                onClick={() => {
                  setCurrentIdx(idx);
                  setShowHint(false);
                }}
                className={`px-3 py-1.5 rounded-lg text-xs font-mono font-medium transition-colors tabular-nums whitespace-nowrap shrink-0 cursor-pointer ${
                  isActive
                    ? 'bg-sky-600 text-white'
                    : graded
                      ? graded.score >= 70
                        ? 'bg-emerald-50 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800'
                        : 'bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800'
                      : 'bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-200 dark:hover:bg-slate-700'
                }`}
              >
                Q{idx + 1}
                {graded ? ` · ${graded.score}%` : ''}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={handleRetrySameSet}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Clear Answers</span>
          </button>
          <button
            type="button"
            onClick={() => generateQuestions(true)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-600 hover:text-slate-900 dark:text-slate-300 dark:hover:text-slate-100 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RefreshCw className="w-3 h-3" />
            <span>Regenerate Questions</span>
          </button>
        </div>
      </div>

      {/* Question Prompt */}
      <div className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400">
          <span>
            Question {currentIdx + 1} of {questions.length} ·{' '}
            {activeQ.kind === 'conceptual' ? 'Conceptual Check' : 'Step-by-Step Problem'}
          </span>
          <button
            type="button"
            onClick={() => setShowHint((h) => !h)}
            className="inline-flex items-center gap-1 text-sky-700 dark:text-sky-400 hover:underline cursor-pointer"
          >
            <HelpCircle className="w-3.5 h-3.5" />
            <span>{showHint ? 'Hide Hint' : 'Show Hint'}</span>
          </button>
        </div>

        <div className="text-[15px] text-slate-900 dark:text-slate-100 leading-relaxed">
          <MathText text={activeQ.prompt} />
        </div>

        {showHint && (
          <div className="p-3.5 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 text-sm text-slate-700 dark:text-slate-300">
            <span className="font-medium text-slate-900 dark:text-slate-100">Hint: </span>
            <MathText text={activeQ.hint} className="inline" />
          </div>
        )}
      </div>

      {/* Answer Input */}
      <div className="space-y-3">
        <label className="block text-xs font-medium text-slate-600 dark:text-slate-400">
          Your Step-by-Step Solution (supports KaTeX via $...$ or plain notation)
        </label>
        <MathHelperBar value={answers[currentIdx] || ''} onInsert={handleInsertMath} />
        <textarea
          ref={textareaRef}
          rows={5}
          disabled={Boolean(activeResult) || loadingGrade}
          value={answers[currentIdx] || ''}
          onChange={(e) => setAnswers((prev) => ({ ...prev, [currentIdx]: e.target.value }))}
          placeholder="Write your derivation, governing equations, or conceptual reasoning step by step..."
          className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3.5 py-2.5 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500 disabled:opacity-75"
        />

        {retryStatus && (
          <div className="p-3 rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 text-xs text-amber-800 dark:text-amber-200 flex items-center gap-2">
            <Clock className="w-4 h-4 shrink-0 animate-pulse" />
            <span>{retryStatus}</span>
          </div>
        )}

        {errorMsg && (
          <div className="p-3 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 text-sm text-red-700 dark:text-red-300 flex items-start gap-2">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        {!activeResult && (
          <div className="flex items-center justify-end gap-3">
            <button
              type="button"
              disabled={loadingGrade || !(answers[currentIdx] || '').trim()}
              onClick={handleGradeCurrent}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-sky-600 hover:bg-sky-700 disabled:opacity-50 text-white text-sm font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {loadingGrade ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>{retryStatus || 'Grading Step-by-Step…'}</span>
                </>
              ) : (
                <span>Grade Solution</span>
              )}
            </button>
          </div>
        )}
      </div>

      {/* Diagnostic Grading Feedback */}
      {activeResult && (
        <div className="space-y-4 pt-4 border-t border-slate-200 dark:border-slate-800">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {activeResult.score >= 70 ? (
                <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
              ) : (
                <AlertCircle className="w-5 h-5 text-amber-600 dark:text-amber-400" />
              )}
              <span className="text-base font-semibold text-slate-900 dark:text-slate-100">
                {activeResult.verdict}
              </span>
            </div>
            <div className="text-sm font-mono tabular-nums text-slate-600 dark:text-slate-300">
              Score: <span className="font-semibold">{activeResult.score}%</span> · Elo:{' '}
              <span
                className={
                  activeResult.eloDelta >= 0
                    ? 'text-emerald-600 dark:text-emerald-400 font-semibold'
                    : 'text-amber-600 dark:text-amber-400 font-semibold'
                }
              >
                {activeResult.eloDelta >= 0 ? `+${activeResult.eloDelta}` : activeResult.eloDelta}
              </span>
            </div>
          </div>

          <div className="space-y-1.5">
            <h4 className="text-xs font-semibold text-slate-500 dark:text-slate-400">
              Diagnostic Step Analysis
            </h4>
            <MathText
              text={activeResult.stepFeedback}
              className="text-sm text-slate-800 dark:text-slate-200"
            />
          </div>

          <div className="p-4 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-1.5">
            <h4 className="text-xs font-semibold text-slate-500 dark:text-slate-400">
              Canonical Worked Derivation
            </h4>
            <MathText
              text={activeResult.workedSolution}
              className="text-sm text-slate-800 dark:text-slate-200"
            />
          </div>

          <div className="flex items-center justify-between gap-3 pt-2">
            {currentIdx < questions.length - 1 ? (
              <button
                type="button"
                onClick={() => {
                  setCurrentIdx((i) => i + 1);
                  setShowHint(false);
                }}
                className="ml-auto inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-sm font-medium hover:opacity-90 transition-opacity cursor-pointer"
              >
                <span>Next Question (Q{currentIdx + 2})</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            ) : (
              <button
                type="button"
                disabled={!allGraded}
                onClick={handleFinishClimb}
                className="ml-auto inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-sm font-medium transition-colors cursor-pointer"
              >
                <span>Complete Level Climb &amp; Record Score</span>
                <CheckCircle2 className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
