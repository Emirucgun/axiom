/**
 * Device-local preferences and pure helpers. All study data lives in Supabase
 * (see src/services); only the light/dark theme choice is kept per browser.
 */
import type { Course } from '../types';

const THEME_KEY = 'axiom_theme_v1';

export function getTodayIsoDate(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
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
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage can be unavailable (private mode); theme just won't persist.
  }
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
