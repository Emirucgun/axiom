import React, { useState, useEffect, useRef } from 'react';
import {
  BookOpen,
  Lightbulb,
  CheckCircle2,
  AlertTriangle,
  ArrowRight,
  Send,
  Loader2,
  RotateCcw,
  HelpCircle,
  AlertCircle,
  Clock,
} from 'lucide-react';
import type { Course, LessonDoubtMessage, LevelLesson, SkillLevel } from '../types';
import { safeFetchJson } from '../utils/apiClient';
import {
  getLevelCache,
  saveLessonDoubts,
  saveLevelLesson,
  withLevelPdfContext,
} from '../services/courseService';
import { MathText } from './MathText';

interface LevelLessonPanelProps {
  course: Course;
  level: SkillLevel;
  onReadyToTest: () => void;
  onNotifyError?: (message: string) => void;
}

export const LevelLessonPanel: React.FC<LevelLessonPanelProps> = ({
  course,
  level,
  onReadyToTest,
  onNotifyError,
}) => {
  const [lesson, setLesson] = useState<LevelLesson | null>(null);
  const [doubts, setDoubts] = useState<LessonDoubtMessage[]>([]);
  const [doubtInput, setDoubtInput] = useState('');
  const [loadingLesson, setLoadingLesson] = useState(false);
  const [loadingDoubt, setLoadingDoubt] = useState(false);
  const [retryStatus, setRetryStatus] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchLesson = async (forceRefresh = false) => {
    setLoadingLesson(true);
    setErrorMsg(null);
    setRetryStatus(null);

    try {
      // 1) Supabase cache first — generated once, shared across all devices
      if (!forceRefresh) {
        setRetryStatus('Checking your saved lesson…');
        const cached = await getLevelCache(level.id);
        if (!mountedRef.current) return;
        if (cached.lesson) {
          setLesson(cached.lesson);
          setDoubts(cached.doubts);
          return;
        }
        setRetryStatus(null);
      }

      // 2) Cache miss: pull only this level's 1–2 PDFs and generate via Gemini
      const data = await withLevelPdfContext(
        course,
        level,
        (pdfs) =>
          safeFetchJson<LevelLesson>('/api/lesson/generate', {
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
      setLesson(data);
      if (forceRefresh) {
        setDoubts([]);
      }
      // 3) Persist back to the levels row so every device sees it instantly
      await saveLevelLesson(level.id, data, forceRefresh);
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = err instanceof Error ? err.message : 'Unable to generate mini-lesson.';
      setErrorMsg(msg);
      onNotifyError?.(msg);
    } finally {
      if (mountedRef.current) {
        setLoadingLesson(false);
        setRetryStatus(null);
      }
    }
  };

  useEffect(() => {
    setLesson(null);
    setDoubts([]);
    fetchLesson(false);
  }, [course.id, level.id]);

  const handleAskDoubt = async (e: React.FormEvent) => {
    e.preventDefault();
    const question = doubtInput.trim();
    if (!question || loadingDoubt || !lesson) return;

    const userMsg: LessonDoubtMessage = { role: 'user', content: question };
    const nextWithUser = [...doubts, userMsg];
    setDoubts(nextWithUser);
    setDoubtInput('');
    setLoadingDoubt(true);
    setErrorMsg(null);

    try {
      const lessonSummary = [
        lesson.title,
        lesson.intuition,
        ...lesson.sections.map((s) => `${s.heading}: ${s.bullets.join(' ')}`),
        `Worked Example: ${lesson.workedExample.problemStatement} -> ${lesson.workedExample.finalAnswer}`,
      ].join('\n');

      const res = await withLevelPdfContext(
        course,
        level,
        (pdfs) =>
          safeFetchJson<{ answer: string }>('/api/lesson/doubt', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            timeoutMs: 45000,
            onRetryStatus: (msg) => {
              if (mountedRef.current) setRetryStatus(msg);
            },
            body: JSON.stringify({
              courseName: course.name,
              detectedLanguage: course.detectedLanguage,
              level: {
                levelNumber: level.levelNumber,
                title: level.title,
                keyFormulas: level.keyFormulas,
              },
              lessonSummary,
              doubtQuestion: question,
              history: doubts,
              pdfs,
            }),
          }),
        2,
      );

      if (!mountedRef.current) return;
      const updated = [...nextWithUser, { role: 'ai' as const, content: res.answer }];
      setDoubts(updated);
      await saveLessonDoubts(level.id, updated);
    } catch (err) {
      if (!mountedRef.current) return;
      const msg = err instanceof Error ? err.message : 'Unable to answer doubt right now.';
      setErrorMsg(msg);
      onNotifyError?.(msg);
    } finally {
      if (mountedRef.current) {
        setLoadingDoubt(false);
        setRetryStatus(null);
      }
    }
  };

  const matchedNames = (
    level.relevantPdfNames && level.relevantPdfNames.length > 0
      ? level.relevantPdfNames
      : (level.sourcePdfNames ?? [])
  ).slice(0, 2);

  if (loadingLesson && !lesson) {
    return (
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-10 flex flex-col items-center justify-center gap-3 text-center">
        <Loader2 className="w-6 h-6 animate-spin text-sky-600 dark:text-sky-400" />
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
            {retryStatus || `Preparing Step 1 Mini-Lesson for Level ${level.levelNumber}…`}
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {matchedNames.length > 0
              ? `Reading matched source${matchedNames.length > 1 ? 's' : ''}: ${matchedNames.join(', ')}`
              : 'Building intuition, governing equations, and a solved example.'}
          </p>
        </div>
      </div>
    );
  }

  if (!lesson && errorMsg) {
    return (
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4">
        <div className="p-3.5 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 text-sm text-red-700 dark:text-red-300 flex items-start gap-2.5">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{errorMsg}</span>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => fetchLesson(false)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-medium cursor-pointer"
          >
            <RotateCcw className="w-4 h-4" />
            <span>Retry Mini-Lesson</span>
          </button>
          <button
            type="button"
            onClick={onReadyToTest}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 text-sm font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800 cursor-pointer"
          >
            <span>Skip to Level Challenge</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  }

  if (!lesson) return null;

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 md:p-7 space-y-6">
        {/* Lesson Header */}
        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-4">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-xs text-sky-700 dark:text-sky-400 font-medium">
              <BookOpen className="w-3.5 h-3.5" />
              <span>Step 1 · Mini-Lesson &amp; Worked Example</span>
              {matchedNames.length > 0 && (
                <span className="font-mono text-[11px] text-slate-500 dark:text-slate-400 font-normal">
                  · Sources: {matchedNames.join(', ')}
                </span>
              )}
            </div>
            <h3 className="text-xl font-bold text-slate-900 dark:text-slate-100">
              {lesson.title}
            </h3>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <button
              type="button"
              disabled={loadingLesson}
              onClick={() => fetchLesson(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 whitespace-nowrap cursor-pointer"
            >
              {loadingLesson ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RotateCcw className="w-3.5 h-3.5" />
              )}
              <span>Regenerate Lesson</span>
            </button>
            <button
              type="button"
              onClick={onReadyToTest}
              className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-xs font-semibold transition-colors whitespace-nowrap cursor-pointer"
            >
              <span>I&apos;m Ready — Start Level Challenge</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* Live 429 cooldown notice if regenerating or asking doubt */}
        {retryStatus && (
          <div className="p-3 rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 text-xs text-amber-800 dark:text-amber-200 flex items-center gap-2">
            <Clock className="w-4 h-4 shrink-0 animate-pulse" />
            <span>{retryStatus}</span>
          </div>
        )}

        {/* Intuition First Callout */}
        <div className="rounded-lg border border-sky-200/80 dark:border-sky-900/60 bg-sky-50/60 dark:bg-sky-950/25 p-4 space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-sky-800 dark:text-sky-300">
            <Lightbulb className="w-3.5 h-3.5" />
            <span>Core Intuition (Why It Works)</span>
          </div>
          <MathText
            text={lesson.intuition}
            className="text-sm text-slate-800 dark:text-slate-200 leading-relaxed"
          />
        </div>

        {/* Concept Breakdown Sections */}
        <div className="grid grid-cols-1 gap-4">
          {lesson.sections.map((sec, idx) => (
            <section
              key={idx}
              className="rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/40 p-4 space-y-2.5"
            >
              <h4 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                {idx + 1}. {sec.heading}
              </h4>
              <ul className="list-disc pl-5 space-y-1.5 text-sm text-slate-700 dark:text-slate-300">
                {sec.bullets.map((bullet, bIdx) => (
                  <li key={bIdx}>
                    <MathText text={bullet} />
                  </li>
                ))}
              </ul>
              {sec.keyEquation && sec.keyEquation.trim() && (
                <div className="mt-2 px-3.5 py-2.5 rounded-md bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-sm text-slate-900 dark:text-slate-100 overflow-x-auto">
                  <MathText text={sec.keyEquation} />
                </div>
              )}
            </section>
          ))}
        </div>

        {/* 1 Fully Solved Step-by-Step Worked Example */}
        <div className="rounded-xl border border-emerald-200/90 dark:border-emerald-900/60 bg-emerald-50/40 dark:bg-emerald-950/20 p-5 space-y-4">
          <div className="flex items-center gap-2 text-xs font-semibold text-emerald-800 dark:text-emerald-300">
            <CheckCircle2 className="w-4 h-4" />
            <span>Worked Example (Step-by-Step Solution)</span>
          </div>

          <div className="p-3.5 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 space-y-1">
            <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400">
              PROBLEM STATEMENT
            </div>
            <MathText
              text={lesson.workedExample.problemStatement}
              className="text-sm text-slate-900 dark:text-slate-100 font-medium"
            />
          </div>

          <div className="space-y-2.5">
            {lesson.workedExample.steps.map((step, sIdx) => (
              <div key={sIdx} className="flex items-start gap-3 text-sm">
                <span className="font-mono text-xs font-semibold px-2 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/50 text-emerald-800 dark:text-emerald-200 shrink-0 mt-0.5 tabular-nums">
                  Step {sIdx + 1}
                </span>
                <MathText
                  text={step}
                  className="text-slate-800 dark:text-slate-200 flex-1 min-w-0"
                />
              </div>
            ))}
          </div>

          <div className="pt-3 border-t border-emerald-200/70 dark:border-emerald-900/50 grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            <div className="p-3 rounded-lg bg-white dark:bg-slate-900 border border-emerald-200/80 dark:border-emerald-900/50">
              <div className="text-[11px] font-mono text-emerald-700 dark:text-emerald-400 mb-1">
                FINAL RESULT
              </div>
              <MathText
                text={lesson.workedExample.finalAnswer}
                className="text-slate-900 dark:text-slate-100 font-medium"
              />
            </div>
            <div className="p-3 rounded-lg bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800">
              <div className="text-[11px] font-mono text-slate-500 dark:text-slate-400 mb-1">
                EXAM TAKEAWAY
              </div>
              <MathText
                text={lesson.workedExample.takeaway}
                className="text-slate-700 dark:text-slate-300"
              />
            </div>
          </div>
        </div>

        {/* Common Exam Pitfalls */}
        {lesson.commonPitfalls && lesson.commonPitfalls.length > 0 && (
          <div className="rounded-lg border border-amber-200/80 dark:border-amber-900/50 bg-amber-50/40 dark:bg-amber-950/20 p-4 space-y-2">
            <div className="flex items-center gap-1.5 text-xs font-semibold text-amber-800 dark:text-amber-300">
              <AlertTriangle className="w-3.5 h-3.5" />
              <span>Common Mistakes to Watch For</span>
            </div>
            <ul className="list-disc pl-5 space-y-1 text-xs sm:text-sm text-slate-700 dark:text-slate-300">
              {lesson.commonPitfalls.map((pitfall, pIdx) => (
                <li key={pIdx}>
                  <MathText text={pitfall} />
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Interactive "Ask a quick doubt about this lesson" */}
        <div className="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-3">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-700 dark:text-slate-300">
            <HelpCircle className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" />
            <span>Ask a quick doubt about this lesson</span>
          </div>

          {doubts.length > 0 && (
            <div className="space-y-2.5 max-h-64 overflow-y-auto pr-1">
              {doubts.map((d, idx) => (
                <div
                  key={idx}
                  className={`rounded-lg px-3.5 py-2.5 text-sm ${
                    d.role === 'user'
                      ? 'bg-sky-50 dark:bg-sky-950/40 border border-sky-200/80 dark:border-sky-900/60 text-slate-900 dark:text-slate-100'
                      : 'bg-slate-50 dark:bg-slate-950 border border-slate-200 dark:border-slate-800 text-slate-800 dark:text-slate-200'
                  }`}
                >
                  <div className="text-[11px] font-medium text-slate-500 dark:text-slate-400 mb-1">
                    {d.role === 'user' ? 'Your Question' : 'Professor Clarification'}
                  </div>
                  <MathText text={d.content} />
                </div>
              ))}
            </div>
          )}

          {errorMsg && (
            <div className="p-3 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 text-xs text-red-700 dark:text-red-300">
              {errorMsg}
            </div>
          )}

          <form onSubmit={handleAskDoubt} className="flex flex-col sm:flex-row gap-2">
            <input
              type="text"
              disabled={loadingDoubt}
              value={doubtInput}
              onChange={(e) => setDoubtInput(e.target.value)}
              placeholder="e.g., Why did we change the integration bounds in Step 2? (supports $...$)"
              className="flex-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3.5 py-2 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500"
            />
            <button
              type="submit"
              disabled={loadingDoubt || !doubtInput.trim()}
              className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 text-xs font-medium text-slate-800 dark:text-slate-200 whitespace-nowrap shrink-0 cursor-pointer"
            >
              {loadingDoubt ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Answering…</span>
                </>
              ) : (
                <>
                  <Send className="w-3.5 h-3.5" />
                  <span>Ask Doubt</span>
                </>
              )}
            </button>
          </form>
        </div>

        {/* Bottom Prominent Step 2 CTA */}
        <div className="pt-3 border-t border-slate-200 dark:border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <span className="text-xs text-slate-500 dark:text-slate-400">
            Finished reviewing the concepts and worked example? Test your mastery in Step 2.
          </span>
          <button
            type="button"
            onClick={onReadyToTest}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <span>I&apos;m Ready — Start Level Challenge</span>
            <ArrowRight className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
