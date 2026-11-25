/**
 * Course data layer: courses, PDFs (Supabase Storage + `course_pdfs`), the
 * 10-level roadmap (`levels`), smart per-level PDF context slicing, and the
 * cross-device lesson / question cache stored on each `levels` row.
 */
import type {
  ClimbQuestion,
  Course,
  DocCategory,
  LessonDoubtMessage,
  LevelLesson,
  LevelTier,
  PdfAttachmentMeta,
  PdfPayload,
  SkillLevel,
} from '../types';
import type { Database, Json } from '../lib/database.types';
import { COURSE_MATERIALS_BUCKET, requireUserId, supabase } from '../lib/supabase';
import { safeFetchJson } from '../utils/apiClient';

type CourseRow = Database['public']['Tables']['courses']['Row'];
type PdfRow = Database['public']['Tables']['course_pdfs']['Row'];
type LevelRow = Database['public']['Tables']['levels']['Row'];
type LevelInsert = Database['public']['Tables']['levels']['Insert'];

/** Matches the bucket's `file_size_limit` in 001_initial_schema.sql. */
export const MAX_SINGLE_PDF_BYTES = 50 * 1024 * 1024;
const PDF_BATCH_SIZE = 5;
const DOC_CATEGORIES: DocCategory[] = ['lecture_notes', 'slides', 'past_exam', 'problem_set'];
const LEVEL_TIERS: LevelTier[] = ['foundation', 'application', 'exam', 'distinction'];

// Lightweight column lists — heavy cache columns are only loaded per level on demand.
const PDF_COLUMNS =
  'id, course_id, user_id, file_name, storage_path, extracted_summary, doc_category, size_bytes, extracted_topics, gemini_file_uri, gemini_file_expires_at, created_at';
const LEVEL_COLUMNS =
  'id, course_id, user_id, level_number, title, description, relevant_pdf_names, is_unlocked, best_score, tier, objectives, key_formulas, source_excerpt, is_mastered, attempts, reflex_passed, feynman_best_clarity, updated_at';

// ---------------------------------------------------------------------------
// Helpers & row mappers
// ---------------------------------------------------------------------------

function fail(context: string, error: { message: string } | null): never {
  throw new Error(`${context}: ${error?.message ?? 'unknown error'}`);
}

function asStringArray(value: Json | null | undefined): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

export function inferDocCategory(fileName: string): DocCategory {
  const lower = fileName.toLowerCase();
  if (['exam', 'midterm', 'final', 'quiz'].some((k) => lower.includes(k))) return 'past_exam';
  if (lower.includes('slide') || lower.includes('lec')) return 'slides';
  if (lower.includes('hw') || lower.includes('ps') || lower.includes('problem')) return 'problem_set';
  return 'lecture_notes';
}

/** Storage keys must be URL-safe; the original name is kept in `course_pdfs.file_name`. */
function sanitizeStorageFileName(name: string): string {
  const dot = name.toLowerCase().endsWith('.pdf') ? name.slice(0, -4) : name;
  const base = dot
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
  return `${base || 'document'}.pdf`;
}

function rowToPdfMeta(row: PdfRow): PdfAttachmentMeta {
  return {
    id: row.id,
    name: row.file_name,
    storagePath: row.storage_path,
    size: Number(row.size_bytes) || 0,
    uploadedAt: row.created_at,
    docCategory: DOC_CATEGORIES.includes(row.doc_category as DocCategory)
      ? (row.doc_category as DocCategory)
      : 'lecture_notes',
    fileUri: row.gemini_file_uri ?? undefined,
    fileExpiresAt: row.gemini_file_expires_at ?? undefined,
    extractedTopics: asStringArray(row.extracted_topics),
    extractedSummary: row.extracted_summary ?? undefined,
  };
}

type LevelListRow = Omit<LevelRow, 'cached_lesson_markdown' | 'cached_questions' | 'cached_lesson' | 'lesson_doubts'>;

