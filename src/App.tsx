import React, { useState, useEffect, useRef } from 'react';
import {
  Plus,
  Download,
  Upload,
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
} from 'lucide-react';
import type {
  AppState,
  Course,
  ReflexEvaluation,
  SessionRecord,
  StudyMode,
} from './types';
import {
  loadAppState,
  saveAppState,
  loadThemePreference,
  saveThemePreference,
  recordDailyActivity,
  validateImportedState,
  computeCourseReadiness,
} from './utils/persistence';
import { deleteCoursePdfsFromDb } from './utils/pdfStorage';
import { clearCourseLevelCache } from './utils/levelCache';
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

export default function App() {
  const [state, setState] = useState<AppState>(() => loadAppState());
  const [theme, setTheme] = useState<'light' | 'dark'>(() => loadThemePreference());
  const [activeView, setActiveView] = useState<WorkspaceView>('tree');
  const [selectedLevelNum, setSelectedLevelNum] = useState<number>(1);
  const [levelStep, setLevelStep] = useState<'learn' | 'test'>('learn');
  const [studyMode, setStudyMode] = useState<StudyMode>('climb');
  const [showMaterials, setShowMaterials] = useState<boolean>(true);
  const [newCourseOpen, setNewCourseOpen] = useState(false);
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  const [confirmDeleteCourseId, setConfirmDeleteCourseId] = useState<string | null>(null);
  const [bannerMessage, setBannerMessage] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  const importInputRef = useRef<HTMLInputElement | null>(null);

  // Warm up backend server on mount/focus after idle scale-to-zero
  useEffect(() => {
    fetch('/api/health').catch(() => {});
  }, []);

  // Sync theme class on <html>
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    saveThemePreference(theme);
  }, [theme]);

  // Persist AppState to localStorage
  useEffect(() => {
    saveAppState(state);
  }, [state]);

  const activeCourse =
    state.courses.find((c) => c.id === state.activeCourseId) ?? state.courses[0] ?? null;

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

  const handleCreateCourse = (course: Course) => {
    setState((prev) => ({
      ...prev,
      courses: [...prev.courses, course],
      activeCourseId: course.id,
    }));
    setActiveView('tree');
    setShowMaterials(true);
    setMobileSidebarOpen(false);
  };

  const handleUpdateCourse = (updated: Course) => {
    setState((prev) => ({
      ...prev,
      courses: prev.courses.map((c) => (c.id === updated.id ? updated : c)),
    }));
    if (updated.levels.length > 0 && showMaterials && prevHadNoLevels(updated.id)) {
      setShowMaterials(false);
    }
  };

  const prevHadNoLevels = (courseId: string) => {
    const existing = state.courses.find((c) => c.id === courseId);
    return existing ? existing.levels.length === 0 : false;
  };

  const handleDeleteCourse = async (courseId: string) => {
    await deleteCoursePdfsFromDb(courseId);
    clearCourseLevelCache(courseId);
    setState((prev) => {
      const remaining = prev.courses.filter((c) => c.id !== courseId);
      const nextActive =
        prev.activeCourseId === courseId ? (remaining[0]?.id ?? null) : prev.activeCourseId;
      return {
        ...prev,
        courses: remaining,
        activeCourseId: nextActive,
      };
    });
    setConfirmDeleteCourseId(null);
  };

  const handleApplySingleElo = (delta: number) => {
    setState((prev) => ({
      ...prev,
      elo: Math.max(600, prev.elo + delta),
    }));
  };

  const handleCompleteClimb = (
    levelNumber: number,
    averageScore: number,
    totalEloDelta: number,
    summaryText: string,
  ) => {
    if (!activeCourse) return;
    const passed = averageScore >= 80;

    setState((prev) => {
      const streakUpdate = recordDailyActivity(prev);
      const updatedCourses = prev.courses.map((c) => {
        if (c.id !== activeCourse.id) return c;
        const nextLevels = c.levels.map((lvl) => {
          if (lvl.levelNumber === levelNumber) {
            const best =
              lvl.bestScore === null ? averageScore : Math.max(lvl.bestScore, averageScore);
            return {
              ...lvl,
              bestScore: best,
              mastered: lvl.mastered || passed,
              attempts: lvl.attempts + 1,
            };
          }
          if (passed && lvl.levelNumber === levelNumber + 1) {
            return { ...lvl, unlocked: true };
          }
          return lvl;
        });
        return { ...c, levels: nextLevels };
      });

      const targetLvl = activeCourse.levels.find((l) => l.levelNumber === levelNumber);
      const session: SessionRecord = {
        id: `sess_${Date.now()}`,
        courseId: activeCourse.id,
        courseName: activeCourse.name,
        levelNumber,
        levelTitle: targetLvl?.title ?? `Level ${levelNumber}`,
        mode: 'climb',
        score: averageScore,
        eloDelta: totalEloDelta,
        timestamp: new Date().toISOString(),
        summary: summaryText,
      };

      return {
        ...prev,
        ...streakUpdate,
        courses: updatedCourses,
        sessions: [session, ...prev.sessions].slice(0, 100),
      };
    });

    if (passed) {
      showToast(
        'success',
        levelNumber < 10
          ? `Level ${levelNumber} mastered (${averageScore}%). Level ${levelNumber + 1} unlocked!`
          : `Level 10 mastered (${averageScore}%)! Distinction tier complete.`,
      );
    }
  };

  const handleCompleteReflex = (
    levelNumber: number,
    evaluation: ReflexEvaluation,
    elapsedSeconds: number,
  ) => {
    if (!activeCourse) return;

    setState((prev) => {
      const streakUpdate = recordDailyActivity(prev);
      const updatedCourses = prev.courses.map((c) => {
        if (c.id !== activeCourse.id) return c;
        return {
          ...c,
          levels: c.levels.map((lvl) =>
            lvl.levelNumber === levelNumber && evaluation.verdict === 'valid'
              ? { ...lvl, reflexPassed: lvl.reflexPassed + 1 }
              : lvl,
          ),
        };
      });

      const targetLvl = activeCourse.levels.find((l) => l.levelNumber === levelNumber);
      const session: SessionRecord = {
        id: `sess_${Date.now()}`,
        courseId: activeCourse.id,
        courseName: activeCourse.name,
        levelNumber,
        levelTitle: targetLvl?.title ?? `Level ${levelNumber}`,
        mode: 'reflex',
        score: evaluation.score,
        eloDelta: evaluation.eloDelta,
        timestamp: new Date().toISOString(),
        summary: `First 2 Lines in ${elapsedSeconds}s (${evaluation.verdict})`,
      };

      return {
        ...prev,
        ...streakUpdate,
        elo: Math.max(600, prev.elo + evaluation.eloDelta),
        courses: updatedCourses,
        sessions: [session, ...prev.sessions].slice(0, 100),
      };
    });
  };

  const handleCompleteFeynman = (
    levelNumber: number,
    clarityScore: number,
    eloDelta: number,
  ) => {
    if (!activeCourse) return;

    setState((prev) => {
      const streakUpdate = recordDailyActivity(prev);
      const updatedCourses = prev.courses.map((c) => {
        if (c.id !== activeCourse.id) return c;
        return {
          ...c,
          levels: c.levels.map((lvl) => {
            if (lvl.levelNumber !== levelNumber) return lvl;
            const best =
              lvl.feynmanBestClarity === null
                ? clarityScore
                : Math.max(lvl.feynmanBestClarity, clarityScore);
            return { ...lvl, feynmanBestClarity: best };
          }),
        };
      });

      const targetLvl = activeCourse.levels.find((l) => l.levelNumber === levelNumber);
      const session: SessionRecord = {
        id: `sess_${Date.now()}`,
        courseId: activeCourse.id,
        courseName: activeCourse.name,
        levelNumber,
        levelTitle: targetLvl?.title ?? `Level ${levelNumber}`,
        mode: 'feynman',
        score: clarityScore,
        eloDelta,
        timestamp: new Date().toISOString(),
        summary: `Feynman Clarity Score: ${clarityScore}%`,
      };

      return {
        ...prev,
        ...streakUpdate,
        elo: Math.max(600, prev.elo + eloDelta),
        courses: updatedCourses,
        sessions: [session, ...prev.sessions].slice(0, 100),
      };
    });
  };

  const handleExportJson = () => {
    const payload = JSON.stringify(state, null, 2);
    const blob = new Blob([payload], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `axiom-mastery-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    showToast('success', 'Progress backup exported as JSON.');
  };

  const handleImportJson = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        const validated = validateImportedState(parsed);
        if (!validated) {
          throw new Error('Invalid Axiom progress JSON structure.');
        }
        setState(validated);
        showToast(
          'success',
          `Imported ${validated.courses.length} course(s) and ${validated.sessions.length} session records.`,
        );
      } catch (err) {
        showToast(
          'error',
          err instanceof Error ? err.message : 'Failed to parse imported JSON.',
        );
      } finally {
        if (importInputRef.current) {
          importInputRef.current.value = '';
        }
      }
    };
    reader.readAsText(file);
  };

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

        {/* Right Header Actions: Export / Import / Theme */}
        <div className="flex items-center gap-2 shrink-0">
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={handleImportJson}
          />
          <button
            type="button"
            onClick={handleExportJson}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Export Progress (JSON)</span>
            <span className="sm:hidden">Export</span>
          </button>
          <button
            type="button"
            onClick={() => importInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-xs font-medium text-slate-700 dark:text-slate-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">Import Progress (JSON)</span>
            <span className="sm:hidden">Import</span>
          </button>
          <button
            type="button"
            onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
            aria-label="Toggle color theme"
            className="p-2 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-slate-50 dark:hover:bg-slate-800 text-slate-700 dark:text-slate-200 transition-colors cursor-pointer"
          >
            {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
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

            {state.courses.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400 leading-relaxed py-2">
                No courses created yet. Add a course like Calculus II, Algorithms, or Physics to start building your skill tree.
              </p>
            ) : (
              <div className="space-y-1.5">
                {state.courses.map((course) => {
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
                            setState((prev) => ({ ...prev, activeCourseId: course.id }));
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
                              onClick={() => handleDeleteCourse(course.id)}
                              className="px-2 py-0.5 rounded bg-red-600 text-white text-[11px] font-medium cursor-pointer"
                            >
                              Delete
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
              <TelemetryStrip elo={state.elo} streakDays={state.streakDays} activeCourse={null} />

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
                elo={state.elo}
                streakDays={state.streakDays}
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
                              userElo={state.elo}
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
                              userElo={state.elo}
                              onCompleteReflex={handleCompleteReflex}
                              onNotifyError={(msg) => showToast('error', msg)}
                            />
                          )}

                          {studyMode === 'feynman' && (
                            <FeynmanMode
                              key={`feynman-${activeCourse.id}-${selectedLevel.levelNumber}`}
                              course={activeCourse}
                              level={selectedLevel}
                              userElo={state.elo}
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
                      {state.sessions.length} entries
                    </span>
                  </div>

                  {state.sessions.length === 0 ? (
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
                          {state.sessions.map((s) => (
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

      <NewCourseModal
        open={newCourseOpen}
        onClose={() => setNewCourseOpen(false)}
        onCreate={handleCreateCourse}
      />
    </div>
  );
}
