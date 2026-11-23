import type { ClimbQuestion, LessonDoubtMessage, LevelLesson } from '../types';

const CACHE_KEY = 'axiom_level_content_cache_v1';

interface CachedLevelEntry {
  lesson?: LevelLesson;
  doubtHistory?: LessonDoubtMessage[];
  climbQuestions?: ClimbQuestion[];
  updatedAt: string;
}

type LevelCacheMap = Record<string, CachedLevelEntry>;

function makeKey(courseId: string, levelNumber: number): string {
  return `${courseId}::L${levelNumber}`;
}

function readCacheMap(): LevelCacheMap {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as LevelCacheMap) : {};
  } catch {
    return {};
  }
}

function writeCacheMap(map: LevelCacheMap): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(map));
  } catch {
    // If localStorage approaches quota, prune oldest entries and retry once
    const entries = Object.entries(map).sort(
      (a, b) =>
        new Date(b[1].updatedAt || 0).getTime() - new Date(a[1].updatedAt || 0).getTime(),
    );
    const trimmed = Object.fromEntries(entries.slice(0, 15));
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(trimmed));
    } catch {
      // Ignore storage write error gracefully
    }
  }
}

export function getCachedLevelLesson(
  courseId: string,
  levelNumber: number,
): LevelLesson | null {
  const map = readCacheMap();
  return map[makeKey(courseId, levelNumber)]?.lesson ?? null;
}

export function saveCachedLevelLesson(
  courseId: string,
  levelNumber: number,
  lesson: LevelLesson,
): void {
  const map = readCacheMap();
  const key = makeKey(courseId, levelNumber);
  map[key] = {
    ...(map[key] || {}),
    lesson,
    updatedAt: new Date().toISOString(),
  };
  writeCacheMap(map);
}

export function getCachedLessonDoubts(
  courseId: string,
  levelNumber: number,
): LessonDoubtMessage[] {
  const map = readCacheMap();
  return map[makeKey(courseId, levelNumber)]?.doubtHistory ?? [];
}

export function saveCachedLessonDoubts(
  courseId: string,
  levelNumber: number,
  doubtHistory: LessonDoubtMessage[],
): void {
  const map = readCacheMap();
  const key = makeKey(courseId, levelNumber);
  map[key] = {
    ...(map[key] || {}),
    doubtHistory: doubtHistory.slice(-20),
    updatedAt: new Date().toISOString(),
  };
  writeCacheMap(map);
}

export function getCachedClimbQuestions(
  courseId: string,
  levelNumber: number,
): ClimbQuestion[] | null {
  const map = readCacheMap();
  const qs = map[makeKey(courseId, levelNumber)]?.climbQuestions;
  return Array.isArray(qs) && qs.length > 0 ? qs : null;
}

export function saveCachedClimbQuestions(
  courseId: string,
  levelNumber: number,
  climbQuestions: ClimbQuestion[],
): void {
  const map = readCacheMap();
  const key = makeKey(courseId, levelNumber);
  map[key] = {
    ...(map[key] || {}),
    climbQuestions,
    updatedAt: new Date().toISOString(),
  };
  writeCacheMap(map);
}

export function clearCachedClimbQuestions(courseId: string, levelNumber: number): void {
  const map = readCacheMap();
  const key = makeKey(courseId, levelNumber);
  if (map[key]) {
    delete map[key].climbQuestions;
    map[key].updatedAt = new Date().toISOString();
    writeCacheMap(map);
  }
}

export function clearCourseLevelCache(courseId: string): void {
  const map = readCacheMap();
  const prefix = `${courseId}::`;
  let changed = false;
  for (const key of Object.keys(map)) {
    if (key.startsWith(prefix)) {
      delete map[key];
      changed = true;
    }
  }
  if (changed) {
    writeCacheMap(map);
  }
}