function rowToLevel(row: LevelListRow): SkillLevel {
  const pdfNames = asStringArray(row.relevant_pdf_names);
  return {
    id: row.id,
    levelNumber: row.level_number,
    title: row.title,
    tier: LEVEL_TIERS.includes(row.tier as LevelTier) ? (row.tier as LevelTier) : 'foundation',
    summary: row.description ?? '',
    objectives: asStringArray(row.objectives),
    keyFormulas: asStringArray(row.key_formulas),
    sourceExcerpt: row.source_excerpt ?? '',
    relevantPdfNames: pdfNames,
    sourcePdfNames: pdfNames,
    unlocked: row.is_unlocked,
    mastered: row.is_mastered,
    // best_score is NOT NULL DEFAULT 0 — show "—" until the first attempt.
    bestScore: row.attempts > 0 ? row.best_score : null,
    attempts: row.attempts,
    reflexPassed: row.reflex_passed,
    feynmanBestClarity: row.feynman_best_clarity,
  };
}

function rowToCourse(row: CourseRow, pdfs: PdfRow[], levels: LevelListRow[]): Course {
  const syllabus = row.combined_syllabus_summary ?? '';
  return {
    id: row.id,
    name: row.title,
    code: row.code,
    examDate: row.exam_date ?? undefined,
    createdAt: row.created_at,
    detectedLanguage: row.detected_language,
    courseDigest: row.course_digest ?? syllabus,
    batchSyllabi: syllabus ? syllabus.split(/\n{2,}(?=### Batch )/) : [],
    pdfFiles: pdfs
      .filter((p) => p.course_id === row.id)
      .sort((a, b) => a.created_at.localeCompare(b.created_at))
      .map(rowToPdfMeta),
    levels: levels
      .filter((l) => l.course_id === row.id)
      .sort((a, b) => a.level_number - b.level_number)
      .map(rowToLevel),
  };
}

// ---------------------------------------------------------------------------
// Courses
// ---------------------------------------------------------------------------

async function loadCourses(courseId?: string): Promise<Course[]> {
  let coursesQ = supabase.from('courses').select('*').order('created_at', { ascending: true });
  let pdfsQ = supabase.from('course_pdfs').select(PDF_COLUMNS);
  let levelsQ = supabase.from('levels').select(LEVEL_COLUMNS);
  if (courseId) {
    coursesQ = coursesQ.eq('id', courseId);
    pdfsQ = pdfsQ.eq('course_id', courseId);
    levelsQ = levelsQ.eq('course_id', courseId);
  }

  const [courses, pdfs, levels] = await Promise.all([coursesQ, pdfsQ, levelsQ]);
  if (courses.error) fail('Failed to load courses', courses.error);
  if (pdfs.error) fail('Failed to load course PDFs', pdfs.error);
  if (levels.error) fail('Failed to load levels', levels.error);

  return courses.data.map((c) => rowToCourse(c, pdfs.data, levels.data));
}

export function listCourses(): Promise<Course[]> {
  return loadCourses();
}

export async function fetchCourse(courseId: string): Promise<Course> {
  const [course] = await loadCourses(courseId);
  if (!course) throw new Error('Course not found.');
  return course;
}

export async function createCourse(input: {
  name: string;
  code?: string;
  examDate?: string;
}): Promise<Course> {
  const userId = await requireUserId();
  const { data, error } = await supabase
    .from('courses')
    .insert({
      user_id: userId,
      title: input.name.trim(),
      code: input.code?.trim() || 'ENG',
      exam_date: input.examDate || null,
    })
    .select('*')
    .single();
  if (error) fail('Failed to create course', error);
  return rowToCourse(data, [], []);
}

/** Removes every stored PDF under {user}/{course}/ and then the course row (cascades). */
export async function deleteCourse(courseId: string): Promise<void> {
  const userId = await requireUserId();
  const prefix = `${userId}/${courseId}`;
  const bucket = supabase.storage.from(COURSE_MATERIALS_BUCKET);

  // Storage list() pages at 100 entries by default
  for (;;) {
    const { data: objects, error } = await bucket.list(prefix, { limit: 100 });
    if (error) fail('Failed to list course files', error);
    if (!objects || objects.length === 0) break;
    const { error: rmError } = await bucket.remove(objects.map((o) => `${prefix}/${o.name}`));
    if (rmError) fail('Failed to delete course files', rmError);
    if (objects.length < 100) break;
  }

  const { error } = await supabase.from('courses').delete().eq('id', courseId);
  if (error) fail('Failed to delete course', error);
}

// ---------------------------------------------------------------------------
// PDFs
// ---------------------------------------------------------------------------

export async function uploadCoursePdf(
  course: Course,
  file: File,
  docCategory: DocCategory = inferDocCategory(file.name),
): Promise<PdfAttachmentMeta> {
  if (file.size > MAX_SINGLE_PDF_BYTES) {
    throw new Error(
      `"${file.name}" is ${formatBytes(file.size)}, which exceeds the ${formatBytes(MAX_SINGLE_PDF_BYTES)} per-file limit.`,
    );
  }
  if (course.pdfFiles.some((p) => p.name.toLowerCase() === file.name.toLowerCase())) {
    throw new Error(`"${file.name}" is already attached to this course.`);
  }

  const userId = await requireUserId();
  const storagePath = `${userId}/${course.id}/${sanitizeStorageFileName(file.name)}`;
  const bucket = supabase.storage.from(COURSE_MATERIALS_BUCKET);

  const { error: uploadError } = await bucket.upload(storagePath, file, {
    contentType: 'application/pdf',
    upsert: false,
  });
  if (uploadError) {
    if (/exists|duplicate/i.test(uploadError.message)) {
      throw new Error(`A file named like "${file.name}" is already stored for this course.`);
    }
    fail(`Failed to upload "${file.name}"`, uploadError);
  }

  const { data, error } = await supabase
    .from('course_pdfs')
    .insert({
      course_id: course.id,
      user_id: userId,
      file_name: file.name,
      storage_path: storagePath,
      doc_category: docCategory,
      size_bytes: file.size,
    })
    .select(PDF_COLUMNS)
    .single();

  if (error) {
    // Roll back the orphaned storage object so retries are clean.
    await bucket.remove([storagePath]);
    fail(`Failed to save "${file.name}"`, error);
  }
  return rowToPdfMeta(data);
}

export async function updatePdfCategory(pdfId: string, docCategory: DocCategory): Promise<void> {
  const { error } = await supabase.from('course_pdfs').update({ doc_category: docCategory }).eq('id', pdfId);
  if (error) fail('Failed to update document type', error);
}

export async function deleteCoursePdf(pdf: PdfAttachmentMeta): Promise<void> {
  const { error: rmError } = await supabase.storage.from(COURSE_MATERIALS_BUCKET).remove([pdf.storagePath]);
  if (rmError) fail(`Failed to delete "${pdf.name}" from storage`, rmError);
  const { error } = await supabase.from('course_pdfs').delete().eq('id', pdf.id);
  if (error) fail(`Failed to delete "${pdf.name}"`, error);
  geminiUriCache.delete(pdf.id);
}

// ---------------------------------------------------------------------------
// Gemini file handles (server downloads from Storage → Gemini Files API)
// ---------------------------------------------------------------------------

const geminiUriCache = new Map<string, { fileUri: string; expiresAt?: string }>();

/** Gemini file handles belong to the API key's project; call after the key changes. */
export function clearGeminiUriCache(): void {
  geminiUriCache.clear();
}

function isUriFresh(expiresAt?: string): boolean {
  return !expiresAt || new Date(expiresAt).getTime() > Date.now() + 5 * 60 * 1000;
}

/**
 * Returns Gemini-ready payloads for the given PDFs. Fresh cached handles are
 * reused; otherwise the server pulls the file from Supabase Storage (under the
 * user's JWT, so RLS applies), uploads it to Gemini and caches the new URI on
 * the `course_pdfs` row for every device.
 */
async function resolveGeminiPayloads(pdfs: PdfAttachmentMeta[], force = false): Promise<PdfPayload[]> {
  const out: PdfPayload[] = [];
  const concurrency = 3;

  for (let i = 0; i < pdfs.length; i += concurrency) {
    const slice = pdfs.slice(i, i + concurrency);
    const resolved = await Promise.all(
      slice.map(async (pdf): Promise<PdfPayload> => {
        const cached =
          geminiUriCache.get(pdf.id) ??
          (pdf.fileUri ? { fileUri: pdf.fileUri, expiresAt: pdf.fileExpiresAt } : undefined);

        if (!force && cached && isUriFresh(cached.expiresAt)) {
          return { name: pdf.name, docCategory: pdf.docCategory, fileUri: cached.fileUri, mimeType: 'application/pdf' };
        }

        const data = await safeFetchJson<{ fileUri: string; expirationTime?: string; mimeType?: string }>(
          '/api/files/from-storage',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            timeoutMs: 90000,
            body: JSON.stringify({ pdfId: pdf.id, force }),
          },
        );
        geminiUriCache.set(pdf.id, { fileUri: data.fileUri, expiresAt: data.expirationTime });
        return {
          name: pdf.name,
          docCategory: pdf.docCategory,
          fileUri: data.fileUri,
          mimeType: data.mimeType || 'application/pdf',
        };
      }),
    );
    out.push(...resolved);
  }
  return out;
}

export function isStaleFileUriError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('permission') ||
    msg.includes('not_found') ||
    msg.includes('not found') ||
    msg.includes('expired') ||
    msg.includes('files/')
  );
}

