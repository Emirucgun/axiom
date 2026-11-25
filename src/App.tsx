import React, { useState, useEffect, useCallback } from 'react';
import type { Session } from '@supabase/supabase-js';
import {
  Plus,
  Download,
  Sun,
  Moon,
  BookOpen,
  Trash2,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  AlertCircle,
  Menu,
  X,
  ArrowUpRight,
  Flame,
  LogOut,
  Loader2,
  TrendingUp,
  KeyRound,
} from 'lucide-react';
import type {
  Course,
  ReflexEvaluation,
  SessionRecord,
  StudyMode,
  UserProfile,
} from './types';
import {
  loadThemePreference,
  saveThemePreference,
  computeCourseReadiness,
} from './utils/persistence';
import { isSupabaseConfigured, supabase } from './lib/supabase';
import {
  clearGeminiUriCache,
  createCourse,
  deleteCourse,
  fetchCourse,
  listCourses,
} from './services/courseService';
import type { ApiKeyStatus } from './services/apiKeyService';
import { getApiKeyStatus, isAiAvailable } from './services/apiKeyService';
import { ApiKeySettings } from './components/ApiKeySettings';
import {
  applyEloDelta,
  buildExportBackup,
  getProfile,
  listStudySessions,
  PASS_THRESHOLD,
  recordStudyAttempt,
} from './services/studyService';
import { AuthGate, SupabaseSetupRequired } from './components/AuthGate';
import { TelemetryStrip } from './components/TelemetryStrip';
import { CourseMaterialPanel } from './components/CourseMaterialPanel';
import { SkillTree } from './components/SkillTree';
import { LevelLessonPanel } from './components/LevelLessonPanel';
import { LevelClimbMode } from './components/LevelClimbMode';
import { FirstTwoLinesMode } from './components/FirstTwoLinesMode';
import { FeynmanMode } from './components/FeynmanMode';
import { NewCourseModal } from './components/NewCourseModal';
import { MathText } from './components/MathText';

type WorkspaceView = 'tree' | 'studio' | 'history';

