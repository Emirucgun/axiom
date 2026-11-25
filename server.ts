import dotenv from 'dotenv';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import crypto from 'crypto';
import { GoogleGenAI, Type, ThinkingLevel } from '@google/genai';
import type { Part, GenerateContentResponse } from '@google/genai';
import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './src/lib/database.types';

// .env.local (shared with Vite) takes precedence over .env
dotenv.config({ path: ['.env.local', '.env'], quiet: true });

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const MODEL_ID = 'gemini-4-hydrogen';
const FAST_MODEL_ID = 'gemini-3.1-flash-lite';

// ---------------------------------------------------------------------------
// Output language policy
// ---------------------------------------------------------------------------
// Explanations (lessons, feedback, hints, dialogue) are written in Turkish, but
// key technical terms stay in English so they match the vocabulary of exams and
// textbooks. Exam questions/problem statements themselves are written fully in
// English. The source PDFs can be in any language.
const EXPLANATION_LANGUAGE = 'Turkish';
const QUESTION_LANGUAGE = 'English';

const LANGUAGE_POLICY = `LANGUAGE POLICY (mandatory, overrides the language of the source PDFs and of the student's input):
- Write all explanations, teaching text, hints, feedback, and conversation in ${EXPLANATION_LANGUAGE}.
- Keep important technical terms, concept names, theorem/law names, and standard jargon in English (e.g. "eigenvalue", "boundary condition", "Laplace transform", "free body diagram", "steady state"). Do NOT translate them into ${EXPLANATION_LANGUAGE}. Use them naturally inside ${EXPLANATION_LANGUAGE} sentences, e.g. "Bu sistemde eigenvalue'lar negatif olduğu için system stable'dır."
- Write every exam question, problem statement, and question prompt entirely in ${QUESTION_LANGUAGE}, exactly as it would appear on an English-language university exam paper.`;

// Persona + rules shared by every endpoint that writes exam-style questions.
const EXAM_PROFESSOR_GUIDE = `You are the university professor who teaches this course AND writes its midterm and final exams. Write the questions you would actually put on your own exam.

How you choose and write questions:
1. Target high-yield, core material: the central theorems, laws, methods, and derivations that the syllabus and lecture notes spend the most time on. A topic that appears in the level objectives or key formulas is exam material; a passing remark is not.
2. If a past exam, quiz, or problem set is attached (Category: past_exam or problem_set), treat it as the strongest signal: mirror its question formats, difficulty, notation, typical given values, and recurring archetypes. Create NEW variants (different numbers, configurations, or a twist); never copy a question verbatim.
3. If no past exam is attached, predict what is most likely to be asked from the topic list: use the classic, standard exam archetypes for these topics as they appear in well-known university textbooks and exams (e.g. "derive ...", "compute ... for the given system", "determine whether ... and justify", "sketch/interpret ...", multi-part (a)(b)(c) problems).
4. Each question must be self-contained and solvable on paper in a realistic exam time: give all needed data with units, define every symbol, and state the assumptions. One unambiguous expected answer or method.
5. NEVER write irrelevant or low-value questions: no trivia, history, or name-dropping; no questions about the documents themselves ("according to slide 4...", "what does the author say..."); no definitions-only recall unless the level is foundational; nothing outside the course scope; no vague essay questions.
6. Use the course's own notation and conventions from the attached material.`;

const NO_GEMINI_KEY_MESSAGE =
  'No Gemini API key configured. Add your own key under "API Key" in the header to use AI features.';

function createAiClient(apiKey: string) {
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 1): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const message = err instanceof Error ? err.message : String(err);
      // Only retry 503/UNAVAILABLE briefly on server; return 429 cleanly to client for visible 3s->6s cooldown UI
      const isTransient503 = message.includes('503') || message.includes('UNAVAILABLE');
      if (!isTransient503 || attempt === maxRetries) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
  }
  throw lastError;
}

interface IncomingPdf {
  name: string;
  docCategory?: string;
  fileUri?: string;
  mimeType?: string;
  base64?: string;
}

function isExamReference(pdf: IncomingPdf): boolean {
  return pdf?.docCategory === 'past_exam' || pdf?.docCategory === 'problem_set';
}

/** Tells the model whether real exam material is attached, so it knows how to calibrate. */
function describeExamReferences(pdfs?: IncomingPdf[]): string {
  const refs = (Array.isArray(pdfs) ? pdfs : []).filter(isExamReference);
  return refs.length > 0
    ? `Exam reference material attached: ${refs.map((p) => `"${p.name}" (${p.docCategory})`).join(', ')}. Model your questions on these.`
    : 'No past exam is attached: predict the most likely exam questions from the topics, objectives, and key formulas.';
}

function buildPdfParts(pdfs?: IncomingPdf[], maxCount?: number): Part[] {
  if (!Array.isArray(pdfs) || pdfs.length === 0) {
    return [];
  }
  const sliced = typeof maxCount === 'number' ? pdfs.slice(0, maxCount) : pdfs;
  const parts: Part[] = [];
  for (const pdf of sliced) {
    if (pdf?.fileUri) {
      parts.push({
        text: `[Attached PDF Document: "${pdf.name}" | Category: ${pdf.docCategory ?? 'lecture_notes'}]`,
      });
      parts.push({
        fileData: {
          fileUri: pdf.fileUri,
          mimeType: pdf.mimeType || 'application/pdf',
        },
      });
    } else if (pdf?.base64) {
      const cleanBase64 = pdf.base64.includes(',')
        ? pdf.base64.split(',')[1]
        : pdf.base64;
      parts.push({
        text: `[Attached PDF Document: "${pdf.name}" | Category: ${pdf.docCategory ?? 'lecture_notes'}]`,
      });
      parts.push({
        inlineData: {
          mimeType: 'application/pdf',
          data: cleanBase64,
        },
      });
    }
  }
  return parts;
}

