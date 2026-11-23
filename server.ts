import 'dotenv/config';
import express from 'express';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type, ThinkingLevel } from '@google/genai';
import type { Part, GenerateContentResponse } from '@google/genai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT) || 3000;
const MODEL_ID = 'gemini-4-hydrogen';
const FAST_MODEL_ID = 'gemini-3.1-flash-lite';

function createAiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not configured on the server.');
  }
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

  if (raw.includes('GEMINI_API_KEY is not configured')) {
    return {
      status: 500,
      message: 'Gemini API key is missing. Please configure GEMINI_API_KEY in Settings > Secrets.',
    };
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

function computeEloDelta(userElo: number, levelNumber: number, score: number, weight = 24): number {
  const levelRating = 950 + levelNumber * 80;
  const expected = 1 / (1 + Math.pow(10, (levelRating - userElo) / 400));
  const actual = Math.max(0, Math.min(1, score / 100));
  return Math.round(weight * (actual - expected));
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, hasKey: Boolean(process.env.GEMINI_API_KEY) });
  });

  // 0. Upload individual PDF binary to Gemini Files API
  app.post(
    '/api/files/upload',
    express.raw({ type: 'application/pdf', limit: '30mb' }),
    async (req, res) => {
      try {
        const buffer = req.body as Buffer;
        if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
          res.status(400).json({ error: 'Empty PDF binary body.' });
          return;
        }
        const filename =
          typeof req.query.filename === 'string' && req.query.filename.trim()
            ? req.query.filename.trim()
            : 'course-material.pdf';

        const ai = createAiClient();
        const blob = new Blob([new Uint8Array(buffer)], { type: 'application/pdf' });

        let uploaded = await withRetry(() =>
          ai.files.upload({
            file: blob,
            config: {
              mimeType: 'application/pdf',
              displayName: filename,
            },
          }),
        );

        let attempts = 0;
        while (uploaded.state === 'PROCESSING' && uploaded.name && attempts < 15) {
          await new Promise((r) => setTimeout(r, 800));
          uploaded = await ai.files.get({ name: uploaded.name });
          attempts++;
        }

        if (uploaded.state === 'FAILED') {
          throw new Error(`Gemini failed to process PDF "${filename}".`);
        }

        res.json({
          fileUri: uploaded.uri,
          fileName: uploaded.name,
          mimeType: uploaded.mimeType || 'application/pdf',
          expirationTime: uploaded.expirationTime,
        });
      } catch (err) {
        const formatted = formatApiError(err);
        res.status(formatted.status).json({ error: formatted.message });
      }
    },
  );

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

      const ai = createAiClient();
      const pdfParts = buildPdfParts(pdfs);

      const promptPart: Part = {
        text: `You are processing batch ${batchIndex + 1} of ${totalBatches} for "${courseName}" (${courseCode || 'Engineering Course'}).
Attached PDFs in this batch: ${pdfs.map((p) => `${p.name} (${p.docCategory || 'lecture_notes'})`).join(', ')}.

Extract a concise, high-density Topic & Formula Syllabus (300–500 words) covering ONLY the material in this batch:
1. Detect the primary language of these PDFs (e.g., English, Italian, Turkish). Write ALL extracted text in that language.
2. List the core concepts, theorems, key equations (wrapped in KaTeX $...$), definitions, and exam problem archetypes found in these PDFs.
3. For each PDF file in this batch, output a "fileTopics" entry with exact fileName, 4–8 short topic keywords, and a 1–2 sentence summary.`,
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

      const ai = createAiClient();
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
${detectedLanguage ? `Primary Language: ${detectedLanguage}` : 'Detect the primary language of the syllabus and write all fields in that language.'}

${useSyllabusOnly ? `Extracted Multi-Batch Topic & Formula Syllabus:\n"""\n${combinedSyllabus}\n"""` : 'Analyze the attached PDFs.'}
${manifestText}

Task:
1. Produce "courseDigest": a crisp master syllabus reference (theorems, key formulas, and exam archetypes).
2. Break the syllabus into strictly 10 progressive levels numbered 1 through 10:
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
              'You are an elite university engineering curriculum architect. Produce strictly valid JSON matching the schema with 10 sequential levels.',
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

      const ai = createAiClient();
      const pdfParts = buildPdfParts(pdfs, 2);
      const compactDigest = (courseDigest || '').slice(0, 2200);

      const promptPart: Part = {
        text: `Course: ${courseName}
Course Language: ${detectedLanguage || 'English'}
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
4. "workedExample": ONE complete, exam-relevant step-by-step solved example ("problemStatement", numbered "steps" array showing clear reasoning + KaTeX equations, "finalAnswer", and "takeaway").
5. "commonPitfalls": 2–3 common exam traps or sign/assumption mistakes to avoid.

Rules:
- Write ALL text in ${detectedLanguage || 'English'}.
- Wrap all math symbols, equations, integrals, matrices, and Greek letters in valid KaTeX LaTeX ($...$ inline, $$...$$ display).`,
      };

      const response: GenerateContentResponse = await withRetry(() =>
        ai.models.generateContent({
          model: FAST_MODEL_ID,
          contents: { parts: [...pdfParts, promptPart] },
          config: {
            systemInstruction:
              'You are an inspiring university engineering professor teaching a focused mini-lesson before a mastery quiz. Be concise, crystal clear, intuition-first, and mathematically rigorous. Output strict JSON.',
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

      const ai = createAiClient();
      const pdfParts = buildPdfParts(pdfs, 2);

      const recentHistory = (history ?? [])
        .slice(-4)
        .map((m) => `${m.role === 'user' ? 'Student' : 'Professor'}: ${m.content}`)
        .join('\n');

      const promptPart: Part = {
        text: `Course: ${courseName} (Language: ${detectedLanguage || 'English'})
Level ${level.levelNumber}: ${level.title}
Key Formulas: ${level.keyFormulas.join('; ')}
Lesson Context: ${lessonSummary.slice(0, 2200)}
${recentHistory ? `\nRecent Doubt Q&A:\n${recentHistory}\n` : ''}
Student's Quick Doubt: "${doubtQuestion.trim()}"

Give a clear, direct, intuition-first answer (3–6 sentences or concise bullet steps) using KaTeX ($...$ / $$...$$) in the same language as the student's question (or ${detectedLanguage || 'English'}).`,
      };

      const response: GenerateContentResponse = await withRetry(() =>
        ai.models.generateContent({
          model: FAST_MODEL_ID,
          contents: { parts: [...pdfParts, promptPart] },
          config: {
            systemInstruction:
              'You are a patient engineering professor answering a quick student doubt during a mini-lesson. Be crisp, concrete, and use KaTeX math.',
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

      const ai = createAiClient();
      const pdfParts = buildPdfParts(pdfs, 2);
      const compactDigest = (courseDigest || '').slice(0, 2200);

      const promptPart: Part = {
        text: `Course: ${courseName}
Course Language: ${detectedLanguage || 'English'}
Course Syllabus Summary: ${compactDigest}

Target Level: Level ${level.levelNumber} — "${level.title}" (Tier: ${level.tier})
Level Summary: ${level.summary}
Objectives: ${level.objectives.join('; ')}
Key Formulas: ${level.keyFormulas.join('; ')}
Source Grounding: ${level.sourceExcerpt}

Generate exactly 5 targeted active-recall questions for this specific level, strictly grounded in the 1–2 attached PDFs and course material above.
Difficulty calibration:
- foundation (1-2): 3 conceptual intuition checks + 2 simple foundational checks.
- application (3-5): 2 conceptual checks + 3 standard single-step engineering/math problems.
- exam (6-8): 1 conceptual synthesis + 4 exam-level multi-step engineering problems modeled after past exams.
- distinction (9-10): 5 rigorous distinction-level multi-step derivations, coupled systems, or edge-case problems.

Formatting rules:
- Write ALL text in ${detectedLanguage || 'English'}.
- Render all mathematical notation, equations, integrals, matrices, and Greek letters in valid KaTeX LaTeX wrapped in $...$ (inline) or $$...$$ (display).
- Each question requires an open-ended written solution from the student.`,
      };

      const response: GenerateContentResponse = await withRetry(() =>
        ai.models.generateContent({
          model: FAST_MODEL_ID,
          contents: { parts: [...pdfParts, promptPart] },
          config: {
            systemInstruction:
              'You are a strict, encouraging university engineering professor designing targeted level-mastery questions from the student’s own lecture materials. Respond in the detected course language.',
            thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
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
                      kind: { type: Type.STRING, description: 'conceptual or problem' },
                      prompt: { type: Type.STRING },
                      hint: { type: Type.STRING },
                      targetConcepts: {
                        type: Type.ARRAY,
                        items: { type: Type.STRING },
                      },
                    },
                    required: ['id', 'index', 'kind', 'prompt', 'hint', 'targetConcepts'],
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

      const ai = createAiClient();
      const pdfParts = buildPdfParts(pdfs, 2);

      const promptPart: Part = {
        text: `Course: ${courseName} (Language: ${detectedLanguage || 'English'})
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
1. Score from 0 to 100 based on correctness, valid method, boundary conditions, and units/notation.
2. In "stepFeedback", explicitly identify which step is right or WHY a specific step in the student's work is wrong (or missing). If the student responded in a specific language (e.g. Turkish, Italian, English), respond in that language (otherwise use ${detectedLanguage || 'English'}).
3. In "workedSolution", provide the clean canonical step-by-step derivation using KaTeX LaTeX ($...$ and $$...$$).`,
      };

      const response: GenerateContentResponse = await withRetry(() =>
        ai.models.generateContent({
          model: MODEL_ID,
          contents: { parts: [...pdfParts, promptPart] },
          config: {
            systemInstruction:
              'You are an engineering exam grader. Be fair, precise, and diagnostic. Explain exactly why any erroneous step fails mathematically or physically. Wrap all math in $...$ or $$...$$.',
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

      const ai = createAiClient();
      const pdfParts = buildPdfParts(pdfs, 2);

      const promptPart: Part = {
        text: `Course: ${courseName} (Language: ${detectedLanguage || 'English'})
Course Digest: ${(courseDigest || '').slice(0, 1800)}
Level ${level.levelNumber}: ${level.title} (${level.tier})
Key Formulas: ${level.keyFormulas.join('; ')}
Source Grounding: ${level.sourceExcerpt}

Generate ONE realistic, exam-style engineering problem modeled after the course PDFs and past exams.
The problem should be rich enough that an anxious student might freeze at the start, requiring them to identify:
- Line 1: Which governing theorem, law, or formula applies.
- Line 2: The knowns/unknowns and initial setup equation.

Write everything in ${detectedLanguage || 'English'}. Use KaTeX $...$ and $$...$$ for all math.`,
      };

      const response: GenerateContentResponse = await withRetry(() =>
        ai.models.generateContent({
          model: FAST_MODEL_ID,
          contents: { parts: [...pdfParts, promptPart] },
          config: {
            systemInstruction:
              'You are an engineering exam coach training students to overcome exam freeze by spotting the exact starting equation within 45 seconds.',
            thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
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

      const ai = createAiClient();
      const pdfParts = buildPdfParts(pdfs, 2);

      const promptPart: Part = {
        text: `Course: ${courseName} (Language: ${detectedLanguage || 'English'})
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

Respond in the language of the student's input or ${detectedLanguage || 'English'}.`,
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

      const ai = createAiClient();
      const pdfParts = buildPdfParts(pdfs, 2);

      const userTurns = history.filter((m) => m.role === 'user').length;
      const transcript =
        history.length === 0
          ? '(Session starting — you have not spoken yet.)'
          : history
              .map((m) => `${m.role === 'ai' ? 'Classmate (You)' : 'Student (Teacher)'}: ${m.content}`)
              .join('\n\n');

      const promptPart: Part = {
        text: `Course: ${courseName} (Primary Language: ${detectedLanguage || 'English'})
Course Digest: ${(courseDigest || '').slice(0, 1800)}
Current Level: Level ${level.levelNumber} — "${level.title}"
Summary: ${level.summary}
Key Formulas: ${level.keyFormulas.join('; ')}
Source Grounding: ${level.sourceExcerpt}

Conversation so far:
${transcript}

Instructions:
- Roleplay as a sharp but genuinely confused engineering classmate trying to understand a core concept from Level ${level.levelNumber}.
- If the conversation has not started yet (0 messages), pick ONE pivotal concept from Level ${level.levelNumber} and ask the user to explain it in plain terms (e.g., "Hey, I'm totally lost on why ... works in this chapter — can you walk me through it from scratch?").
- If the student has just explained something, DO NOT give away the textbook answer! Instead, probe for logical gaps, hand-waving ("wait, why does that term cancel out?" or "what if the boundary condition changes?"), and ask one focused follow-up question.
- Language rule: Respond in the same language the student uses, or ${detectedLanguage || 'English'} at the start.
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
              'You are a confused engineering classmate in a Feynman Teach-Back session. Be curious, concise, and mathematically sharp. Spot hand-waving immediately.',
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

startServer();