function FullScreenSpinner({ label }: { label: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center gap-2.5 bg-slate-50 dark:bg-[#0B0F17] text-sm text-slate-500 dark:text-slate-400">
      <Loader2 className="w-4 h-4 animate-spin text-sky-600 dark:text-sky-400" />
      <span>{label}</span>
    </div>
  );
}

function useThemeSync(): ['light' | 'dark', React.Dispatch<React.SetStateAction<'light' | 'dark'>>] {
  const [theme, setTheme] = useState<'light' | 'dark'>(() => loadThemePreference());
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark');
    saveThemePreference(theme);
  }, [theme]);
  return [theme, setTheme];
}

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  // Apply the saved theme on the auth screens too
  useThemeSync();

  useEffect(() => {
    if (!isSupabaseConfigured) return;
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setAuthReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      setAuthReady(true);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  if (!isSupabaseConfigured) return <SupabaseSetupRequired />;
  if (!authReady) return <FullScreenSpinner label="Loading…" />;
  if (!session) return <AuthGate />;
  // Keyed by user id so switching accounts fully resets workspace state
  return <Workspace key={session.user.id} />;
}

function Workspace() {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [activeCourseId, setActiveCourseId] = useState<string | null>(null);
  const [dataLoading, setDataLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [theme, setTheme] = useThemeSync();
  const [activeView, setActiveView] = useState<WorkspaceView>('tree');
  const [selectedLevelNum, setSelectedLevelNum] = useState<number>(1);
  const [levelStep, setLevelStep] = useState<'learn' | 'test'>('learn');
  const [studyMode, setStudyMode] = useState<StudyMode>('climb');
  const [showMaterials, setShowMaterials] = useState<boolean>(true);
  const [newCourseOpen, setNewCourseOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [confirmDeleteCourseId, setConfirmDeleteCourseId] = useState<string | null>(null);
  const [deletingCourseId, setDeletingCourseId] = useState<string | null>(null);
  const [apiKeyStatus, setApiKeyStatus] = useState<ApiKeyStatus | null>(null);
  const [apiKeyOpen, setApiKeyOpen] = useState(false);
  const [bannerMessage, setBannerMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  // Warm up backend server on mount after idle scale-to-zero
  useEffect(() => {
    fetch('/api/health').catch(() => {});
  }, []);

  // Initial load of everything the signed-in user owns
  const loadWorkspace = useCallback(async () => {
    setDataLoading(true);
    setLoadError(null);
    try {
      const [nextProfile, nextCourses] = await Promise.all([getProfile(), listCourses()]);
      const nextSessions = await listStudySessions(nextCourses);
      setProfile(nextProfile);
      setCourses(nextCourses);
      setSessions(nextSessions);
      setActiveCourseId((prev) => prev ?? nextCourses[0]?.id ?? null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : 'Failed to load your workspace.');
    } finally {
      setDataLoading(false);
    }
  }, []);

  useEffect(() => {
    loadWorkspace();
    // BYOK status is non-blocking: the workspace works without it
    getApiKeyStatus()
      .then(setApiKeyStatus)
      .catch(() => setApiKeyStatus(null));
  }, [loadWorkspace]);

  const handleApiKeyChanged = async (next: ApiKeyStatus) => {
    setApiKeyStatus(next);
    // The server cleared cached Gemini file handles (they're tied to the key);
    // drop ours too and reload PDF metadata so nothing stale is reused.
    clearGeminiUriCache();
    try {
      setCourses(await listCourses());
    } catch {
      // Non-fatal: stale handles are also refreshed on first use
    }
  };

  const activeCourse =
    courses.find((c) => c.id === activeCourseId) ?? courses[0] ?? null;

  // Auto-collapse materials panel if roadmap exists and user switches courses
  useEffect(() => {
    if (activeCourse) {
      setShowMaterials(activeCourse.levels.length === 0);
      const highestUnlocked =
        [...activeCourse.levels].reverse().find((l) => l.unlocked)?.levelNumber ?? 1;
      setSelectedLevelNum((prev) => {
        const existsAndUnlocked = activeCourse.levels.some(
          (l) => l.levelNumber === prev && l.unlocked,
        );
        return existsAndUnlocked ? prev : highestUnlocked;
      });
    }
  }, [activeCourse?.id, activeCourse?.levels.length]);

  const showToast = (type: 'success' | 'error', text: string) => {
    setBannerMessage({ type, text });
    const duration = type === 'error' ? 7500 : 4500;
    window.setTimeout(() => {
      setBannerMessage((curr) => (curr?.text === text ? null : curr));
    }, duration);
  };

  const replaceCourse = (updated: Course) => {
    setCourses((prev) => prev.map((c) => (c.id === updated.id ? updated : c)));
  };

  const handleCreateCourse = async (input: { name: string; code: string; examDate?: string }) => {
    const course = await createCourse(input);
    setCourses((prev) => [...prev, course]);
    setActiveCourseId(course.id);
    setActiveView('tree');
    setShowMaterials(true);
    setMobileSidebarOpen(false);
  };

  const handleUpdateCourse = (updated: Course) => {
    const hadNoLevels = (courses.find((c) => c.id === updated.id)?.levels.length ?? 0) === 0;
    replaceCourse(updated);
    if (updated.levels.length > 0 && showMaterials && hadNoLevels) {
      setShowMaterials(false);
    }
  };

  const handleDeleteCourse = async (courseId: string) => {
    setDeletingCourseId(courseId);
    try {
      await deleteCourse(courseId);
      const remaining = courses.filter((c) => c.id !== courseId);
      setCourses(remaining);
      setSessions((prev) => prev.filter((s) => s.courseId !== courseId));
      if (activeCourseId === courseId) {
        setActiveCourseId(remaining[0]?.id ?? null);
      }
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to delete course.');
    } finally {
      setDeletingCourseId(null);
      setConfirmDeleteCourseId(null);
    }
  };

  /** Re-reads the course's levels (unlocks, best scores) and the session log from Supabase. */
  const refreshAfterAttempt = async (courseId: string) => {
    const updated = await fetchCourse(courseId);
    const nextCourses = courses.map((c) => (c.id === courseId ? updated : c));
    setCourses(nextCourses);
    setSessions(await listStudySessions(nextCourses));
  };

  const findLevelId = (levelNumber: number): string | null =>
    activeCourse?.levels.find((l) => l.levelNumber === levelNumber)?.id ?? null;

  const handleApplySingleElo = async (delta: number) => {
    // Optimistic update, then reconcile with the server value
    setProfile((p) => (p ? { ...p, elo: Math.max(600, p.elo + delta) } : p));
    try {
      const elo = await applyEloDelta(delta);
      setProfile((p) => (p ? { ...p, elo } : p));
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to save Elo change.');
    }
  };

  const handleCompleteClimb = async (
    levelNumber: number,
    averageScore: number,
    totalEloDelta: number,
    summaryText: string,
  ) => {
    const levelId = findLevelId(levelNumber);
    if (!activeCourse || !levelId) return;

    try {
      const result = await recordStudyAttempt({
        levelId,
        mode: 'climb',
        score: averageScore,
        eloDelta: totalEloDelta,
        summary: summaryText,
        // Elo was already applied per graded question
        applyElo: false,
      });
      setProfile((p) => (p ? { ...p, elo: result.elo, streakDays: result.streakDays, lastStudyDate: result.lastStudyDate } : p));
      await refreshAfterAttempt(activeCourse.id);

      if (result.passed) {
        showToast(
          'success',
          levelNumber < 10
            ? `Level ${levelNumber} mastered (${averageScore}%). Level ${levelNumber + 1} unlocked!`
            : `Level 10 mastered (${averageScore}%)! Distinction tier complete.`,
        );
      } else if (averageScore < PASS_THRESHOLD) {
        showToast('error', `Scored ${averageScore}% — reach ${PASS_THRESHOLD}% to unlock the next level.`);
      }
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to save Level Climb result.');
    }
  };

  const handleCompleteReflex = async (
    levelNumber: number,
    evaluation: ReflexEvaluation,
    elapsedSeconds: number,
  ) => {
    const levelId = findLevelId(levelNumber);
    if (!activeCourse || !levelId) return;

    try {
      const result = await recordStudyAttempt({
        levelId,
        mode: 'reflex',
        score: evaluation.score,
        eloDelta: evaluation.eloDelta,
        passed: evaluation.verdict === 'valid',
        summary: `First 2 Lines in ${elapsedSeconds}s (${evaluation.verdict})`,
      });
      setProfile((p) => (p ? { ...p, elo: result.elo, streakDays: result.streakDays, lastStudyDate: result.lastStudyDate } : p));
      await refreshAfterAttempt(activeCourse.id);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to save First 2 Lines result.');
    }
  };

  const handleCompleteFeynman = async (
    levelNumber: number,
    clarityScore: number,
    eloDelta: number,
  ) => {
    const levelId = findLevelId(levelNumber);
    if (!activeCourse || !levelId) return;

    try {
      const result = await recordStudyAttempt({
        levelId,
        mode: 'feynman',
        score: clarityScore,
        eloDelta,
        summary: `Feynman Clarity Score: ${clarityScore}%`,
      });
      setProfile((p) => (p ? { ...p, elo: result.elo, streakDays: result.streakDays, lastStudyDate: result.lastStudyDate } : p));
      await refreshAfterAttempt(activeCourse.id);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Failed to save Feynman result.');
    }
  };

  const handleExportJson = async () => {
    try {
      const backup = await buildExportBackup();
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `axiom-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('success', 'Progress backup exported as JSON.');
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Export failed.');
    }
  };

  const handleSignOut = async () => {
    const { error } = await supabase.auth.signOut();
    if (error) showToast('error', error.message);
  };

  if (dataLoading && !profile) {
    return <FullScreenSpinner label="Loading your courses…" />;
  }

  if (loadError && !profile) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-50 dark:bg-[#0B0F17] px-4">
        <div className="w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-4">
          <div className="flex items-start gap-2.5 text-sm text-red-700 dark:text-red-300">
            <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
            <span>{loadError}</span>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={loadWorkspace}
              className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-xs font-medium cursor-pointer"
            >
              Retry
            </button>
            <button
              type="button"
              onClick={handleSignOut}
              className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-600 dark:text-slate-300 cursor-pointer"
            >
              Sign out
            </button>
          </div>
        </div>
      </div>
    );
  }

  const elo = profile?.elo ?? 1000;
  const streakDays = profile?.streakDays ?? 0;

  const selectedLevel =
    activeCourse?.levels.find((l) => l.levelNumber === selectedLevelNum) ??
    activeCourse?.levels[0] ??
    null;

  return (
    <div className="min-h-screen flex flex-col bg-slate-50 dark:bg-[#0B0F17] text-slate-900 dark:text-slate-100">
      {/* Top Header */}
      <header className="sticky top-0 z-30 h-14 border-b border-slate-200 dark:border-slate-800 bg-white/95 dark:bg-[#0F172A]/95 backdrop-blur-sm px-4 lg:px-6 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={() => setMobileSidebarOpen((v) => !v)}
            aria-label="Toggle courses sidebar"
            className="lg:hidden p-1.5 rounded-lg text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
          >
            {mobileSidebarOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
          <span className="text-lg font-bold tracking-tight font-display text-slate-900 dark:text-slate-100 whitespace-nowrap shrink-0">
            Axiom
          </span>
        </div>

        {/* Center navigation */}
        <nav className="hidden md:flex items-center gap-6 text-sm font-medium text-slate-600 dark:text-slate-400">
          <button
            type="button"
            onClick={() => setActiveView('tree')}
            className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeView === 'tree'
                ? 'border-sky-600 dark:border-sky-400 text-slate-900 dark:text-slate-100'
                : 'border-transparent hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            Skill Tree
          </button>
          <button
            type="button"
            onClick={() => setActiveView('studio')}
            className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeView === 'studio'
                ? 'border-sky-600 dark:border-sky-400 text-slate-900 dark:text-slate-100'
                : 'border-transparent hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            Study Studio
          </button>
          <button
            type="button"
            onClick={() => setActiveView('history')}
            className={`py-1 border-b-2 transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
              activeView === 'history'
                ? 'border-sky-600 dark:border-sky-400 text-slate-900 dark:text-slate-100'
                : 'border-transparent hover:text-slate-900 dark:hover:text-slate-100'
            }`}
          >
            Session Log
          </button>
        </nav>

        {/* Right Header Actions: Profile / Export / Theme / Sign out */}
        <div className="flex items-center gap-2 shrink-0">
          <div
            className="hidden sm:flex items-center gap-3 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 text-xs"
            title={profile?.email ?? undefined}
          >
            <span className="inline-flex items-center gap-1 font-mono tabular-nums font-semibold text-slate-800 dark:text-slate-100">
              <TrendingUp className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" />
              {elo}
            </span>
            <span className="inline-flex items-center gap-1 font-mono tabular-nums font-semibold text-slate-800 dark:text-slate-100">
              <Flame className="w-3.5 h-3.5 text-amber-500" />
              {streakDays}d
            </span>
            <span className="hidden lg:inline max-w-40 truncate text-slate-500 dark:text-slate-400">
              {profile?.email}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setApiKeyOpen(true)}
            title="Gemini API key (bring your own key)"
            className="relative inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <KeyRound className="w-3.5 h-3.5" />
            <span className="hidden md:inline">API Key</span>
            <span
              aria-hidden="true"
              className={`absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full ring-2 ring-white dark:ring-[#0F172A] ${
                apiKeyStatus?.hasKey
                  ? 'bg-emerald-500'
                  : isAiAvailable(apiKeyStatus)
                    ? 'bg-sky-500'
                    : 'bg-amber-500'
              }`}
            />
          </button>
          <button
            type="button"
            onClick={handleExportJson}
            title="Download a JSON backup of your courses and progress"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden md:inline">Export JSON</span>
          </button>
          <button
            type="button"
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            aria-label="Toggle color theme"
            className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 transition-colors cursor-pointer"
          >
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </button>
          <button
            type="button"
            onClick={handleSignOut}
            aria-label="Sign out"
            title="Sign out"
            className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 transition-colors cursor-pointer"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </header>

      {/* Main Workspace Shell */}
      <div className="flex-1 flex relative">
        {/* Sidebar */}
        <aside
          className={`${
            mobileSidebarOpen ? 'fixed inset-y-14 left-0 z-30 block' : 'hidden'
          } lg:static lg:block w-64 xl:w-72 shrink-0 border-r border-slate-200 dark:border-slate-800 bg-white dark:bg-[#0F172A] p-4 flex flex-col justify-between gap-6`}
        >
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-slate-500 dark:text-slate-400">
                Engineering Courses
              </span>
              <button
                type="button"
                onClick={() => setNewCourseOpen(true)}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-sky-600 hover:bg-sky-700 text-white text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>New Course</span>
              </button>
            </div>

            {courses.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed py-2">
                No courses created yet. Add a course like Calculus II, Algorithms, or Physics to start building your skill tree.
              </p>
            ) : (
              <div className="space-y-1.5">
                {courses.map((course) => {
                  const isActive = activeCourse?.id === course.id;
                  const mastered = course.levels.filter((l) => l.mastered).length;
                  const readiness = computeCourseReadiness(course);

                  return (
                    <div
                      key={course.id}
                      className={`group rounded-lg border transition-colors ${
                        isActive
                          ? 'border-sky-600/50 dark:border-sky-400/50 bg-sky-50/60 dark:bg-sky-950/30'
                          : 'border-transparent hover:bg-slate-100/80 dark:hover:bg-slate-800/50'
                      }`}
                    >
                      <div className="flex items-start justify-between gap-2 p-2.5">
                        <button
                          type="button"
                          onClick={() => {
                            setActiveCourseId(course.id);
                            setMobileSidebarOpen(false);
                          }}
                          className="flex-1 text-left min-w-0 cursor-pointer"
                        >
                          <div className="text-xs font-mono text-slate-500 dark:text-slate-400 truncate">
                            {course.code}
                          </div>
                          <div className="text-sm font-semibold text-slate-900 dark:text-slate-100 truncate">
                            {course.name}
                          </div>
                          <div className="text-xs text-slate-500 dark:text-slate-400 tabular-nums mt-0.5">
                            {course.levels.length > 0
                              ? `${mastered}/10 mastered · ${readiness}% ready`
                              : `${course.pdfFiles.length} PDF(s) attached`}
                          </div>
                        </button>

                        {confirmDeleteCourseId === course.id ? (
                          <div className="flex flex-col gap-1 shrink-0">
                            <button
                              type="button"
                              disabled={deletingCourseId === course.id}
                              onClick={() => handleDeleteCourse(course.id)}
                              className="px-2 py-0.5 rounded bg-red-600 disabled:opacity-60 text-white text-[11px] font-medium cursor-pointer"
                            >
                              {deletingCourseId === course.id ? 'Deleting…' : 'Delete'}
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteCourseId(null)}
                              className="px-2 py-0.5 rounded border border-slate-300 dark:border-slate-700 text-[11px] text-slate-600 dark:text-slate-300 cursor-pointer"
                            >
                              Keep
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            title="Delete course"
                            onClick={() => setConfirmDeleteCourseId(course.id)}
                            className="p-1 rounded text-slate-400 opacity-0 group-hover:opacity-100 hover:text-red-600 dark:hover:text-red-400 transition-opacity cursor-pointer"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="border-t border-slate-200 dark:border-slate-800 pt-4 text-xs text-slate-500 dark:text-slate-400 space-y-1">
            <div className="font-medium text-slate-700 dark:text-slate-300">Progression Rule</div>
            <p className="leading-relaxed">
              Score <span className="font-mono font-semibold tabular-nums">≥ 80%</span> in Level Climb to unlock the next micro-level.
            </p>
          </div>
        </aside>

        {/* Main Viewport */}
        <main className="flex-1 min-w-0 p-4 sm:p-6 lg:p-8 max-w-6xl mx-auto w-full space-y-6">
          {/* Mobile sub-navigation */}
          <div className="flex md:hidden items-center gap-1 p-1 rounded-lg bg-slate-200/70 dark:bg-slate-800">
            {(['tree', 'studio', 'history'] as WorkspaceView[]).map((view) => (
              <button
                key={view}
                type="button"
                onClick={() => setActiveView(view)}
                className={`flex-1 py-1.5 text-xs font-medium rounded-md transition-colors cursor-pointer ${
                  activeView === view
                    ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                    : 'text-slate-600 dark:text-slate-400'
                }`}
              >
                {view === 'tree' ? 'Skill Tree' : view === 'studio' ? 'Study Studio' : 'Session Log'}
              </button>
            ))}
          </div>

          {/* BYOK prompt when no Gemini key is available */}
          {apiKeyStatus && !isAiAvailable(apiKeyStatus) && (
            <div className="rounded-lg border border-amber-200 dark:border-amber-900 bg-amber-50 dark:bg-amber-950/40 px-4 py-3 text-sm text-amber-900 dark:text-amber-100 flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2.5 min-w-0">
                <KeyRound className="w-4 h-4 shrink-0" />
                <span>Add your Gemini API key to generate roadmaps, lessons and graded questions.</span>
              </div>
              <button
                type="button"
                onClick={() => setApiKeyOpen(true)}
                className="px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-medium whitespace-nowrap cursor-pointer"
              >
                Add API key
              </button>
            </div>
          )}

          {/* Toast feedback banner */}
          {bannerMessage && (
            <div
              role="status"
              className={`rounded-lg border px-4 py-3 text-sm flex items-center justify-between gap-3 ${
                bannerMessage.type === 'success'
                  ? 'border-emerald-200 dark:border-emerald-900 bg-emerald-50 dark:bg-emerald-950/50 text-emerald-800 dark:text-emerald-200'
                  : 'border-red-200 dark:border-red-900 bg-red-50 dark:bg-red-950/50 text-red-800 dark:text-red-200'
              }`}
            >
              <div className="flex items-center gap-2.5 min-w-0">
                {bannerMessage.type === 'success' ? (
                  <CheckCircle2 className="w-4 h-4 shrink-0" />
                ) : (
                  <AlertCircle className="w-4 h-4 shrink-0" />
                )}
                <span>{bannerMessage.text}</span>
              </div>
              <button
                type="button"
                aria-label="Dismiss notification"
                onClick={() => setBannerMessage(null)}
                className="p-1 rounded hover:bg-black/5 dark:hover:bg-white/10 shrink-0 cursor-pointer"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* Empty State if no courses exist */}
          {!activeCourse ? (
            <div className="space-y-6">
              <TelemetryStrip elo={elo} streakDays={streakDays} activeCourse={null} />

              <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 md:p-10 space-y-6">
                <div className="max-w-2xl space-y-2.5">
                  <div className="text-xs font-medium text-sky-700 dark:text-sky-400">
                    Active Recall &amp; Exam Reflex System
                  </div>
                  <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-slate-900 dark:text-slate-100 text-balance">
                    Turn dense lecture PDFs into a strict 10-level mastery climb
                  </h1>
                  <p className="text-sm sm:text-base text-slate-600 dark:text-slate-400 leading-relaxed">
                    Stop passively re-reading slides before midterms. Create a course, upload your lecture notes and past exams, and train with step-by-step AI grading, 45-second First 2 Lines reflex drills, and Feynman teach-back dialogues.
                  </p>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2 border-t border-slate-100 dark:border-slate-800">
                  <div className="space-y-1">
                    <div className="text-xs font-mono text-slate-400">01</div>
                    <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      Multi-PDF Skill Tree
                    </div>
                    <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                      Gemini structures slides, notes, and past exams into 10 sequential micro-levels.
                    </p>
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs font-mono text-slate-400">02</div>
                    <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      First 2 Lines Anti-Freeze
                    </div>
                    <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                      45-second drills train you to spot the governing theorem and setup equation immediately.
                    </p>
                  </div>
                  <div className="space-y-1">
                    <div className="text-xs font-mono text-slate-400">03</div>
                    <div className="text-sm font-semibold text-slate-900 dark:text-slate-100">
                      Feynman Teach-Back
                    </div>
                    <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
                      Explain concepts to a skeptical classmate who probes logical gaps and scores clarity.
                    </p>
                  </div>
                </div>

                <div>
                  <button
                    type="button"
                    onClick={() => setNewCourseOpen(true)}
                    className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-sm font-medium transition-colors cursor-pointer"
                  >
                    <Plus className="w-4 h-4" />
                    <span>Create Your First Course</span>
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-6">
              {/* Course Header */}
              <div className="flex flex-wrap items-end justify-between gap-4">
                <div className="space-y-1">
                  <div className="text-xs text-slate-500 dark:text-slate-400 font-mono">
                    {activeCourse.code} · {activeCourse.pdfFiles.length} PDF
                    {activeCourse.pdfFiles.length === 1 ? '' : 's'} · Language:{' '}
                    {activeCourse.detectedLanguage}
                  </div>
                  <h1 className="text-2xl font-bold tracking-tight text-slate-900 dark:text-slate-100">
                    {activeCourse.name}
                  </h1>
                </div>

                {activeCourse.levels.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setShowMaterials((v) => !v)}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <BookOpen className="w-3.5 h-3.5" />
                    <span>{showMaterials ? 'Hide PDFs' : 'Manage Course PDFs'}</span>
                    {showMaterials ? (
                      <ChevronUp className="w-3.5 h-3.5" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5" />
                    )}
                  </button>
                )}
              </div>

              {/* Telemetry Strip */}
              <TelemetryStrip
                elo={elo}
                streakDays={streakDays}
                activeCourse={activeCourse}
              />

              {/* Course PDF Ingestion Panel */}
              {showMaterials && (
                <CourseMaterialPanel
                  course={activeCourse}
                  onUpdateCourse={handleUpdateCourse}
                  onNotifyError={(msg) => showToast('error', msg)}
                />
              )}

              {/* View 1: Skill Tree */}
              {activeView === 'tree' && (
                <>
                  {activeCourse.levels.length === 0 ? (
                    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center space-y-2">
                      <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                        Your 10-Level Skill Tree will appear here
                      </p>
                      <p className="text-xs text-slate-500 dark:text-slate-400 max-w-md mx-auto">
                        Attach one or more PDF files above (lecture slides, notes, or past exams) and click “Generate 10-Level Mastery Roadmap”.
                      </p>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                          10-Level Mastery Skill Tree
                        </h2>
                        {selectedLevel && (
                          <button
                            type="button"
                            onClick={() => setActiveView('studio')}
                            className="inline-flex items-center gap-1.5 text-xs font-medium text-sky-700 dark:text-sky-400 hover:underline cursor-pointer"
                          >
                            <span>Open Level {selectedLevel.levelNumber} Studio</span>
                            <ArrowUpRight className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                      <SkillTree
                        levels={activeCourse.levels}
                        selectedLevelNumber={selectedLevelNum}
                        onSelectLevel={(num) => {
                          setSelectedLevelNum(num);
                          setLevelStep('learn');
                          setActiveView('studio');
                        }}
                      />
                    </div>
                  )}
                </>
              )}

              {/* View 2: Study Studio */}
              {activeView === 'studio' && (
                <>
                  {!selectedLevel ? (
                    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-8 text-center space-y-3">
                      <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
                        Generate a roadmap first to launch the Study Studio
                      </p>
                      <button
                        type="button"
                        onClick={() => setActiveView('tree')}
                        className="px-4 py-2 rounded-lg bg-sky-600 text-white text-xs font-medium cursor-pointer"
                      >
                        Go to Syllabus Ingestion
                      </button>
                    </div>
                  ) : (
                    <div className="space-y-5">
                      {/* Level Switcher + Context Summary */}
                      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
                        <div className="flex flex-wrap items-center justify-between gap-3">
                          <div className="space-y-1">
                            <div className="text-xs font-mono text-slate-500 dark:text-slate-400 tabular-nums">
                              Level {String(selectedLevel.levelNumber).padStart(2, '0')} ·{' '}
                              {selectedLevel.tier.toUpperCase()} · Best:{' '}
                              {selectedLevel.bestScore !== null ? `${selectedLevel.bestScore}%` : '—'}
                            </div>
                            <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
                              {selectedLevel.title}
                            </h2>
                          </div>

                          <div className="flex items-center gap-2">
                            <label
                              htmlFor="level-select"
                              className="text-xs text-slate-500 dark:text-slate-400"
                            >
                              Active Level:
                            </label>
                            <select
                              id="level-select"
                              value={selectedLevel.levelNumber}
                              onChange={(e) => {
                                setSelectedLevelNum(Number(e.target.value));
                                setLevelStep('learn');
                              }}
                              className="rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-1.5 text-xs font-medium text-slate-800 dark:text-slate-200"
                            >
                              {activeCourse.levels.map((lvl) => (
                                <option
                                  key={lvl.levelNumber}
                                  value={lvl.levelNumber}
                                  disabled={!lvl.unlocked}
                                >
                                  L{lvl.levelNumber}: {lvl.title}{' '}
                                  {lvl.unlocked ? '' : '(Locked)'}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>

                        <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
                          {selectedLevel.summary}
                        </p>

                        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 pt-3 border-t border-slate-100 dark:border-slate-800">
                          <div className="space-y-1.5">
                            <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                              Mastery Objectives
                            </div>
                            <ul className="list-disc pl-4 space-y-1 text-xs text-slate-600 dark:text-slate-400">
                              {selectedLevel.objectives.map((obj, idx) => (
                                <li key={idx}>
                                  <MathText text={obj} />
                                </li>
                              ))}
                            </ul>
                          </div>

                          <div className="space-y-1.5">
                            <div className="text-xs font-semibold text-slate-700 dark:text-slate-300">
                              Key Formulas &amp; Theorems
                            </div>
                            <div className="space-y-1.5 text-xs text-slate-800 dark:text-slate-200">
                              {selectedLevel.keyFormulas.map((formula, idx) => (
                                <div
                                  key={idx}
                                  className="px-3 py-1.5 rounded-md bg-slate-50 dark:bg-slate-950 border border-slate-200/80 dark:border-slate-800"
                                >
                                  <MathText text={formula} />
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      </div>

                      {/* 2-Step Learning Loop Stepper */}
                      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => setLevelStep('learn')}
                            className={`px-4 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                              levelStep === 'learn'
                                ? 'bg-sky-600 text-white'
                                : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100'
                            }`}
                          >
                            Step 1 · Learn (Mini-Lesson &amp; Example)
                          </button>
                          <button
                            type="button"
                            onClick={() => setLevelStep('test')}
                            className={`px-4 py-2 rounded-lg text-xs font-semibold transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                              levelStep === 'test'
                                ? 'bg-emerald-600 text-white'
                                : 'text-slate-600 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 hover:text-slate-900 dark:hover:text-slate-100'
                            }`}
                          >
                            Step 2 · Challenge (Quiz &amp; Reflex Modes)
                          </button>
                        </div>

                        {levelStep === 'test' && (
                          <button
                            type="button"
                            onClick={() => setLevelStep('learn')}
                            className="px-3 py-1.5 text-xs font-medium text-sky-700 dark:text-sky-400 hover:underline whitespace-nowrap shrink-0 cursor-pointer"
                          >
                            Review Step 1 Lesson
                          </button>
                        )}
                      </div>

                      {levelStep === 'learn' ? (
                        <LevelLessonPanel
                          key={`lesson-${activeCourse.id}-${selectedLevel.levelNumber}`}
                          course={activeCourse}
                          level={selectedLevel}
                          onReadyToTest={() => setLevelStep('test')}
                          onNotifyError={(msg) => showToast('error', msg)}
                        />
                      ) : (
                        <div className="space-y-4">
                          {/* Mode Selector Segmented Tabs */}
                          <div className="flex flex-wrap items-center gap-1 p-1 rounded-xl bg-slate-200/70 dark:bg-slate-800/80 w-fit">
                            <button
                              type="button"
                              onClick={() => setStudyMode('climb')}
                              className={`px-4 py-2 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                                studyMode === 'climb'
                                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                              }`}
                            >
                              Mode A · Level Climb (5Q)
                            </button>
                            <button
                              type="button"
                              onClick={() => setStudyMode('reflex')}
                              className={`px-4 py-2 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                                studyMode === 'reflex'
                                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                              }`}
                            >
                              Mode B · First 2 Lines (45s)
                            </button>
                            <button
                              type="button"
                              onClick={() => setStudyMode('feynman')}
                              className={`px-4 py-2 rounded-lg text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                                studyMode === 'feynman'
                                  ? 'bg-white dark:bg-slate-900 text-slate-900 dark:text-slate-100 shadow-xs'
                                  : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100'
                              }`}
                            >
                              Mode C · Feynman Teach-Back
                            </button>
                          </div>

                          {/* Active Study Mode Panel */}
                          {studyMode === 'climb' && (
                            <LevelClimbMode
                              key={`climb-${activeCourse.id}-${selectedLevel.levelNumber}`}
                              course={activeCourse}
                              level={selectedLevel}
                              userElo={elo}
                              onApplySingleElo={handleApplySingleElo}
                              onCompleteClimb={handleCompleteClimb}
                              onNotifyError={(msg) => showToast('error', msg)}
                            />
                          )}

                          {studyMode === 'reflex' && (
                            <FirstTwoLinesMode
                              key={`reflex-${activeCourse.id}-${selectedLevel.levelNumber}`}
                              course={activeCourse}
                              level={selectedLevel}
                              userElo={elo}
                              onCompleteReflex={handleCompleteReflex}
                              onNotifyError={(msg) => showToast('error', msg)}
                            />
                          )}

                          {studyMode === 'feynman' && (
                            <FeynmanMode
                              key={`feynman-${activeCourse.id}-${selectedLevel.levelNumber}`}
                              course={activeCourse}
                              level={selectedLevel}
                              userElo={elo}
                              onCompleteFeynman={handleCompleteFeynman}
                              onNotifyError={(msg) => showToast('error', msg)}
                            />
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}

              {/* View 3: Session History Log */}
              {activeView === 'history' && (
                <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
                  <div className="px-5 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between">
                    <div>
                      <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                        Study Session History
                      </h2>
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        Recent Level Climb, First 2 Lines, and Feynman teach-back evaluations
                      </p>
                    </div>
                    <span className="text-xs font-mono tabular-nums text-slate-500 dark:text-slate-400">
                      {sessions.length} entries
                    </span>
                  </div>

                  {sessions.length === 0 ? (
                    <div className="p-8 text-center text-sm text-slate-500 dark:text-slate-400">
                      No sessions recorded yet. Complete a drill in the Study Studio to log your progress.
                    </div>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left border-collapse text-xs">
                        <thead>
                          <tr className="border-b border-slate-200 dark:border-slate-800 text-slate-500 dark:text-slate-400 bg-slate-50/70 dark:bg-slate-950/60">
                            <th className="py-2.5 px-4 font-medium">Course</th>
                            <th className="py-2.5 px-4 font-medium">Level</th>
                            <th className="py-2.5 px-4 font-medium">Mode</th>
                            <th className="py-2.5 px-4 font-medium">Summary</th>
                            <th className="py-2.5 px-4 font-medium text-right">Score</th>
                            <th className="py-2.5 px-4 font-medium text-right">Elo</th>
                            <th className="py-2.5 px-4 font-medium text-right">When</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100 dark:divide-slate-800">
                          {sessions.map((s) => (
                            <tr
                              key={s.id}
                              className="hover:bg-slate-50/80 dark:hover:bg-slate-800/40 transition-colors"
                            >
                              <td className="py-2.5 px-4 font-medium text-slate-900 dark:text-slate-100 whitespace-nowrap">
                                {s.courseName}
                              </td>
                              <td className="py-2.5 px-4 text-slate-600 dark:text-slate-300 whitespace-nowrap">
                                L{s.levelNumber} · {s.levelTitle}
                              </td>
                              <td className="py-2.5 px-4 text-slate-600 dark:text-slate-300 whitespace-nowrap">
                                {s.mode === 'climb'
                                  ? 'Level Climb'
                                  : s.mode === 'reflex'
                                    ? 'First 2 Lines'
                                    : 'Feynman'}
                              </td>
                              <td className="py-2.5 px-4 text-slate-600 dark:text-slate-400">
                                {s.summary}
                              </td>
                              <td className="py-2.5 px-4 text-right font-mono tabular-nums font-medium text-slate-900 dark:text-slate-100">
                                {s.score}%
                              </td>
                              <td
                                className={`py-2.5 px-4 text-right font-mono tabular-nums font-medium ${
                                  s.eloDelta >= 0
                                    ? 'text-emerald-600 dark:text-emerald-400'
                                    : 'text-amber-600 dark:text-amber-400'
                                }`}
                              >
                                {s.eloDelta >= 0 ? `+${s.eloDelta}` : s.eloDelta}
                              </td>
                              <td className="py-2.5 px-4 text-right font-mono tabular-nums text-slate-500 dark:text-slate-400 whitespace-nowrap">
                                {new Date(s.timestamp).toLocaleDateString()}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </main>
      </div>

      <ApiKeySettings
        open={apiKeyOpen}
        status={apiKeyStatus}
        onClose={() => setApiKeyOpen(false)}
        onChanged={handleApiKeyChanged}
      />

      <NewCourseModal
        open={newCourseOpen}
        onClose={() => setNewCourseOpen(false)}
        onCreate={handleCreateCourse}
      />
    </div>
  );
}