// ---------------------------------------------------------------------------
// Smart context slicing — only the 1–2 PDFs relevant to a level
// ---------------------------------------------------------------------------

export function selectLevelPdfs(course: Course, level: SkillLevel, maxPdfs = 2): PdfAttachmentMeta[] {
  const records = course.pdfFiles;
  if (records.length === 0) return [];

  const explicit = (level.relevantPdfNames?.length ? level.relevantPdfNames : level.sourcePdfNames ?? [])
    .map((n) => n.toLowerCase().trim())
    .filter(Boolean)
    .slice(0, maxPdfs);

  const exact: PdfAttachmentMeta[] = [];
  for (const target of explicit) {
    const match = records.find((r) => r.name.toLowerCase().trim() === target);
    if (match && !exact.includes(match)) exact.push(match);
  }
  if (exact.length > 0) return exact.slice(0, maxPdfs);
  if (records.length <= maxPdfs) return records;

  // Fallback heuristic when Gemini's filenames don't match exactly.
  const query = `${level.title} ${level.summary} ${level.objectives.join(' ')}`.toLowerCase();
  const scored = records.map((rec) => {
    const name = rec.name.toLowerCase();
    let score = 0;
    for (const target of explicit) {
      if (name.includes(target) || target.includes(name)) score += 50;
    }
    if ((level.tier === 'exam' || level.tier === 'distinction') && rec.docCategory === 'past_exam') {
      score += 20;
    } else if (
      (level.tier === 'foundation' || level.tier === 'application') &&
      (rec.docCategory === 'lecture_notes' || rec.docCategory === 'slides')
    ) {
      score += 15;
    }
    for (const topic of rec.extractedTopics ?? []) {
      if (topic && query.includes(topic.toLowerCase())) score += 10;
    }
    for (const w of name.replace(/[^a-z0-9]+/g, ' ').split(' ')) {
      if (w.length > 3 && query.includes(w)) score += 5;
    }
    return { rec, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxPdfs).map((s) => s.rec);
}

/**
 * Picks the past exam (or, failing that, problem set) that best matches the
 * level, so question generators can mirror the real exam style. Returns null
 * when the course has no such material or it is already in `exclude`.
 */
export function selectExamReferencePdf(
  course: Course,
  level: SkillLevel,
  exclude: PdfAttachmentMeta[] = [],
): PdfAttachmentMeta | null {
  const candidates = course.pdfFiles.filter(
    (r) => (r.docCategory === 'past_exam' || r.docCategory === 'problem_set') && !exclude.includes(r),
  );
  if (candidates.length === 0) return null;
  if (exclude.some((r) => r.docCategory === 'past_exam')) return null;

  const query = `${level.title} ${level.summary} ${level.objectives.join(' ')} ${level.keyFormulas.join(' ')}`.toLowerCase();
  const scored = candidates.map((rec) => {
    let score = rec.docCategory === 'past_exam' ? 100 : 0;
    for (const topic of rec.extractedTopics ?? []) {
      if (topic && query.includes(topic.toLowerCase())) score += 10;
    }
    return { rec, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0].rec;
}

/**
 * Runs `fn` with Gemini payloads for ONLY the level's matched PDFs. If Gemini
 * reports an expired / missing file handle, re-pulls those PDFs from Storage
 * once and retries.
 *
 * With `includeExamReference`, one past exam / problem set is appended (when
 * the course has one) so generated questions follow the real exam style.
 */
export async function withLevelPdfContext<T>(
  course: Course,
  level: SkillLevel,
  fn: (pdfs: PdfPayload[]) => Promise<T>,
  maxPdfs = 2,
  options: { includeExamReference?: boolean } = {},
): Promise<T> {
  // Copy: selectLevelPdfs may return course.pdfFiles itself.
  const selected = [...selectLevelPdfs(course, level, maxPdfs)];
  if (options.includeExamReference) {
    const examRef = selectExamReferencePdf(course, level, selected);
    if (examRef) selected.push(examRef);
  }
  const pdfs = await resolveGeminiPayloads(selected);
  try {
    return await fn(pdfs);
  } catch (err) {
    if (!isStaleFileUriError(err) || selected.length === 0) throw err;
    return fn(await resolveGeminiPayloads(selected, true));
  }
}

// ---------------------------------------------------------------------------
// Roadmap ingestion (batched syllabus extraction → 10 levels)
// ---------------------------------------------------------------------------

interface ExtractBatchResponse {
  detectedLanguage: string;
  batchSummary: string;
  fileTopics: Array<{ fileName: string; keywords: string[]; summary: string }>;
}

interface RoadmapResponse {
  detectedLanguage?: string;
  courseDigest?: string;
  levels?: Array<Omit<SkillLevel, 'id'>>;
}

export type RoadmapProgress = (label: string, percent: number) => void;

export async function generateRoadmap(course: Course, onProgress: RoadmapProgress = () => {}): Promise<Course> {
  const userId = await requireUserId();
  const allPdfs = course.pdfFiles;
  if (allPdfs.length === 0) {
    throw new Error('No PDFs attached yet. Please add your course PDFs first.');
  }

  // Step 1: Topic & formula extraction in batches of 5 PDFs
  const totalBatches = Math.ceil(allPdfs.length / PDF_BATCH_SIZE);
  const batchSyllabi: string[] = [];
  const topicByFile = new Map<string, { keywords: string[]; summary: string }>();
  let detectedLang = course.detectedLanguage || 'English';

  for (let b = 0; b < totalBatches; b++) {
    const batchMeta = allPdfs.slice(b * PDF_BATCH_SIZE, (b + 1) * PDF_BATCH_SIZE);
    const pct = 10 + Math.round((b / totalBatches) * 70);
    const label = `Extracting topics from batch ${b + 1}/${totalBatches} (${batchMeta.length} PDF${batchMeta.length > 1 ? 's' : ''})…`;
    onProgress(label, pct);

    const runBatch = async (force: boolean) => {
      if (force) onProgress(`Refreshing PDF file handles for batch ${b + 1}/${totalBatches}…`, pct);
      const pdfs = await resolveGeminiPayloads(batchMeta, force);
      return safeFetchJson<ExtractBatchResponse>('/api/roadmap/extract-batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        timeoutMs: 60000,
        onRetryStatus: (s) => s && onProgress(`Batch ${b + 1}/${totalBatches}: ${s}`, pct),
        body: JSON.stringify({
          courseName: course.name,
          courseCode: course.code,
          batchIndex: b,
          totalBatches,
          pdfs,
        }),
      });
    };

    let extracted: ExtractBatchResponse;
    try {
      extracted = await runBatch(false);
    } catch (err) {
      if (!isStaleFileUriError(err)) throw err;
      extracted = await runBatch(true);
    }

    if (b === 0 && extracted.detectedLanguage) detectedLang = extracted.detectedLanguage;
    if (extracted.batchSummary) batchSyllabi.push(`### Batch ${b + 1}\n${extracted.batchSummary}`);
    for (const ft of extracted.fileTopics ?? []) {
      topicByFile.set(ft.fileName.toLowerCase(), { keywords: ft.keywords ?? [], summary: ft.summary ?? '' });
    }
  }

  const combinedSyllabus = batchSyllabi.join('\n\n');
  const fileManifest = allPdfs.map((f) => {
    const t = topicByFile.get(f.name.toLowerCase());
    return {
      name: f.name,
      docCategory: f.docCategory,
      keywords: t?.keywords ?? f.extractedTopics ?? [],
      summary: t?.summary ?? f.extractedSummary ?? '',
    };
  });

  // Step 2: Synthesize the 10-level tree from the lightweight syllabus text
  onProgress('Synthesizing 10-Level Sequential Skill Tree…', 88);
  const data = await safeFetchJson<RoadmapResponse>('/api/roadmap/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    timeoutMs: 45000,
    onRetryStatus: (s) => s && onProgress(`Synthesizing 10-Level Tree: ${s}`, 88),
    body: JSON.stringify({
      courseName: course.name,
      courseCode: course.code,
      detectedLanguage: detectedLang,
      combinedSyllabus,
      fileManifest,
    }),
  });

  const levels = (data.levels ?? []).slice(0, 10);
  if (levels.length === 0) throw new Error('Gemini returned an empty roadmap. Please try again.');

  // Step 3: Persist everything to Supabase
  onProgress('Saving roadmap to your account…', 95);

  const pdfUpdates = allPdfs
    .map((pdf) => ({ pdf, topics: topicByFile.get(pdf.name.toLowerCase()) }))
    .filter((x) => x.topics);
  await Promise.all(
    pdfUpdates.map(async ({ pdf, topics }) => {
      const { error } = await supabase
        .from('course_pdfs')
        .update({ extracted_summary: topics!.summary, extracted_topics: topics!.keywords })
        .eq('id', pdf.id);
      if (error) fail(`Failed to save topics for "${pdf.name}"`, error);
    }),
  );

  const { error: courseError } = await supabase
    .from('courses')
    .update({
      detected_language: data.detectedLanguage || detectedLang,
      course_digest: data.courseDigest || combinedSyllabus,
      combined_syllabus_summary: combinedSyllabus,
    })
    .eq('id', course.id);
  if (courseError) fail('Failed to save course syllabus', courseError);

  // Upsert on (course_id, level_number) keeps level ids — and therefore the
  // study_attempts history — while resetting progress and caches for the new tree.
  const rows: LevelInsert[] = levels.map((lvl, idx) => {
    const levelNumber = idx + 1;
    return {
      course_id: course.id,
      user_id: userId,
      level_number: levelNumber,
      title: lvl.title,
      description: lvl.summary,
      tier: LEVEL_TIERS.includes(lvl.tier) ? lvl.tier : 'foundation',
      objectives: lvl.objectives ?? [],
      key_formulas: lvl.keyFormulas ?? [],
      source_excerpt: lvl.sourceExcerpt ?? '',
      relevant_pdf_names: (lvl.relevantPdfNames ?? lvl.sourcePdfNames ?? []).slice(0, 2),
      is_unlocked: levelNumber === 1,
      is_mastered: false,
      best_score: 0,
      attempts: 0,
      reflex_passed: 0,
      feynman_best_clarity: null,
      cached_lesson: null,
      cached_lesson_markdown: null,
      cached_questions: null,
      lesson_doubts: [],
    };
  });

  const { error: levelsError } = await supabase.from('levels').upsert(rows, { onConflict: 'course_id,level_number' });
  if (levelsError) fail('Failed to save roadmap levels', levelsError);

  const { error: pruneError } = await supabase
    .from('levels')
    .delete()
    .eq('course_id', course.id)
    .gt('level_number', rows.length);
  if (pruneError) fail('Failed to prune old levels', pruneError);

  onProgress('10-Level Skill Tree ready', 100);
  return fetchCourse(course.id);
}

// ---------------------------------------------------------------------------
// Per-level content cache (shared by every device the user signs in from)
// ---------------------------------------------------------------------------

export interface LevelContentCache {
  lesson: LevelLesson | null;
  questions: ClimbQuestion[] | null;
  doubts: LessonDoubtMessage[];
}

export async function getLevelCache(levelId: string): Promise<LevelContentCache> {
  const { data, error } = await supabase
    .from('levels')
    .select('cached_lesson, cached_questions, lesson_doubts')
    .eq('id', levelId)
    .single();
  if (error) fail('Failed to load level content', error);

  const questions = Array.isArray(data.cached_questions)
    ? (data.cached_questions as unknown as ClimbQuestion[])
    : null;
  return {
    lesson: data.cached_lesson && typeof data.cached_lesson === 'object'
      ? (data.cached_lesson as unknown as LevelLesson)
      : null,
    questions: questions && questions.length > 0 ? questions : null,
    doubts: Array.isArray(data.lesson_doubts) ? (data.lesson_doubts as unknown as LessonDoubtMessage[]) : [],
  };
}

export async function saveLevelLesson(levelId: string, lesson: LevelLesson, resetDoubts = false): Promise<void> {
  const { error } = await supabase
    .from('levels')
    .update({
      cached_lesson: lesson as unknown as Json,
      cached_lesson_markdown: lessonToMarkdown(lesson),
      ...(resetDoubts ? { lesson_doubts: [] } : {}),
    })
    .eq('id', levelId);
  if (error) fail('Failed to cache lesson', error);
}

export async function saveLessonDoubts(levelId: string, doubts: LessonDoubtMessage[]): Promise<void> {
  const { error } = await supabase
    .from('levels')
    .update({ lesson_doubts: doubts.slice(-20) as unknown as Json })
    .eq('id', levelId);
  if (error) fail('Failed to save lesson Q&A', error);
}

export async function saveLevelQuestions(levelId: string, questions: ClimbQuestion[]): Promise<void> {
  const { error } = await supabase
    .from('levels')
    .update({ cached_questions: questions as unknown as Json })
    .eq('id', levelId);
  if (error) fail('Failed to cache questions', error);
}

/** Portable Markdown rendering of a lesson, stored in `levels.cached_lesson_markdown`. */
export function lessonToMarkdown(lesson: LevelLesson): string {
  const lines: string[] = [`# ${lesson.title}`, '', lesson.intuition, ''];
  for (const section of lesson.sections) {
    lines.push(`## ${section.heading}`, '');
    for (const b of section.bullets) lines.push(`- ${b}`);
    if (section.keyEquation) lines.push('', `$$${section.keyEquation.replace(/^\$+|\$+$/g, '')}$$`);
    lines.push('');
  }
  const ex = lesson.workedExample;
  lines.push('## Worked Example', '', ex.problemStatement, '');
  ex.steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
  lines.push('', `**Answer:** ${ex.finalAnswer}`, '', `> ${ex.takeaway}`, '');
  if (lesson.commonPitfalls.length > 0) {
    lines.push('## Common Pitfalls', '');
    for (const p of lesson.commonPitfalls) lines.push(`- ${p}`);
  }
  return lines.join('\n').trim();
}
