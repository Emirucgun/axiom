import React, { useState, useEffect, useRef } from 'react';
import { Timer, Zap, CheckCircle2, AlertTriangle, XCircle, Loader2, RotateCcw, Clock } from 'lucide-react';
import type { Course, ReflexEvaluation, ReflexProblem, SkillLevel } from '../types';
import { withTargetedPdfRetry } from '../utils/pdfStorage';
import { safeFetchJson } from '../utils/apiClient';
import { MathText } from './MathText';
import { MathHelperBar } from './MathHelperBar';

interface FirstTwoLinesModeProps {
  course: Course;
  level: SkillLevel;
  userElo: number;
  onCompleteReflex: (
    levelNumber: number,
    evaluation: ReflexEvaluation,
    elapsedSeconds: number,
  ) => void;
  onNotifyError?: (message: string) => void;
}

const TOTAL_SECONDS = 45;

export const FirstTwoLinesMode: React.FC<FirstTwoLinesModeProps> = ({
  course,
  level,
  userElo,
  onCompleteReflex,
  onNotifyError,
}) => {
  const [problem, setProblem] = useState<ReflexProblem | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(TOTAL_SECONDS);
  const [timerActive, setTimerActive] = useState(false);
  const [lineOne, setLineOne] = useState('');
  const [lineTwo, setLineTwo] = useState('');
  const [evaluation, setEvaluation] = useState<ReflexEvaluation | null>(null);
  const [loadingGen, setLoadingGen] = useState(false);
  const [loadingEval, setLoadingEval] = useState(false);
  const [retryStatus, setRetryStatus] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const lineTwoRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (!timerActive || evaluation) return;
    if (secondsLeft <= 0) {
      setTimerActive(false);
      return;
    }
    const id = window.setInterval(() => {
      setSecondsLeft((prev) => Math.max(0, prev - 1));
    }, 1000);
    return () => window.clearInterval(id);
  }, [timerActive, secondsLeft, evaluation]);

  const startDrill = async () => {
    setLoadingGen(true);
    setErrorMsg(null);
    setRetryStatus(null);
    setEvaluation(null);
    setLineOne('');
    setLineTwo('');
    setSecondsLeft(TOTAL_SECONDS);
    setTimerActive(false);

    try {
      const data = await withTargetedPdfRetry(
        course,
        level,
        (pdfs) =>
          safeFetchJson<ReflexProblem>('/api/reflex/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            timeoutMs: 45000,
            onRetryStatus: (msg) => setRetryStatus(msg),
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
      setProblem(data);
      setTimerActive(true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unable to start reflex drill.';
      setErrorMsg(msg);
      onNotifyError?.(msg);
    } finally {
      setLoadingGen(false);
      setRetryStatus(null);
    }
  };

  const handleSubmitSetup = async () => {
    if (!problem) return;
    setTimerActive(false);
    setLoadingEval(true);
    setErrorMsg(null);
    setRetryStatus(null);
    const elapsed = TOTAL_SECONDS - secondsLeft;

    try {
      const data = await withTargetedPdfRetry(
        course,
        level,
        (pdfs) =>
          safeFetchJson<ReflexEvaluation>('/api/reflex/evaluate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            timeoutMs: 45000,
            onRetryStatus: (msg) => setRetryStatus(msg),
            body: JSON.stringify({
              courseName: course.name,
              detectedLanguage: course.detectedLanguage,
              level,
              problemText: problem.problemText,
              lineOneTheorem: lineOne.trim(),
              lineTwoSetup: lineTwo.trim(),
              elapsedSeconds: elapsed,
              userElo,
              pdfs,
            }),
          }),
        2,
      );
      setEvaluation(data);
      onCompleteReflex(level.levelNumber, data, elapsed);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Evaluation failed.';
      setErrorMsg(msg);
      onNotifyError?.(msg);
    } finally {
      setLoadingEval(false);
      setRetryStatus(null);
    }
  };

  const handleInsertLineTwo = (snippet: string) => {
    const el = lineTwoRef.current;
    if (el) {
      const start = el.selectionStart ?? lineTwo.length;
      const end = el.selectionEnd ?? lineTwo.length;
      const next = lineTwo.slice(0, start) + snippet + lineTwo.slice(end);
      setLineTwo(next);
      requestAnimationFrame(() => {
        el.focus();
        const pos = start + snippet.length;
        el.setSelectionRange(pos, pos);
      });
    } else {
      setLineTwo((prev) => prev + snippet);
    }
  };

  if (!problem && !loadingGen) {
    return (
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 md:p-8 space-y-5">
        <div className="space-y-2 max-w-2xl">
          <div className="text-xs font-medium text-amber-700 dark:text-amber-400">
            Mode B · 45-Second Anti-Freeze Exam Reflex
          </div>
          <h3 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            First 2 Lines Trainer — Level {level.levelNumber}
          </h3>
          <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
            Defeat exam freeze by practicing how to start. You get 45 seconds on an exam-caliber problem. Don’t solve it to the end—write only{' '}
            <span className="font-medium text-slate-900 dark:text-slate-100">Line 1 (Governing Theorem/Formula)</span> and{' '}
            <span className="font-medium text-slate-900 dark:text-slate-100">Line 2 (Knowns, Unknowns &amp; Setup Equation)</span>.
          </p>
        </div>

        {errorMsg && (
          <div className="p-3.5 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 text-sm text-red-700 dark:text-red-300">
            {errorMsg}
          </div>
        )}

        <button
          type="button"
          onClick={startDrill}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-sm font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Zap className="w-4 h-4" />
          <span>Start 45s Reflex Drill</span>
        </button>
      </div>
    );
  }

  if (loadingGen) {
    return (
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-10 flex flex-col items-center justify-center gap-3 text-center">
        <Loader2 className="w-6 h-6 animate-spin text-amber-600 dark:text-amber-400" />
        <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {retryStatus || `Pulling an exam-style reflex prompt for Level ${level.levelNumber}…`}
        </p>
      </div>
    );
  }

  const pctRemaining = (secondsLeft / TOTAL_SECONDS) * 100;
  const isUrgent = secondsLeft <= 12 && secondsLeft > 0;
  const isExpired = secondsLeft === 0;

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-6">
      {/* 45s Countdown Bar */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-xs font-medium text-slate-600 dark:text-slate-400">
            <Timer
              className={`w-4 h-4 ${
                isExpired
                  ? 'text-red-600 dark:text-red-400'
                  : isUrgent
                    ? 'text-amber-600 dark:text-amber-400'
                    : 'text-sky-600 dark:text-sky-400'
              }`}
            />
            <span>
              {evaluation
                ? 'Evaluation Complete'
                : isExpired
                  ? 'Time Elapsed — Submit your setup now'
                  : isUrgent
                    ? 'Final Seconds — Lock in your setup'
                    : 'Exam Reflex Clock Running'}
            </span>
          </div>
          <span
            className={`font-mono text-lg font-bold tabular-nums ${
              isExpired
                ? 'text-red-600 dark:text-red-400'
                : isUrgent
                  ? 'text-amber-600 dark:text-amber-400'
                  : 'text-slate-900 dark:text-slate-100'
            }`}
          >
            {String(secondsLeft).padStart(2, '0')}s
          </span>
        </div>

        <div className="h-2 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
          <div
            className={`h-full transition-all duration-500 ${
              isExpired
                ? 'bg-red-600'
                : isUrgent
                  ? 'bg-amber-500'
                  : 'bg-sky-600 dark:bg-sky-500'
            }`}
            style={{ width: `${pctRemaining}%` }}
          />
        </div>
      </div>

      {/* Problem Statement */}
      {problem && (
        <div className="p-4 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950 space-y-2">
          <div className="text-xs text-slate-500 dark:text-slate-400">
            Exam Prompt · {problem.sourceContext}
          </div>
          <MathText
            text={problem.problemText}
            className="text-[15px] text-slate-900 dark:text-slate-100"
          />
        </div>
      )}

      {/* First 2 Lines Inputs */}
      <div className="space-y-4">
        <div className="space-y-1.5">
          <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
            Line 1 · Applicable Theorem, Law, or Method
          </label>
          <input
            type="text"
            disabled={Boolean(evaluation) || loadingEval}
            value={lineOne}
            onChange={(e) => setLineOne(e.target.value)}
            placeholder="e.g., Divergence Theorem / Conservation of Angular Momentum / Master Theorem Case 2..."
            className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3.5 py-2.5 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500 disabled:opacity-75"
          />
        </div>

        <div className="space-y-2">
          <label className="block text-xs font-semibold text-slate-700 dark:text-slate-300">
            Line 2 · Knowns, Unknowns &amp; Initial Setup Equation
          </label>
          <MathHelperBar value={lineTwo} onInsert={handleInsertLineTwo} />
          <textarea
            ref={lineTwoRef}
            rows={3}
            disabled={Boolean(evaluation) || loadingEval}
            value={lineTwo}
            onChange={(e) => setLineTwo(e.target.value)}
            placeholder="e.g., Given v_0, R; unknown ω_f. Setup: $I_i \\omega_i = I_f \\omega_f$..."
            className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3.5 py-2.5 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500 disabled:opacity-75"
          />
        </div>

        {retryStatus && (
          <div className="p-3 rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 text-xs text-amber-800 dark:text-amber-200 flex items-center gap-2">
            <Clock className="w-4 h-4 shrink-0 animate-pulse" />
            <span>{retryStatus}</span>
          </div>
        )}

        {errorMsg && (
          <div className="p-3 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 text-sm text-red-700 dark:text-red-300">
            {errorMsg}
          </div>
        )}

        {!evaluation && (
          <div className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={startDrill}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>New Problem</span>
            </button>
            <button
              type="button"
              disabled={loadingEval || (!lineOne.trim() && !lineTwo.trim())}
              onClick={handleSubmitSetup}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-sky-600 hover:bg-sky-700 disabled:opacity-50 text-white text-sm font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {loadingEval ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  <span>Checking Trajectory…</span>
                </>
              ) : (
                <span>Evaluate First 2 Lines</span>
              )}
            </button>
          </div>
        )}
      </div>

      {/* Reflex Evaluation */}
      {evaluation && (
        <div className="space-y-4 pt-4 border-t border-slate-200 dark:border-slate-800">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              {evaluation.verdict === 'valid' ? (
                <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
              ) : evaluation.verdict === 'partial' ? (
                <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400" />
              ) : (
                <XCircle className="w-5 h-5 text-red-600 dark:text-red-400" />
              )}
              <span className="text-base font-semibold text-slate-900 dark:text-slate-100">
                {evaluation.verdict === 'valid'
                  ? 'Valid Solution Trajectory'
                  : evaluation.verdict === 'partial'
                    ? 'Partial Setup — Needs Refinement'
                    : 'Wrong Starting Direction'}
              </span>
            </div>
            <div className="text-sm font-mono tabular-nums text-slate-600 dark:text-slate-300">
              Setup Score: <span className="font-semibold">{evaluation.score}%</span> · Elo:{' '}
              <span
                className={
                  evaluation.eloDelta >= 0
                    ? 'text-emerald-600 dark:text-emerald-400 font-semibold'
                    : 'text-amber-600 dark:text-amber-400 font-semibold'
                }
              >
                {evaluation.eloDelta >= 0 ? `+${evaluation.eloDelta}` : evaluation.eloDelta}
              </span>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-1">
              <h4 className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                Trajectory Assessment
              </h4>
              <MathText
                text={evaluation.trajectoryAssessment}
                className="text-sm text-slate-800 dark:text-slate-200"
              />
            </div>
            <div className="space-y-1">
              <h4 className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                Gaps or Boundary Conditions
              </h4>
              <MathText
                text={evaluation.missingOrWrong}
                className="text-sm text-slate-800 dark:text-slate-200"
              />
            </div>
          </div>

          <div className="p-4 rounded-lg bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 space-y-1.5">
            <h4 className="text-xs font-semibold text-slate-500 dark:text-slate-400">
              Optimal First 2 Lines
            </h4>
            <MathText
              text={evaluation.optimalFirstTwoLines}
              className="text-sm text-slate-800 dark:text-slate-200"
            />
          </div>

          <div className="flex justify-end">
            <button
              type="button"
              onClick={startDrill}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 text-sm font-medium hover:opacity-90 transition-opacity cursor-pointer"
            >
              <RotateCcw className="w-4 h-4" />
              <span>Run Next 45s Drill</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
