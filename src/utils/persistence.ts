import type { AppState, Course } from '../types';

const STORAGE_KEY = 'axiom_mastery_state_v1';
const THEME_KEY = 'axiom_theme_v1';

export function getTodayIsoDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getYesterdayIsoDate(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function createInitialState(): AppState {
  return {
    version: 1,
    elo: 1200,
    streakDays: 0,
    lastStudyDate: null,
    studyDates: [],
    courses: [],
    activeCourseId: null,
    sessions: [],
  };
}

export function loadAppState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createInitialState();
    const parsed = JSON.parse(raw) as Partial<AppState>;
    return {
      version: 1,
      elo: typeof parsed.elo === 'number' ? parsed.elo : 1200,
      streakDays: typeof parsed.streakDays === 'number' ? parsed.streakDays : 0,
      lastStudyDate: parsed.lastStudyDate ?? null,
      studyDates: Array.isArray(parsed.studyDates) ? parsed.studyDates : [],
      courses: Array.isArray(parsed.courses) ? parsed.courses : [],
      activeCourseId: parsed.activeCourseId ?? null,
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    };
  } catch {
    return createInitialState();
  }
}

export function saveAppState(state: AppState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function loadThemePreference(): 'light' | 'dark' {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    if (saved === 'dark' || saved === 'light') return saved;
    if (typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches) {
      return 'dark';
    }
    return 'light';
  } catch {
    return 'light';
  }
}

export function saveThemePreference(theme: 'light' | 'dark'): void {
  localStorage.setItem(THEME_KEY, theme);
}

export function recordDailyActivity(state: AppState): Pick<AppState, 'streakDays' | 'lastStudyDate' | 'studyDates'> {
  const today = getTodayIsoDate();
  const yesterday = getYesterdayIsoDate();
  const datesSet = new Set(state.studyDates);
  datesSet.add(today);

  let nextStreak = state.streakDays;
  if (state.lastStudyDate === today) {
    nextStreak = Math.max(1, state.streakDays);
  } else if (state.lastStudyDate === yesterday) {
    nextStreak = state.streakDays + 1;
  } else {
    nextStreak = 1;
  }

  return {
    streakDays: nextStreak,
    lastStudyDate: today,
    studyDates: Array.from(datesSet).slice(-90),
  };
}

export function computeCourseReadiness(course: Course | null): number {
  if (!course || course.levels.length === 0) return 0;
  let weightedEarned = 0;
  let weightedTotal = 0;

  for (const lvl of course.levels) {
    // Higher weight for exam & distinction levels
    const weight = lvl.levelNumber >= 9 ? 1.5 : lvl.levelNumber >= 6 ? 1.3 : 1.0;
    weightedTotal += 100 * weight;

    const climbPart = lvl.bestScore !== null ? lvl.bestScore * 0.65 : 0;
    const reflexPart = Math.min(20, lvl.reflexPassed * 10);
    const feynmanPart = lvl.feynmanBestClarity !== null ? (lvl.feynmanBestClarity / 100) * 15 : 0;
    const levelReadiness = Math.min(100, climbPart + reflexPart + feynmanPart);

    weightedEarned += levelReadiness * weight;
  }

  return weightedTotal > 0 ? Math.round((weightedEarned / weightedTotal) * 100) : 0;
}

export function validateImportedState(data: unknown): AppState | null {
  if (!data || typeof data !== 'object') return null;
  const obj = data as Record<string, unknown>;
  if (!Array.isArray(obj.courses)) return null;

  return {
    version: 1,
    elo: typeof obj.elo === 'number' ? obj.elo : 1200,
    streakDays: typeof obj.streakDays === 'number' ? obj.streakDays : 0,
    lastStudyDate: typeof obj.lastStudyDate === 'string' ? obj.lastStudyDate : null,
    studyDates: Array.isArray(obj.studyDates)
      ? obj.studyDates.filter((d): d is string => typeof d === 'string')
      : [],
    courses: obj.courses as Course[],
    activeCourseId: typeof obj.activeCourseId === 'string' ? obj.activeCourseId : null,
    sessions: Array.isArray(obj.sessions) ? obj.sessions : [],
  };
}