function parseJsonSafe<T>(raw: string | undefined, fallbackMessage: string): T {
  if (!raw || !raw.trim()) {
    throw new Error(fallbackMessage);
  }
  try {
    return JSON.parse(raw.trim()) as T;
  } catch {
    const cleaned = raw
      .trim()
      .replace(/^```json\s*/i, '')
      .replace(/^```\s*/i, '')
      .replace(/\s*```$/i, '');
    return JSON.parse(cleaned) as T;
  }
}

function formatApiError(err: unknown): { status: number; message: string } {
  const raw = err instanceof Error ? err.message : String(err);
  let extractedMessage = raw;
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } };
    if (parsed?.error?.message) {
      extractedMessage = parsed.error.message;
    }
  } catch {
    // keep raw string
  }

  if (raw.includes(NO_GEMINI_KEY_MESSAGE)) {
    // 400 (not 401/403) so the client shows the message instead of a re-login prompt
    return { status: 400, message: NO_GEMINI_KEY_MESSAGE };
  }
  if (raw.includes('BYOK_ENCRYPTION_KEY')) {
    return { status: 500, message: extractedMessage };
  }
  if (raw.includes('PERMISSION_DENIED') || raw.includes('API_KEY_INVALID') || raw.includes('403')) {
    // Return 400 (not 403) so reverse proxy does not intercept and replace JSON with HTML 403 page
    return {
      status: 400,
      message: `Gemini permission error: ${extractedMessage}`,
    };
  }
  if (raw.includes('NOT_FOUND') || (raw.includes('404') && raw.toLowerCase().includes('file'))) {
    return {
      status: 400,
      message: `Gemini file token expired or not found: ${extractedMessage}`,
    };
  }
  if (raw.includes('RESOURCE_EXHAUSTED') || raw.includes('429')) {
    return {
      status: 429,
      message: 'Rate limit or quota reached. Please wait a moment and try again.',
    };
  }
  if (raw.includes('UNAVAILABLE') || raw.includes('"code":503')) {
    // Return 500 (not 503) so reverse proxy does not intercept and replace JSON with warmup HTML
    return {
      status: 500,
      message: 'Gemini model is temporarily experiencing high demand. Please retry in a few seconds.',
    };
  }
  return { status: 500, message: extractedMessage || 'Unexpected server error while calling Gemini.' };
}

// ---------------------------------------------------------------------------
// Supabase auth: every /api route (except /api/health) requires a valid user JWT
// so public deployments can't burn the server-side GEMINI_API_KEY anonymously.
// ---------------------------------------------------------------------------

type UserSupabase = SupabaseClient<Database>;

function getSupabaseConfig(): { url: string; anonKey: string } | null {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  return url && anonKey ? { url, anonKey } : null;
}

/** A Supabase client acting AS the caller, so Postgres RLS + Storage policies apply. */
function createUserSupabase(accessToken: string): UserSupabase {
  const config = getSupabaseConfig();
  if (!config) {
    throw new Error('Server is missing SUPABASE_URL / SUPABASE_ANON_KEY.');
  }
  return createClient<Database>(config.url, config.anonKey, {
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function requireSupabaseUser(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token) {
    res.status(401).json({ error: 'Sign in required.' });
    return;
  }
  if (!getSupabaseConfig()) {
    res.status(500).json({ error: 'Server is missing SUPABASE_URL / SUPABASE_ANON_KEY.' });
    return;
  }
  try {
    const supabase = createUserSupabase(token);
    const { data, error } = await supabase.auth.getUser(token);
    if (error) {
      // Only a real 4xx from Supabase Auth means the token is bad. Network or
      // 5xx failures must not masquerade as "session expired".
      const status = (error as { status?: number }).status ?? 0;
      if (status >= 400 && status < 500) {
        res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
      } else {
        console.error(`Supabase auth check failed: ${error.message}`);
        res.status(502).json({ error: 'Could not reach Supabase to verify your session. Please retry.' });
      }
      return;
    }
    if (!data.user) {
      res.status(401).json({ error: 'Your session has expired. Please sign in again.' });
      return;
    }
    res.locals.supabase = supabase;
    res.locals.userId = data.user.id;
    next();
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : 'Auth check failed.' });
  }
}

// ---------------------------------------------------------------------------
// BYOK: per-user Gemini keys, AES-256-GCM encrypted before they reach Postgres
// ---------------------------------------------------------------------------

function getByokEncryptionKey(): Buffer {
  const raw = process.env.BYOK_ENCRYPTION_KEY?.trim();
  if (!raw) {
    throw new Error('Server is missing BYOK_ENCRYPTION_KEY (32-byte base64). See .env.example.');
  }
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (key.length !== 32) {
    throw new Error('BYOK_ENCRYPTION_KEY must decode to exactly 32 bytes (base64 or 64 hex chars).');
  }
  return key;
}

function encryptSecret(plaintext: string, userId: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', getByokEncryptionKey(), iv);
  // Bind ciphertext to its owner so a row copied to another user won't decrypt
  cipher.setAAD(Buffer.from(userId));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':');
}

function decryptSecret(payload: string, userId: string): string {
  const [version, ivB64, tagB64, dataB64] = payload.split(':');
  if (version !== 'v1' || !ivB64 || !tagB64 || !dataB64) {
    throw new Error('Stored API key has an unknown format. Please re-enter it.');
  }
  const decipher = crypto.createDecipheriv('aes-256-gcm', getByokEncryptionKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAAD(Buffer.from(userId));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

/** The caller's own Gemini key if saved, else the optional server-wide fallback. */
async function resolveGeminiKey(res: Response): Promise<{ apiKey: string; source: 'user' | 'server' }> {
  const supabase = res.locals.supabase as UserSupabase;
  const userId = res.locals.userId as string;
  const { data, error } = await supabase
    .from('user_api_keys')
    .select('encrypted_key')
    .eq('user_id', userId)
    .eq('provider', 'gemini')
    .maybeSingle();
  if (error) throw new Error(`Failed to load API key: ${error.message}`);
  if (data) {
    try {
      return { apiKey: decryptSecret(data.encrypted_key, userId), source: 'user' };
    } catch (err) {
      throw new Error(
        err instanceof Error && err.message.includes('BYOK_ENCRYPTION_KEY')
          ? err.message
          : 'Your saved API key could not be decrypted. Please re-enter it under "API Key".',
      );
    }
  }
  const fallback = process.env.GEMINI_API_KEY?.trim();
  if (fallback) return { apiKey: fallback, source: 'server' };
  throw new Error(NO_GEMINI_KEY_MESSAGE);
}

async function getAiClient(res: Response): Promise<GoogleGenAI> {
  const { apiKey } = await resolveGeminiKey(res);
  return createAiClient(apiKey);
}

/** Gemini file handles are scoped to the key's project — drop them when the key changes. */
async function clearGeminiFileHandles(supabase: UserSupabase, userId: string): Promise<void> {
  const { error } = await supabase
    .from('course_pdfs')
    .update({ gemini_file_uri: null, gemini_file_expires_at: null })
    .eq('user_id', userId);
  if (error) console.warn(`Failed to clear Gemini file handles: ${error.message}`);
}

function keyHint(apiKey: string): string {
  return apiKey.slice(-4);
}

async function uploadPdfToGemini(
  ai: GoogleGenAI,
  blob: Blob,
  displayName: string,
): Promise<{ fileUri: string; mimeType: string; expirationTime?: string }> {
  let uploaded = await withRetry(() =>
    ai.files.upload({
      file: blob,
      config: { mimeType: 'application/pdf', displayName },
    }),
  );

  let attempts = 0;
  while (uploaded.state === 'PROCESSING' && uploaded.name && attempts < 15) {
    await new Promise((r) => setTimeout(r, 800));
    uploaded = await ai.files.get({ name: uploaded.name });
    attempts++;
  }
  if (uploaded.state === 'FAILED' || !uploaded.uri) {
    throw new Error(`Gemini failed to process PDF "${displayName}".`);
  }
  return {
    fileUri: uploaded.uri,
    mimeType: uploaded.mimeType || 'application/pdf',
    expirationTime: uploaded.expirationTime,
  };
}

function computeEloDelta(userElo: number, levelNumber: number, score: number, weight = 24): number {
  const levelRating = 950 + levelNumber * 80;
  const expected = 1 / (1 + Math.pow(10, (levelRating - userElo) / 400));
  const actual = Math.max(0, Math.min(1, score / 100));
  return Math.round(weight * (actual - expected));
}

/**
 * Builds the Express app with every /api route. Shared by:
 *  - local dev / `node server.ts` (startServer below adds Vite or static files)
 *  - Vercel, where api/index.ts exports it as a serverless function
 */
export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true });
  });

  // Everything below requires a signed-in Supabase user
  app.use('/api', requireSupabaseUser);

  // BYOK: status of the caller's Gemini key (never returns the key itself)
  app.get('/api/byok', async (_req, res) => {
    try {
      const supabase = res.locals.supabase as UserSupabase;
      const { data, error } = await supabase
        .from('user_api_keys')
        .select('key_hint, updated_at')
        .eq('provider', 'gemini')
        .maybeSingle();
      if (error) throw new Error(error.message);
      res.json({
        provider: 'gemini',
        hasKey: Boolean(data),
        keyHint: data?.key_hint ?? null,
        updatedAt: data?.updated_at ?? null,
        serverFallbackAvailable: Boolean(process.env.GEMINI_API_KEY?.trim()),
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load API key status.' });
    }
  });

  // BYOK: validate with Gemini, encrypt, and store the caller's key
  app.put('/api/byok', async (req, res) => {
    try {
      const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
      if (apiKey.length < 20 || apiKey.length > 200 || /\s/.test(apiKey)) {
        res.status(400).json({ error: 'That does not look like a valid Gemini API key.' });
        return;
      }
      const encrypted = encryptSecret(apiKey, res.locals.userId as string); // fails fast if server lacks BYOK_ENCRYPTION_KEY

      try {
        await createAiClient(apiKey).models.list({ config: { pageSize: 1 } });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        const rejected = /API_KEY_INVALID|PERMISSION_DENIED|UNAUTHENTICATED|40[013]/.test(detail);
        res.status(400).json({
          error: rejected
            ? 'Gemini rejected this API key. Check it at aistudio.google.com/apikey and try again.'
            : `Could not verify the key with Gemini right now: ${formatApiError(err).message}`,
        });
        return;
      }

      const supabase = res.locals.supabase as UserSupabase;
      const userId = res.locals.userId as string;
      const { error } = await supabase
        .from('user_api_keys')
        .upsert(
          { user_id: userId, provider: 'gemini', encrypted_key: encrypted, key_hint: keyHint(apiKey) },
          { onConflict: 'user_id,provider' },
        );
      if (error) throw new Error(error.message);
      await clearGeminiFileHandles(supabase, userId);

      res.json({ provider: 'gemini', hasKey: true, keyHint: keyHint(apiKey) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to save API key.' });
    }
  });

  // BYOK: remove the caller's key
  app.delete('/api/byok', async (_req, res) => {
    try {
      const supabase = res.locals.supabase as UserSupabase;
      const userId = res.locals.userId as string;
      const { error } = await supabase.from('user_api_keys').delete().eq('provider', 'gemini');
      if (error) throw new Error(error.message);
      await clearGeminiFileHandles(supabase, userId);
      res.json({ provider: 'gemini', hasKey: false, keyHint: null });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to remove API key.' });
    }
  });

  // 0. Hand a course PDF from Supabase Storage to the Gemini Files API.
  //    The download runs under the caller's JWT, so RLS guarantees users can
  //    only ever resolve their own PDFs. The resulting URI is cached on the row.
  app.post('/api/files/from-storage', async (req, res) => {
    try {
      const { pdfId, force } = req.body as { pdfId?: string; force?: boolean };
      if (!pdfId || typeof pdfId !== 'string') {
        res.status(400).json({ error: 'pdfId is required.' });
        return;
      }
      const supabase = res.locals.supabase as UserSupabase;

      const { data: row, error: rowError } = await supabase
        .from('course_pdfs')
        .select('id, file_name, storage_path, gemini_file_uri, gemini_file_expires_at')
        .eq('id', pdfId)
        .maybeSingle();
      if (rowError) throw new Error(rowError.message);
      if (!row) {
        res.status(404).json({ error: 'PDF not found.' });
        return;
      }

      const fiveMinutesFromNow = Date.now() + 5 * 60 * 1000;
      const cachedIsFresh =
        Boolean(row.gemini_file_uri) &&
        (!row.gemini_file_expires_at || new Date(row.gemini_file_expires_at).getTime() > fiveMinutesFromNow);
      if (!force && cachedIsFresh && row.gemini_file_uri) {
        res.json({
          fileUri: row.gemini_file_uri,
          mimeType: 'application/pdf',
          expirationTime: row.gemini_file_expires_at ?? undefined,
        });
        return;
      }

      const { data: blob, error: downloadError } = await supabase.storage
        .from('course-materials')
        .download(row.storage_path);
      if (downloadError || !blob) {
        throw new Error(`Could not read "${row.file_name}" from storage: ${downloadError?.message ?? 'empty file'}`);
      }

      const ai = await getAiClient(res);
      const pdfBlob = blob.type === 'application/pdf' ? blob : new Blob([await blob.arrayBuffer()], { type: 'application/pdf' });
      const uploaded = await uploadPdfToGemini(ai, pdfBlob, row.file_name);

      const { error: updateError } = await supabase
        .from('course_pdfs')
        .update({
          gemini_file_uri: uploaded.fileUri,
          gemini_file_expires_at: uploaded.expirationTime ?? null,
        })
        .eq('id', row.id);
      if (updateError) {
        console.warn(`Failed to cache Gemini URI for ${row.id}: ${updateError.message}`);
      }

      res.json(uploaded);
    } catch (err) {
      const formatted = formatApiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // 1A. Step 1 of Two-Step Chunked Ingestion: Extract compact Topic & Formula Syllabus from a small batch (up to 5 PDFs)
  app.post('/api/roadmap/extract-batch', async (req, res) => {
    try {
      const { courseName, courseCode, batchIndex, totalBatches, pdfs } = req.body as {
        courseName: string;
        courseCode?: string;
        batchIndex: number;
        totalBatches: number;
        pdfs: IncomingPdf[];
      };

      if (!courseName || !Array.isArray(pdfs) || pdfs.length === 0) {
        res.status(400).json({ error: 'Course name and at least one PDF are required for batch extraction.' });
        return;
      }

      const ai = await getAiClient(res);
      const pdfParts = buildPdfParts(pdfs);

      const promptPart: Part = {
        text: `You are processing batch ${batchIndex + 1} of ${totalBatches} for "${courseName}" (${courseCode || 'Engineering Course'}).
Attached PDFs in this batch: ${pdfs.map((p) => `${p.name} (${p.docCategory || 'lecture_notes'})`).join(', ')}.

Extract a concise, high-density Topic & Formula Syllabus (300–500 words) covering ONLY the material in this batch:
1. Detect the primary language of these PDFs (e.g., English, Italian, Turkish). Write ALL extracted text in that language.
2. List the core concepts, theorems, key equations (wrapped in KaTeX $...$), definitions, and exam problem archetypes found in these PDFs.
3. For any PDF in the past_exam or problem_set category, explicitly record its recurring question types, formats (e.g. multi-part, derive/compute/prove), typical difficulty, and the topics that carry the most points. Keep the key technical terms in English.
4. For each PDF file in this batch, output a "fileTopics" entry with exact fileName, 4–8 short topic keywords, and a 1–2 sentence summary.`,
      };

      const response: GenerateContentResponse = await withRetry(() =>
        ai.models.generateContent({
          model: FAST_MODEL_ID,
          contents: { parts: [...pdfParts, promptPart] },
          config: {
            systemInstruction:
              'You are a concise university engineering syllabus extractor. Output strict JSON only, keeping batchSummary dense and between 300 and 500 words.',
            thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                detectedLanguage: { type: Type.STRING },
                batchSummary: { type: Type.STRING },
                fileTopics: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      fileName: { type: Type.STRING },
                      keywords: { type: Type.ARRAY, items: { type: Type.STRING } },
                      summary: { type: Type.STRING },
                    },
                    required: ['fileName', 'keywords', 'summary'],
                  },
                },
              },
              required: ['detectedLanguage', 'batchSummary', 'fileTopics'],
            },
          },
        }),
      );

      const parsed = parseJsonSafe<{
        detectedLanguage: string;
        batchSummary: string;
        fileTopics: Array<{ fileName: string; keywords: string[]; summary: string }>;
      }>(response.text, 'Empty batch extraction response from Gemini.');

      res.json({
        detectedLanguage: parsed.detectedLanguage || 'English',
        batchSummary: parsed.batchSummary || '',
        fileTopics: parsed.fileTopics ?? [],
      });
    } catch (err) {
      const formatted = formatApiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // 1B. Step 2: Generate 10-Level Mastery Roadmap strictly from lightweight combined syllabus text (fast <5s)
  app.post('/api/roadmap/generate', async (req, res) => {
    try {
      const { courseName, courseCode, detectedLanguage, combinedSyllabus, fileManifest, pdfs } =
        req.body as {
          courseName: string;
          courseCode?: string;
          detectedLanguage?: string;
          combinedSyllabus?: string;
          fileManifest?: Array<{ name: string; docCategory: string; keywords?: string[]; summary?: string }>;
          pdfs?: IncomingPdf[];
        };

      if (!courseName) {
        res.status(400).json({ error: 'Course name is required.' });
        return;
      }

      const ai = await getAiClient(res);
      const useSyllabusOnly = Boolean(combinedSyllabus && combinedSyllabus.trim().length > 0);

      if (!useSyllabusOnly && (!Array.isArray(pdfs) || pdfs.length === 0)) {
        res.status(400).json({ error: 'Either combinedSyllabus or PDFs are required.' });
        return;
      }

      const pdfParts = useSyllabusOnly ? [] : buildPdfParts(pdfs);
      const manifestText = Array.isArray(fileManifest) && fileManifest.length > 0
        ? `\nAttached File Index:\n${fileManifest
            .map(
              (f) =>
                `- "${f.name}" [${f.docCategory}]: ${f.summary || ''} (keywords: ${(f.keywords || []).join(', ')})`,
            )
            .join('\n')}`
        : '';

      const promptPart: Part = {
        text: `Build a sequential 10-Level Mastery Skill Tree for "${courseName}" (${courseCode || 'Engineering Course'}).
${detectedLanguage ? `Source Material Language: ${detectedLanguage}` : 'Detect the primary language of the source material and report it in "detectedLanguage".'}

${LANGUAGE_POLICY}

${useSyllabusOnly ? `Extracted Multi-Batch Topic & Formula Syllabus:\n"""\n${combinedSyllabus}\n"""` : 'Analyze the attached PDFs.'}
${manifestText}

Task:
1. Produce "courseDigest": a crisp master syllabus reference (theorems, key formulas) that ends with a section listing the 6–10 exam question archetypes a professor of this course would most likely put on the midterm/final (based on past exams if present, otherwise on the standard archetypes for these topics).
2. Break the syllabus into strictly 10 progressive levels numbered 1 through 10, prioritizing the high-yield topics that are most likely to be examined:
   - Levels 1–2 (tier: "foundation"): Foundational definitions, physical/mathematical intuition, and basic conceptual checks.
   - Levels 3–5 (tier: "application"): Standard single-step formula applications and basic problem-solving.
   - Levels 6–8 (tier: "exam"): Exam-level multi-step engineering problems modeled after past exams.
   - Levels 9–10 (tier: "distinction"): Top-tier synthesis, coupled systems, proofs, and edge-case problems.

Rules:
- Wrap all inline math in $...$ and display equations in $$...$$ (valid KaTeX LaTeX).
- Each level must include 2–3 concise "objectives", 2–3 "keyFormulas" in KaTeX, a concise "sourceExcerpt", and "relevantPdfNames" containing ONLY the 1 or 2 most relevant exact filenames from the File Index for that specific level (never more than 2).`,
      };

      const response: GenerateContentResponse = await withRetry(() =>
        ai.models.generateContent({
          model: FAST_MODEL_ID,
          contents: { parts: [...pdfParts, promptPart] },
          config: {
            systemInstruction:
              'You are an elite university engineering professor and curriculum architect who knows exactly what gets asked on exams. Produce strictly valid JSON matching the schema with 10 sequential levels. Follow the language policy in the prompt: explanatory fields in Turkish with key technical terms kept in English.',
            thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                detectedLanguage: { type: Type.STRING },
                courseDigest: { type: Type.STRING },
                levels: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      levelNumber: { type: Type.INTEGER },
                      title: { type: Type.STRING },
                      tier: { type: Type.STRING },
                      summary: { type: Type.STRING },
                      objectives: { type: Type.ARRAY, items: { type: Type.STRING } },
                      keyFormulas: { type: Type.ARRAY, items: { type: Type.STRING } },
                      sourceExcerpt: { type: Type.STRING },
                      relevantPdfNames: { type: Type.ARRAY, items: { type: Type.STRING } },
                    },
                    required: [
                      'levelNumber',
                      'title',
                      'tier',
                      'summary',
                      'objectives',
                      'keyFormulas',
                      'sourceExcerpt',
                      'relevantPdfNames',
                    ],
                  },
                },
              },
              required: ['detectedLanguage', 'courseDigest', 'levels'],
            },
          },
        }),
      );

      const parsed = parseJsonSafe<{
        detectedLanguage: string;
        courseDigest: string;
        levels: Array<{
          levelNumber: number;
          title: string;
          tier: string;
          summary: string;
          objectives: string[];
          keyFormulas: string[];
          sourceExcerpt: string;
          relevantPdfNames?: string[];
          sourcePdfNames?: string[];
        }>;
      }>(response.text, 'Empty roadmap response from Gemini.');

      const normalizedLevels = [...parsed.levels]
        .sort((a, b) => a.levelNumber - b.levelNumber)
        .slice(0, 10)
        .map((lvl, idx) => {
          const num = idx + 1;
          const tier =
            num <= 2
              ? 'foundation'
              : num <= 5
                ? 'application'
                : num <= 8
                  ? 'exam'
                  : 'distinction';
          const matchedPdfs = (lvl.relevantPdfNames ?? lvl.sourcePdfNames ?? []).slice(0, 2);
          return {
            levelNumber: num,
            title: lvl.title,
            tier,
            summary: lvl.summary,
            objectives: lvl.objectives ?? [],
            keyFormulas: lvl.keyFormulas ?? [],
            sourceExcerpt: lvl.sourceExcerpt ?? '',
            relevantPdfNames: matchedPdfs,
            sourcePdfNames: matchedPdfs,
            unlocked: num === 1,
            mastered: false,
            bestScore: null,
            attempts: 0,
            reflexPassed: 0,
            feynmanBestClarity: null,
          };
        });

      res.json({
        detectedLanguage: parsed.detectedLanguage || detectedLanguage || 'English',
        courseDigest: parsed.courseDigest || combinedSyllabus || '',
        levels: normalizedLevels,
      });
    } catch (err) {
      const formatted = formatApiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // 1C. Step 1 (Learn First): Generate Mini-Lesson & Worked Example for a specific level (max 2 matched PDFs)
  app.post('/api/lesson/generate', async (req, res) => {
    try {
      const { courseName, detectedLanguage, courseDigest, level, pdfs } = req.body as {
        courseName: string;
        detectedLanguage: string;
        courseDigest: string;
        level: {
          levelNumber: number;
          title: string;
          tier: string;
          summary: string;
          objectives: string[];
          keyFormulas: string[];
          sourceExcerpt: string;
        };
        pdfs?: IncomingPdf[];
      };

      const ai = await getAiClient(res);
      const pdfParts = buildPdfParts(pdfs, 2);
      const compactDigest = (courseDigest || '').slice(0, 2200);

      const promptPart: Part = {
        text: `Course: ${courseName}
Source Material Language: ${detectedLanguage || 'English'}
Compact Syllabus Context: ${compactDigest}

Target Micro-Level: Level ${level.levelNumber} — "${level.title}" (Tier: ${level.tier})
Level Summary: ${level.summary}
Objectives: ${level.objectives.join('; ')}
Key Formulas: ${level.keyFormulas.join('; ')}
Source Grounding: ${level.sourceExcerpt}

Create a crisp, intuition-first Mini-Lesson (Konu Anlatımı) covering ONLY the concepts needed for Level ${level.levelNumber}, grounded strictly in the 1–2 attached PDFs and syllabus above:
1. "title": Clear lesson title.
2. "intuition": 2–3 sentences building physical/mathematical intuition ("why this works" before memorizing formulas).
3. "sections": 2 to 4 focused concept sections, each with a clear "heading", 2–4 concise "bullets", and an optional "keyEquation" in KaTeX display/inline form.
4. "workedExample": ONE complete step-by-step solved example of the kind most likely to appear on this course's exam for this level ("problemStatement", numbered "steps" array showing clear reasoning + KaTeX equations, "finalAnswer", and "takeaway"). If a past exam is attached, model it on that exam's style.
5. "commonPitfalls": 2–3 common exam traps or sign/assumption mistakes to avoid.

${LANGUAGE_POLICY}
- In this lesson: "problemStatement" is an exam question, so write it in English. "title", "intuition", "sections", "steps", "finalAnswer", "takeaway", and "commonPitfalls" are explanations: write them in Turkish with the key technical terms in English.

Rules:
- Wrap all math symbols, equations, integrals, matrices, and Greek letters in valid KaTeX LaTeX ($...$ inline, $$...$$ display).`,
      };

      const response: GenerateContentResponse = await withRetry(() =>
        ai.models.generateContent({
          model: FAST_MODEL_ID,
          contents: { parts: [...pdfParts, promptPart] },
          config: {
            systemInstruction:
              'You are an inspiring university engineering professor teaching a focused mini-lesson that prepares students for your own exam. Be concise, crystal clear, intuition-first, and mathematically rigorous. Explain in Turkish, keep key technical terms in English, and write exam problem statements in English. Output strict JSON.',
            thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING },
                intuition: { type: Type.STRING },
                sections: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      heading: { type: Type.STRING },
                      bullets: { type: Type.ARRAY, items: { type: Type.STRING } },
                      keyEquation: { type: Type.STRING },
                    },
                    required: ['heading', 'bullets'],
                  },
                },
                workedExample: {
                  type: Type.OBJECT,
                  properties: {
                    problemStatement: { type: Type.STRING },
                    steps: { type: Type.ARRAY, items: { type: Type.STRING } },
                    finalAnswer: { type: Type.STRING },
                    takeaway: { type: Type.STRING },
                  },
                  required: ['problemStatement', 'steps', 'finalAnswer', 'takeaway'],
                },
                commonPitfalls: { type: Type.ARRAY, items: { type: Type.STRING } },
              },
              required: ['title', 'intuition', 'sections', 'workedExample', 'commonPitfalls'],
            },
          },
        }),
      );

      const parsed = parseJsonSafe<{
        title: string;
        intuition: string;
        sections: Array<{ heading: string; bullets: string[]; keyEquation?: string }>;
        workedExample: {
          problemStatement: string;
          steps: string[];
          finalAnswer: string;
          takeaway: string;
        };
        commonPitfalls: string[];
      }>(response.text, 'Failed to generate mini-lesson.');

      res.json({
        ...parsed,
        generatedAt: new Date().toISOString(),
      });
    } catch (err) {
      const formatted = formatApiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // 1D. Step 1 Doubt Assistant: Answer a quick student question about the active mini-lesson
  app.post('/api/lesson/doubt', async (req, res) => {
    try {
      const { courseName, detectedLanguage, level, lessonSummary, doubtQuestion, history, pdfs } =
        req.body as {
          courseName: string;
          detectedLanguage: string;
          level: { levelNumber: number; title: string; keyFormulas: string[] };
          lessonSummary: string;
          doubtQuestion: string;
          history?: Array<{ role: 'user' | 'ai'; content: string }>;
          pdfs?: IncomingPdf[];
        };

      if (!doubtQuestion || !doubtQuestion.trim()) {
        res.status(400).json({ error: 'Please enter a question about the lesson.' });
        return;
      }

      const ai = await getAiClient(res);
      const pdfParts = buildPdfParts(pdfs, 2);

      const recentHistory = (history ?? [])
        .slice(-4)
        .map((m) => `${m.role === 'user' ? 'Student' : 'Professor'}: ${m.content}`)
        .join('\n');

      const promptPart: Part = {
        text: `Course: ${courseName} (Source Material Language: ${detectedLanguage || 'English'})
Level ${level.levelNumber}: ${level.title}
Key Formulas: ${level.keyFormulas.join('; ')}
Lesson Context: ${lessonSummary.slice(0, 2200)}
${recentHistory ? `\nRecent Doubt Q&A:\n${recentHistory}\n` : ''}
Student's Quick Doubt: "${doubtQuestion.trim()}"

Give a clear, direct, intuition-first answer (3–6 sentences or concise bullet steps) using KaTeX ($...$ / $$...$$). If relevant, say briefly how this point typically shows up on exams.

${LANGUAGE_POLICY}`,
      };

      const response: GenerateContentResponse = await withRetry(() =>
        ai.models.generateContent({
          model: FAST_MODEL_ID,
          contents: { parts: [...pdfParts, promptPart] },
          config: {
            systemInstruction:
              'You are a patient engineering professor answering a quick student doubt during a mini-lesson. Be crisp, concrete, and use KaTeX math. Answer in Turkish, keeping key technical terms in English.',
            thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                answer: { type: Type.STRING },
              },
              required: ['answer'],
            },
          },
        }),
      );

      const parsed = parseJsonSafe<{ answer: string }>(
        response.text,
        'Failed to answer lesson doubt.',
      );
      res.json({ answer: parsed.answer });
    } catch (err) {
      const formatted = formatApiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // 2. Mode A: Generate 5 Level Climb Questions
  app.post('/api/climb/generate', async (req, res) => {
    try {
      const { courseName, detectedLanguage, courseDigest, level, pdfs } = req.body as {
        courseName: string;
        detectedLanguage: string;
        courseDigest: string;
        level: {
          levelNumber: number;
          title: string;
          tier: string;
          summary: string;
          objectives: string[];
          keyFormulas: string[];
          sourceExcerpt: string;
        };
        pdfs?: IncomingPdf[];
      };

      const ai = await getAiClient(res);
      // 2 level PDFs + up to 1 past exam / problem set added by the client
      const pdfParts = buildPdfParts(pdfs, 3);
      const compactDigest = (courseDigest || '').slice(0, 3000);

      const promptPart: Part = {
        text: `Course: ${courseName}
Source Material Language: ${detectedLanguage || 'English'}
Course Syllabus Summary (incl. likely exam archetypes): ${compactDigest}

Target Level: Level ${level.levelNumber} — "${level.title}" (Tier: ${level.tier})
Level Summary: ${level.summary}
Objectives: ${level.objectives.join('; ')}
Key Formulas: ${level.keyFormulas.join('; ')}
Source Grounding: ${level.sourceExcerpt}

${describeExamReferences(pdfs)}

${EXAM_PROFESSOR_GUIDE}

Task: Write exactly 5 exam questions for this level, the way they would appear on your midterm/final. Every question must directly test the objectives and key formulas of THIS level.
Difficulty calibration by tier:
- foundation (1-2): 2 short "explain why / which and why" conceptual exam questions + 3 short computational exam questions on the core definitions and formulas.
- application (3-5): 1 conceptual exam question + 4 standard exam problems that apply the level's key formulas to concrete given data.
- exam (6-8): 5 full exam-length multi-step problems (multi-part (a)(b)(c) where natural) of the type that carries the most points on a real exam.
- distinction (9-10): 5 hardest-question-on-the-exam problems: derivations, coupled/combined topics, proofs, or edge cases that separate an A from a B.

For each question:
- "examRationale": one short line (Turkish, technical terms in English) on why a professor would ask this on the exam / which exam archetype it is.
- "prompt": the full exam question text, in English.
- "hint": a short nudge toward the method without giving the answer, in Turkish with the technical terms in English.
- "targetConcepts": 1–3 concept names, in English.
- "kind": "conceptual" or "problem".

${LANGUAGE_POLICY}

Formatting rules:
- Render all mathematical notation, equations, integrals, matrices, and Greek letters in valid KaTeX LaTeX wrapped in $...$ (inline) or $$...$$ (display).
- Each question requires an open-ended written solution from the student (no multiple choice).`,
      };

      const response: GenerateContentResponse = await withRetry(() =>
        ai.models.generateContent({
          model: MODEL_ID,
          contents: { parts: [...pdfParts, promptPart] },
          config: {
            systemInstruction: `${EXAM_PROFESSOR_GUIDE}\n\nQuestion text must be in English; hints and rationales in Turkish with technical terms in English. Output strict JSON.`,
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                questions: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      id: { type: Type.STRING },
                      index: { type: Type.INTEGER },
                      examRationale: { type: Type.STRING },
                      kind: { type: Type.STRING, description: 'conceptual or problem' },
                      prompt: { type: Type.STRING },
                      hint: { type: Type.STRING },
                      targetConcepts: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                      },
                    },
                    required: ['id', 'index', 'examRationale', 'kind', 'prompt', 'hint', 'targetConcepts'],
                  },
                },
              },
              required: ['questions'],
            },
          },
        }),
      );

      const parsed = parseJsonSafe<{
        questions: Array<{
          id: string;
          index: number;
          kind: string;
          prompt: string;
          hint: string;
          targetConcepts: string[];
        }>;
      }>(response.text, 'Failed to generate Level Climb questions.');

      const questions = parsed.questions.slice(0, 5).map((q, i) => ({
        id: q.id || `q-${i + 1}`,
        index: i + 1,
        kind: q.kind === 'conceptual' ? 'conceptual' : 'problem',
        prompt: q.prompt,
        hint: q.hint,
        targetConcepts: q.targetConcepts ?? [],
      }));

      res.json({ questions });
    } catch (err) {
      const formatted = formatApiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // 3. Mode A: Grade a Level Climb Solution
  app.post('/api/climb/grade', async (req, res) => {
    try {
      const {
        courseName,
        detectedLanguage,
        courseDigest,
        level,
        question,
        userAnswer,
        userElo,
        pdfs,
      } = req.body as {
        courseName: string;
        detectedLanguage: string;
        courseDigest: string;
        level: { levelNumber: number; title: string; tier: string; sourceExcerpt: string };
        question: { prompt: string; kind: string; targetConcepts: string[] };
        userAnswer: string;
        userElo: number;
        pdfs?: IncomingPdf[];
      };

      const ai = await getAiClient(res);
      const pdfParts = buildPdfParts(pdfs, 2);

      const promptPart: Part = {
        text: `Course: ${courseName} (Source Material Language: ${detectedLanguage || 'English'})
Context: ${(courseDigest || '').slice(0, 1800)}
Level ${level.levelNumber}: ${level.title} (${level.tier})
Grounding: ${level.sourceExcerpt}

Question (${question.kind}):
${question.prompt}

Target Concepts: ${question.targetConcepts.join(', ')}

Student's Written Solution:
"""
${userAnswer}
"""

Grade this solution carefully:
1. Score from 0 to 100 the way you would grade it on a real exam (partial credit for a correct method), based on correctness, valid method, boundary conditions, and units/notation.
2. In "stepFeedback", explicitly identify which step is right or WHY a specific step in the student's work is wrong (or missing).
3. In "workedSolution", provide the clean canonical step-by-step derivation using KaTeX LaTeX ($...$ and $$...$$), as it would appear in the official exam solution key.

${LANGUAGE_POLICY}
- "verdict", "stepFeedback", and the explanations in "workedSolution" are explanations: write them in Turkish with the key technical terms in English. The student may answer in any language.`,
      };

      const response: GenerateContentResponse = await withRetry(() =>
        ai.models.generateContent({
          model: MODEL_ID,
          contents: { parts: [...pdfParts, promptPart] },
          config: {
            systemInstruction:
              'You are the professor grading your own engineering exam. Be fair, precise, and diagnostic. Explain exactly why any erroneous step fails mathematically or physically. Write feedback in Turkish, keeping key technical terms in English. Wrap all math in $...$ or $$...$$.',
            thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                score: { type: Type.INTEGER },
                verdict: { type: Type.STRING },
                stepFeedback: { type: Type.STRING },
                workedSolution: { type: Type.STRING },
              },
              required: ['score', 'verdict', 'stepFeedback', 'workedSolution'],
            },
          },
        }),
      );

      const parsed = parseJsonSafe<{
        score: number;
        verdict: string;
        stepFeedback: string;
        workedSolution: string;
      }>(response.text, 'Failed to grade solution.');

      const clampedScore = Math.max(0, Math.min(100, Math.round(parsed.score)));
      const eloDelta = computeEloDelta(userElo || 1200, level.levelNumber, clampedScore, 12);

      res.json({
        score: clampedScore,
        isCorrect: clampedScore >= 70,
        verdict: parsed.verdict,
        stepFeedback: parsed.stepFeedback,
        workedSolution: parsed.workedSolution,
        eloDelta,
      });
    } catch (err) {
      const formatted = formatApiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // 4. Mode B: Generate "First 2 Lines" Anti-Freeze Reflex Problem
  app.post('/api/reflex/generate', async (req, res) => {
    try {
      const { courseName, detectedLanguage, courseDigest, level, pdfs } = req.body as {
        courseName: string;
        detectedLanguage: string;
        courseDigest: string;
        level: {
          levelNumber: number;
          title: string;
          tier: string;
          summary: string;
          keyFormulas: string[];
          sourceExcerpt: string;
        };
        pdfs?: IncomingPdf[];
      };

      const ai = await getAiClient(res);
      // 2 level PDFs + up to 1 past exam / problem set added by the client
      const pdfParts = buildPdfParts(pdfs, 3);

      const promptPart: Part = {
        text: `Course: ${courseName} (Source Material Language: ${detectedLanguage || 'English'})
Course Digest (incl. likely exam archetypes): ${(courseDigest || '').slice(0, 2400)}
Level ${level.levelNumber}: ${level.title} (${level.tier})
Key Formulas: ${level.keyFormulas.join('; ')}
Source Grounding: ${level.sourceExcerpt}

${describeExamReferences(pdfs)}

${EXAM_PROFESSOR_GUIDE}

Task: Write ONE realistic exam problem for this level, exactly as it would appear on your midterm/final, using this level's key formulas.
The problem should be rich enough that an anxious student might freeze at the start, requiring them to identify:
- Line 1: Which governing theorem, law, or formula applies.
- Line 2: The knowns/unknowns and initial setup equation.

Language:
- "problemText": the exam problem, entirely in English.
- "sourceContext" and "expectedFocus": in Turkish, keeping the key technical terms in English.
Use KaTeX $...$ and $$...$$ for all math.`,
      };

      const response: GenerateContentResponse = await withRetry(() =>
        ai.models.generateContent({
          model: MODEL_ID,
          contents: { parts: [...pdfParts, promptPart] },
          config: {
            systemInstruction:
              'You are the professor who writes this course\'s exams, training students to overcome exam freeze by spotting the exact starting equation within 45 seconds. Problems must be realistic, high-yield exam problems written in English.',
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                problemText: { type: Type.STRING },
                sourceContext: { type: Type.STRING },
                expectedFocus: { type: Type.STRING },
              },
              required: ['problemText', 'sourceContext', 'expectedFocus'],
            },
          },
        }),
      );

      const parsed = parseJsonSafe<{
        problemText: string;
        sourceContext: string;
        expectedFocus: string;
      }>(response.text, 'Failed to generate reflex problem.');

      res.json(parsed);
    } catch (err) {
      const formatted = formatApiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // 5. Mode B: Evaluate "First 2 Lines" Setup
  app.post('/api/reflex/evaluate', async (req, res) => {
    try {
      const {
        courseName,
        detectedLanguage,
        level,
        problemText,
        lineOneTheorem,
        lineTwoSetup,
        elapsedSeconds,
        userElo,
        pdfs,
      } = req.body as {
        courseName: string;
        detectedLanguage: string;
        level: { levelNumber: number; title: string; sourceExcerpt: string };
        problemText: string;
        lineOneTheorem: string;
        lineTwoSetup: string;
        elapsedSeconds: number;
        userElo: number;
        pdfs?: IncomingPdf[];
      };

      const ai = await getAiClient(res);
      const pdfParts = buildPdfParts(pdfs, 2);

      const promptPart: Part = {
        text: `Course: ${courseName} (Source Material Language: ${detectedLanguage || 'English'})
Level ${level.levelNumber}: ${level.title}

Exam Problem:
${problemText}

Student's 45-Second "First 2 Lines" Response (submitted in ${elapsedSeconds}s):
- Line 1 (Theorem / Governing Principle): ${lineOneTheorem || '(empty)'}
- Line 2 (Knowns, Unknowns & Initial Setup Equation): ${lineTwoSetup || '(empty)'}

Evaluate strictly:
1. Would this starting direction lead to a valid, complete solution?
2. verdict: "valid" (score >= 75), "partial" (score 40-74), or "invalid" (score < 40).
3. trajectoryAssessment: Clear explanation of why this trajectory works or stalls.
4. missingOrWrong: Specific assumptions, signs, boundary conditions, or variables missed (or affirm completeness if valid).
5. optimalFirstTwoLines: Show the ideal crisp Line 1 + Line 2 setup in KaTeX ($...$ and $$...$$).

${LANGUAGE_POLICY}
- "trajectoryAssessment", "missingOrWrong", and "optimalFirstTwoLines" are explanations: write them in Turkish with the key technical terms in English. The student may answer in any language.`,
      };

      const response: GenerateContentResponse = await withRetry(() =>
        ai.models.generateContent({
          model: MODEL_ID,
          contents: { parts: [...pdfParts, promptPart] },
          config: {
            systemInstruction:
              'You are an engineering exam reflex evaluator. Focus exclusively on whether the student chose the right starting theorem and initial equation setup.',
            thinkingConfig: { thinkingLevel: ThinkingLevel.MEDIUM },
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                verdict: { type: Type.STRING, description: 'valid, partial, or invalid' },
                score: { type: Type.INTEGER },
                trajectoryAssessment: { type: Type.STRING },
                missingOrWrong: { type: Type.STRING },
                optimalFirstTwoLines: { type: Type.STRING },
              },
              required: [
                'verdict',
                'score',
                'trajectoryAssessment',
                'missingOrWrong',
                'optimalFirstTwoLines',
              ],
            },
          },
        }),
      );

      const parsed = parseJsonSafe<{
        verdict: string;
        score: number;
        trajectoryAssessment: string;
        missingOrWrong: string;
        optimalFirstTwoLines: string;
      }>(response.text, 'Failed to evaluate reflex setup.');

      const score = Math.max(0, Math.min(100, Math.round(parsed.score)));
      const verdict =
        parsed.verdict === 'valid' || parsed.verdict === 'partial' || parsed.verdict === 'invalid'
          ? parsed.verdict
          : score >= 75
            ? 'valid'
            : score >= 40
              ? 'partial'
              : 'invalid';

      const eloDelta = computeEloDelta(userElo || 1200, level.levelNumber, score, 16);

      res.json({
        verdict,
        score,
        trajectoryAssessment: parsed.trajectoryAssessment,
        missingOrWrong: parsed.missingOrWrong,
        optimalFirstTwoLines: parsed.optimalFirstTwoLines,
        eloDelta,
      });
    } catch (err) {
      const formatted = formatApiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // 6. Mode C: Feynman "Teach the AI" Role-Reversal Turn
  app.post('/api/feynman/turn', async (req, res) => {
    try {
      const {
        courseName,
        detectedLanguage,
        courseDigest,
        level,
        history,
        forceEvaluate,
        userElo,
        pdfs,
      } = req.body as {
        courseName: string;
        detectedLanguage: string;
        courseDigest: string;
        level: {
          levelNumber: number;
          title: string;
          summary: string;
          keyFormulas: string[];
          sourceExcerpt: string;
        };
        history: Array<{ role: 'ai' | 'user'; content: string }>;
        forceEvaluate?: boolean;
        userElo: number;
        pdfs?: IncomingPdf[];
      };

      const ai = await getAiClient(res);
      const pdfParts = buildPdfParts(pdfs, 2);

      const userTurns = history.filter((m) => m.role === 'user').length;
      const transcript =
        history.length === 0
          ? '(Session starting — you have not spoken yet.)'
          : history
              .map((m) => `${m.role === 'ai' ? 'Classmate (You)' : 'Student (Teacher)'}: ${m.content}`)
              .join('\n\n');

      const promptPart: Part = {
        text: `Course: ${courseName} (Source Material Language: ${detectedLanguage || 'English'})
Course Digest: ${(courseDigest || '').slice(0, 1800)}
Current Level: Level ${level.levelNumber} — "${level.title}"
Summary: ${level.summary}
Key Formulas: ${level.keyFormulas.join('; ')}
Source Grounding: ${level.sourceExcerpt}

Conversation so far:
${transcript}

Instructions:
- Roleplay as a sharp but genuinely confused engineering classmate trying to understand a core concept from Level ${level.levelNumber}.
- If the conversation has not started yet (0 messages), pick ONE pivotal, exam-relevant concept from Level ${level.levelNumber} (one the professor is likely to test) and ask the user to explain it in plain terms (e.g., "Hocam bu bölümde ... neden çalışıyor hiç anlamadım, baştan anlatır mısın?").
- If the student has just explained something, DO NOT give away the textbook answer! Instead, probe for logical gaps, hand-waving ("wait, why does that term cancel out?" or "what if the boundary condition changes?"), and ask one focused follow-up question — the kind of follow-up an exam question would test.
- Language rule: Speak in Turkish, keeping key technical terms in English (e.g. "boundary condition", "eigenvalue", "transfer function"). "turnAssessment", "strengths", and "gaps" follow the same rule.
- Use KaTeX $...$ for any math expressions.
- Scoring trigger: ${
          forceEvaluate
            ? 'The student requested their final Concept Clarity evaluation NOW. Set readyToScore=true, provide a thoughtful closing reply acknowledging their teaching, and compute clarityScore (0-100), strengths, and gaps.'
            : userTurns >= 3
              ? 'If the student has thoroughly resolved the core intuition and edge cases (or after 4+ turns), you MAY set readyToScore=true and provide clarityScore (0-100), strengths, and gaps. Otherwise keep probing with readyToScore=false.'
              : 'Keep probing with readyToScore=false (do not award final score before 3 user explanations unless forceEvaluate is true).'
        }`,
      };

      const response: GenerateContentResponse = await withRetry(() =>
        ai.models.generateContent({
          model: MODEL_ID,
          contents: { parts: [...pdfParts, promptPart] },
          config: {
            systemInstruction:
              'You are a confused engineering classmate in a Feynman Teach-Back session. Be curious, concise, and mathematically sharp. Spot hand-waving immediately. Speak Turkish, keeping key technical terms in English.',
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                reply: { type: Type.STRING },
                turnAssessment: { type: Type.STRING },
                readyToScore: { type: Type.BOOLEAN },
                clarityScore: { type: Type.INTEGER },
                strengths: { type: Type.ARRAY, items: { type: Type.STRING } },
                gaps: { type: Type.ARRAY, items: { type: Type.STRING } },
              },
              required: ['reply', 'turnAssessment', 'readyToScore'],
            },
          },
        }),
      );

      const parsed = parseJsonSafe<{
        reply: string;
        turnAssessment: string;
        readyToScore: boolean;
        clarityScore?: number;
        strengths?: string[];
        gaps?: string[];
      }>(response.text, 'Failed to continue Feynman dialogue.');

      const ready = Boolean(forceEvaluate || parsed.readyToScore);
      const clarityScore =
        ready && typeof parsed.clarityScore === 'number'
          ? Math.max(0, Math.min(100, Math.round(parsed.clarityScore)))
          : ready
            ? 72
            : undefined;
      const eloDelta =
        ready && clarityScore !== undefined
          ? computeEloDelta(userElo || 1200, level.levelNumber, clarityScore, 20)
          : undefined;

      res.json({
        reply: parsed.reply,
        turnAssessment: parsed.turnAssessment,
        readyToScore: ready,
        clarityScore,
        strengths: parsed.strengths ?? [],
        gaps: parsed.gaps ?? [],
        eloDelta,
      });
    } catch (err) {
      const formatted = formatApiError(err);
      res.status(formatted.status).json({ error: formatted.message });
    }
  });

  // Catch unmatched /api/* and Express body/parser errors as JSON (never HTML)
  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API route not found.' });
  });

  app.use(
    (
      err: { status?: number; statusCode?: number; message?: string; type?: string },
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (req.path.startsWith('/api')) {
        const status = err.status || err.statusCode || (err.type === 'entity.too.large' ? 413 : 500);
        res.status(status).json({
          error:
            err.type === 'entity.too.large'
              ? 'Request payload too large. Upload PDFs individually.'
              : err.message || 'Server error.',
        });
        return;
      }
      next(err);
    },
  );

  return app;
}

async function startServer() {
  const app = createApp();
  const httpServer = http.createServer(app);

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        ws: { server: httpServer },
        watch: null,
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`Axiom server running on http://localhost:${PORT}`);
  });
}

// Only listen when run directly (tsx server.ts / node server.ts), never when
// imported by the Vercel function in api/index.ts.
const isDirectRun = Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  startServer();
}
