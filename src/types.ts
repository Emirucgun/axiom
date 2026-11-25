export type LevelTier = 'foundation' | 'application' | 'exam' | 'distinction';

export type DocCategory = 'lecture_notes' | 'slides' | 'past_exam' | 'problem_set';

export interface PdfAttachmentMeta {
  id: string;
  name: string;
  /** Object key inside the `course-materials` bucket: {user_id}/{course_id}/{file} */
  storagePath: string;
  size: number;
  uploadedAt: string;
  docCategory: DocCategory;
  fileUri?: string;
  fileExpiresAt?: string;
  extractedTopics?: string[];
  extractedSummary?: string;
}

export interface PdfPayload {
  name: string;
  docCategory: DocCategory;
  fileUri?: string;
  mimeType?: string;
  base64?: string;
}

export interface LessonSection {
  heading: string;
  bullets: string[];
  keyEquation?: string;
}

export interface WorkedExample {
  problemStatement: string;
  steps: string[];
  finalAnswer: string;
  takeaway: string;
}

export interface LevelLesson {
  title: string;
  intuition: string;
  sections: LessonSection[];
  workedExample: WorkedExample;
  commonPitfalls: string[];
  generatedAt: string;
}

export interface LessonDoubtMessage {
  role: 'user' | 'ai';
  content: string;
}

export interface SkillLevel {
  /** `levels.id` row uuid in Supabase */
  id: string;
  levelNumber: number;
  title: string;
  tier: LevelTier;
  summary: string;
  objectives: string[];
  keyFormulas: string[];
  sourceExcerpt: string;
  relevantPdfNames?: string[];
  sourcePdfNames: string[];
  unlocked: boolean;
  mastered: boolean;
  bestScore: number | null;
  attempts: number;
  reflexPassed: number;
  feynmanBestClarity: number | null;
}

export interface Course {
  id: string;
  name: string;
  code: string;
  examDate?: string;
  createdAt: string;
  detectedLanguage: string;
  courseDigest: string;
  batchSyllabi?: string[];
  pdfFiles: PdfAttachmentMeta[];
  levels: SkillLevel[];
}

export interface ClimbQuestion {
  id: string;
  index: number;
  kind: 'conceptual' | 'problem';
  prompt: string;
  hint: string;
  targetConcepts: string[];
}

export interface ClimbGradeResult {
  score: number;
  isCorrect: boolean;
  verdict: string;
  stepFeedback: string;
  workedSolution: string;
  eloDelta: number;
}

export interface ReflexProblem {
  problemText: string;
  sourceContext: string;
  expectedFocus: string;
}

export interface ReflexEvaluation {
  verdict: 'valid' | 'partial' | 'invalid';
  score: number;
  trajectoryAssessment: string;
  missingOrWrong: string;
  optimalFirstTwoLines: string;
  eloDelta: number;
}

export interface FeynmanMessage {
  role: 'ai' | 'user';
  content: string;
  timestamp: string;
}

export interface FeynmanTurnResponse {
  reply: string;
  turnAssessment: string;
  readyToScore: boolean;
  clarityScore?: number;
  strengths?: string[];
  gaps?: string[];
  eloDelta?: number;
}

export interface SessionRecord {
  id: string;
  courseId: string;
  courseName: string;
  levelNumber: number;
  levelTitle: string;
  mode: 'climb' | 'reflex' | 'feynman';
  score: number;
  eloDelta: number;
  timestamp: string;
  summary: string;
}

export interface UserProfile {
  id: string;
  email: string | null;
  elo: number;
  streakDays: number;
  lastStudyDate: string | null;
}

export type StudyMode = 'climb' | 'reflex' | 'feynman';
