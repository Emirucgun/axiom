/**
 * Study data layer: profile (Elo / streak), progression via the
 * `record_study_attempt` RPC, session history, and the JSON backup export.
 */
import type { Course, SessionRecord, StudyMode, UserProfile } from '../types';
import type { Database, StudyAttemptMode } from '../lib/database.types';
import { requireUserId, supabase } from '../lib/supabase';
import { getTodayIsoDate } from '../utils/persistence';

type ProfileRow = Database['public']['Tables']['profiles']['Row'];

export const PASS_THRESHOLD = 80;

const MODE_TO_DB: Record<StudyMode, StudyAttemptMode> = {
  climb: 'level_climb',
  reflex: 'first_2_lines',
  feynman: 'feynman',
};
const MODE_FROM_DB: Record<StudyAttemptMode, StudyMode> = {
  level_climb: 'climb',
  first_2_lines: 'reflex',
  feynman: 'feynman',
};

function rowToProfile(row: ProfileRow): UserProfile {
  return {
    id: row.id,
    email: row.email,
    elo: row.mastery_elo,
    streakDays: row.daily_streak,
    lastStudyDate: row.last_study_date,
  };
}

export async function getProfile(): Promise<UserProfile> {
  const userId = await requireUserId();
  const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle();
  if (error) throw new Error(`Failed to load profile: ${error.message}`);
  if (data) return rowToProfile(data);

  // Self-heal accounts created before the on_auth_user_created trigger existed.
  const { data: session } = await supabase.auth.getSession();
  const { data: created, error: insertError } = await supabase
    .from('profiles')
    .insert({ id: userId, email: session.session?.user.email ?? null })
    .select('*')
    .single();
  if (insertError) throw new Error(`Failed to create profile: ${insertError.message}`);
  return rowToProfile(created);
}

/** Applies one graded question's Elo change immediately (Level Climb). Returns the new Elo. */
export async function applyEloDelta(delta: number): Promise<number> {
  const { data, error } = await supabase.rpc('apply_elo_delta', { p_delta: Math.round(delta) });
  if (error) throw new Error(`Failed to update Elo: ${error.message}`);
  return data;
}

export interface RecordAttemptInput {
  levelId: string;
  mode: StudyMode;
  score: number;
  eloDelta: number;
  summary?: string;
  /** First 2 Lines: whether the verdict was "valid". Defaults to score >= 80. */
  passed?: boolean;
  /** Set false when Elo was already applied incrementally (Level Climb). */
  applyElo?: boolean;
}

export interface RecordAttemptResult {
  passed: boolean;
  unlockedLevel: number | null;
  elo: number;
  streakDays: number;
  lastStudyDate: string | null;
}

/**
 * Logs the attempt and atomically applies progression in Postgres:
 * best_score, unlock level N+1 at >= 80%, mastery_elo and daily_streak.
 */
export async function recordStudyAttempt(input: RecordAttemptInput): Promise<RecordAttemptResult> {
  const { data, error } = await supabase.rpc('record_study_attempt', {
    p_level_id: input.levelId,
    p_mode: MODE_TO_DB[input.mode],
    p_score: Math.round(input.score),
    p_elo_delta: Math.round(input.eloDelta),
    p_summary: input.summary ?? null,
    p_passed: input.passed ?? null,
    p_local_date: getTodayIsoDate(),
    p_apply_elo: input.applyElo ?? true,
  });
  if (error) throw new Error(`Failed to save study attempt: ${error.message}`);

  const r = (data ?? {}) as Record<string, unknown>;
  return {
    passed: Boolean(r.passed),
    unlockedLevel: typeof r.unlocked_level === 'number' ? r.unlocked_level : null,
    elo: Number(r.mastery_elo),
    streakDays: Number(r.daily_streak),
    lastStudyDate: typeof r.last_study_date === 'string' ? r.last_study_date : null,
  };
}

export async function listStudySessions(courses: Course[], limit = 100): Promise<SessionRecord[]> {
  const { data, error } = await supabase
    .from('study_attempts')
    .select('id, level_id, mode, score, elo_delta, summary, created_at')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw new Error(`Failed to load session history: ${error.message}`);

  // Resolve course / level labels from the already-loaded course list.
  const levelIndex = new Map<string, { course: Course; levelNumber: number; title: string }>();
  for (const course of courses) {
    for (const lvl of course.levels) {
      levelIndex.set(lvl.id, { course, levelNumber: lvl.levelNumber, title: lvl.title });
    }
  }

  return data.map((row) => {
    const ref = levelIndex.get(row.level_id);
    return {
      id: row.id,
      courseId: ref?.course.id ?? '',
      courseName: ref?.course.name ?? 'Deleted course',
      levelNumber: ref?.levelNumber ?? 0,
      levelTitle: ref?.title ?? '—',
      mode: MODE_FROM_DB[row.mode],
      score: row.score,
      eloDelta: row.elo_delta,
      timestamp: row.created_at,
      summary: row.summary ?? '',
    };
  });
}

/**
 * Portable JSON backup of everything the user owns (excluding raw PDF bytes,
 * which stay in Supabase Storage). Includes cached lessons & questions.
 */
export async function buildExportBackup(): Promise<Record<string, unknown>> {
  await requireUserId();
  const [profile, courses, pdfs, levels, attempts] = await Promise.all([
    supabase.from('profiles').select('*').maybeSingle(),
    supabase.from('courses').select('*').order('created_at'),
    supabase.from('course_pdfs').select('id, course_id, file_name, storage_path, doc_category, size_bytes, extracted_summary, extracted_topics, created_at'),
    supabase.from('levels').select('*').order('level_number'),
    supabase.from('study_attempts').select('*').order('created_at', { ascending: false }),
  ]);
  for (const res of [profile, courses, pdfs, levels, attempts]) {
    if (res.error) throw new Error(`Export failed: ${res.error.message}`);
  }

  return {
    format: 'axiom-cloud-backup',
    version: 2,
    exportedAt: new Date().toISOString(),
    profile: profile.data,
    courses: (courses.data ?? []).map((c) => ({
      ...c,
      pdfs: (pdfs.data ?? []).filter((p) => p.course_id === c.id),
      levels: (levels.data ?? []).filter((l) => l.course_id === c.id),
    })),
    studyAttempts: attempts.data ?? [],
  };
}
