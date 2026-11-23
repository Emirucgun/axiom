import React, { useState, useRef, useEffect } from 'react';
import { MessageSquare, Send, Award, RotateCcw, Loader2, CheckCircle2, AlertCircle, Clock } from 'lucide-react';
import type { Course, FeynmanMessage, FeynmanTurnResponse, SkillLevel } from '../types';
import { withTargetedPdfRetry } from '../utils/pdfStorage';
import { safeFetchJson } from '../utils/apiClient';
import { MathText } from './MathText';
import { MathHelperBar } from './MathHelperBar';

interface FeynmanModeProps {
  course: Course;
  level: SkillLevel;
  userElo: number;
  onCompleteFeynman: (
    levelNumber: number,
    clarityScore: number,
    eloDelta: number,
  ) => void;
  onNotifyError?: (message: string) => void;
}

export const FeynmanMode: React.FC<FeynmanModeProps> = ({
  course,
  level,
  userElo,
  onCompleteFeynman,
  onNotifyError,
}) => {
  const [messages, setMessages] = useState<FeynmanMessage[]>([]);
  const [input, setInput] = useState('');
  const [lastAssessment, setLastAssessment] = useState<string>('');
  const [finalResult, setFinalResult] = useState<FeynmanTurnResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [retryStatus, setRetryStatus] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const scrollEndRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    scrollEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, finalResult]);

  const callFeynmanApi = async (history: FeynmanMessage[], forceEvaluate = false) => {
    setLoading(true);
    setErrorMsg(null);
    setRetryStatus(null);

    try {
      const data = await withTargetedPdfRetry(
        course,
        level,
        (pdfs) =>
          safeFetchJson<FeynmanTurnResponse>('/api/feynman/turn', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            timeoutMs: 45000,
            onRetryStatus: (msg) => setRetryStatus(msg),
            body: JSON.stringify({
              courseName: course.name,
              detectedLanguage: course.detectedLanguage,
              courseDigest: course.courseDigest,
              level,
              history: history.map((m) => ({ role: m.role, content: m.content })),
              forceEvaluate,
              userElo,
              pdfs,
            }),
          }),
        2,
      );

      const aiMsg: FeynmanMessage = {
        role: 'ai',
        content: data.reply,
        timestamp: new Date().toISOString(),
      };
      setMessages([...history, aiMsg]);
      setLastAssessment(data.turnAssessment);

      if (data.readyToScore && typeof data.clarityScore === 'number') {
        setFinalResult(data);
        onCompleteFeynman(level.levelNumber, data.clarityScore, data.eloDelta ?? 0);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Feynman dialogue failed.';
      setErrorMsg(msg);
      onNotifyError?.(msg);
    } finally {
      setLoading(false);
      setRetryStatus(null);
    }
  };

  const startSession = () => {
    setMessages([]);
    setFinalResult(null);
    setLastAssessment('');
    setInput('');
    callFeynmanApi([], false);
  };

  const handleSend = () => {
    const trimmed = input.trim();
    if (!trimmed || loading || finalResult) return;
    const userMsg: FeynmanMessage = {
      role: 'user',
      content: trimmed,
      timestamp: new Date().toISOString(),
    };
    const nextHistory = [...messages, userMsg];
    setMessages(nextHistory);
    setInput('');
    callFeynmanApi(nextHistory, false);
  };

  const handleInsertMath = (snippet: string) => {
    const el = textareaRef.current;
    if (el) {
      const start = el.selectionStart ?? input.length;
      const end = el.selectionEnd ?? input.length;
      const next = input.slice(0, start) + snippet + input.slice(end);
      setInput(next);
      requestAnimationFrame(() => {
        el.focus();
        const pos = start + snippet.length;
        el.setSelectionRange(pos, pos);
      });
    } else {
      setInput((prev) => prev + snippet);
    }
  };

  const userTurnCount = messages.filter((m) => m.role === 'user').length;

  if (messages.length === 0 && !loading) {
    return (
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 md:p-8 space-y-5">
        <div className="space-y-2 max-w-2xl">
          <div className="text-xs font-medium text-emerald-700 dark:text-emerald-400">
            Mode C · Feynman Role-Reversal Teach-Back
          </div>
          <h3 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Teach the Classmate — Level {level.levelNumber}
          </h3>
          <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
            True mastery means explaining without hand-waving. The AI plays a confused engineering classmate who interrupts with sharp “why?” questions until your explanation is airtight—then awards a{' '}
            <span className="font-medium text-slate-900 dark:text-slate-100">Concept Clarity Score (0–100%)</span>.
          </p>
        </div>

        {errorMsg && (
          <div className="p-3.5 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 text-sm text-red-700 dark:text-red-300">
            {errorMsg}
          </div>
        )}

        <button
          type="button"
          onClick={startSession}
          className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <MessageSquare className="w-4 h-4" />
          <span>Start Teach-Back Session</span>
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-5">
      {/* Header row */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 dark:border-slate-800 pb-3">
        <div className="text-xs text-slate-500 dark:text-slate-400">
          Feynman Teach-Back · Level {level.levelNumber} · Explanations given:{' '}
          <span className="font-mono font-semibold text-slate-800 dark:text-slate-200 tabular-nums">
            {userTurnCount}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {userTurnCount >= 2 && !finalResult && (
            <button
              type="button"
              disabled={loading}
              onClick={() => callFeynmanApi(messages, true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-300 hover:bg-emerald-50 dark:hover:bg-emerald-950/50 text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              <Award className="w-3.5 h-3.5" />
              <span>Finish &amp; Score Clarity</span>
            </button>
          )}
          <button
            type="button"
            disabled={loading}
            onClick={startSession}
            className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Restart</span>
          </button>
        </div>
      </div>

      {/* Chat Transcript */}
      <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1">
        {messages.map((m, idx) => (
          <div
            key={idx}
            className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
          >
            <div
              className={`max-w-[85%] rounded-xl px-4 py-3 text-sm leading-relaxed ${
                m.role === 'user'
                  ? 'bg-sky-600 text-white'
                  : 'bg-slate-100 dark:bg-slate-800 text-slate-900 dark:text-slate-100 border border-slate-200 dark:border-slate-700'
              }`}
            >
              <div
                className={`text-[11px] font-medium mb-1 ${
                  m.role === 'user' ? 'text-sky-100' : 'text-slate-500 dark:text-slate-400'
                }`}
              >
                {m.role === 'user' ? 'You (Teacher)' : 'Confused Classmate'}
              </div>
              <MathText
                text={m.content}
                className={m.role === 'user' ? 'text-white [&_.katex]:text-white' : ''}
              />
            </div>
          </div>
        ))}

        {loading && (
          <div className="flex justify-start">
            <div className="rounded-xl px-4 py-3 bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-xs text-slate-500 dark:text-slate-400 flex items-center gap-2">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span>{retryStatus || 'Classmate is thinking through your explanation…'}</span>
            </div>
          </div>
        )}
        <div ref={scrollEndRef} />
      </div>

      {retryStatus && !loading && (
        <div className="p-3 rounded-lg border border-amber-200 dark:border-amber-900/60 bg-amber-50 dark:bg-amber-950/30 text-xs text-amber-800 dark:text-amber-200 flex items-center gap-2">
          <Clock className="w-4 h-4 shrink-0 animate-pulse" />
          <span>{retryStatus}</span>
        </div>
      )}

      {lastAssessment && !finalResult && (
        <div className="text-xs text-slate-500 dark:text-slate-400 border-t border-slate-100 dark:border-slate-800/80 pt-2">
          <span className="font-medium text-slate-700 dark:text-slate-300">Probe Note: </span>
          {lastAssessment}
        </div>
      )}

      {errorMsg && (
        <div className="p-3 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 text-sm text-red-700 dark:text-red-300 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}

      {/* Composer or Final Clarity Report */}
      {!finalResult ? (
        <div className="space-y-2.5 pt-2 border-t border-slate-200 dark:border-slate-800">
          <MathHelperBar value={input} onInsert={handleInsertMath} />
          <div className="flex flex-col sm:flex-row gap-2.5">
            <textarea
              ref={textareaRef}
              rows={3}
              disabled={loading}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="Explain the concept in clear intuition + key math ($...$). Press Ctrl+Enter to send…"
              className="flex-1 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3.5 py-2.5 text-sm text-slate-900 dark:text-slate-100 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500"
            />
            <button
              type="button"
              disabled={loading || !input.trim()}
              onClick={handleSend}
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-lg bg-sky-600 hover:bg-sky-700 disabled:opacity-50 text-white text-sm font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer self-end sm:self-stretch"
            >
              <Send className="w-4 h-4" />
              <span>Explain</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="p-5 rounded-xl border border-emerald-200 dark:border-emerald-900/60 bg-emerald-50/60 dark:bg-emerald-950/30 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="w-5 h-5 text-emerald-600 dark:text-emerald-400" />
              <span className="text-base font-semibold text-slate-900 dark:text-slate-100">
                Concept Clarity Score: <span className="font-mono tabular-nums">{finalResult.clarityScore}%</span>
              </span>
            </div>
            {typeof finalResult.eloDelta === 'number' && (
              <span className="text-sm font-mono tabular-nums font-semibold text-emerald-700 dark:text-emerald-400">
                Elo: {finalResult.eloDelta >= 0 ? `+${finalResult.eloDelta}` : finalResult.eloDelta}
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
            <div className="space-y-1.5">
              <h4 className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                What You Explained Clearly
              </h4>
              <ul className="list-disc pl-4 space-y-1 text-slate-700 dark:text-slate-300">
                {(finalResult.strengths || []).map((s, i) => (
                  <li key={i}>
                    <MathText text={s} />
                  </li>
                ))}
              </ul>
            </div>
            <div className="space-y-1.5">
              <h4 className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                Logical Gaps to Tighten
              </h4>
              <ul className="list-disc pl-4 space-y-1 text-slate-700 dark:text-slate-300">
                {(finalResult.gaps || []).length > 0 ? (
                  (finalResult.gaps || []).map((g, i) => (
                    <li key={i}>
                      <MathText text={g} />
                    </li>
                  ))
                ) : (
                  <li>No major conceptual blind spots detected.</li>
                )}
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
