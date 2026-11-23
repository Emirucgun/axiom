import type { Course, DocCategory, PdfAttachmentMeta, PdfPayload, SkillLevel } from '../types';
import { safeFetchJson } from './apiClient';

const DB_NAME = 'axiom_pdf_store_v1';
const STORE_NAME = 'pdfs';
const DB_VERSION = 1;

export const MAX_SINGLE_PDF_BYTES = 28 * 1024 * 1024; // 28 MB (safely under 32 MB proxy limit)

interface StoredPdfRecord {
  id: string;
  courseId: string;
  name: string;
  size: number;
  docCategory: DocCategory;
  uploadedAt: string;
  buffer?: ArrayBuffer;
  base64?: string;
  fileUri?: string;
  fileExpiresAt?: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('courseId', 'courseId', { unique: false });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Failed to open IndexedDB.'));
  });
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const clean = base64.includes(',') ? base64.split(',')[1] : base64;
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function uploadPdfBinaryToGemini(
  name: string,
  buffer: ArrayBuffer,
): Promise<{ fileUri: string; expirationTime?: string }> {
  const data = await safeFetchJson<{
    fileUri: string;
    mimeType: string;
    expirationTime?: string;
  }>(`/api/files/upload?filename=${encodeURIComponent(name)}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/pdf',
    },
    body: buffer,
    timeoutMs: 60000,
  });

  return {
    fileUri: data.fileUri,
    expirationTime: data.expirationTime,
  };
}

async function updatePdfFileUriInDb(
  id: string,
  fileUri: string,
  fileExpiresAt?: string,
): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.get(id);
    req.onsuccess = () => {
      const record = req.result as StoredPdfRecord | undefined;
      if (record) {
        record.fileUri = fileUri;
        record.fileExpiresAt = fileExpiresAt;
        store.put(record);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to cache Gemini file URI.'));
  });
}

export async function saveCoursePdf(
  courseId: string,
  file: File,
  docCategory: DocCategory,
): Promise<PdfAttachmentMeta> {
  if (file.size > MAX_SINGLE_PDF_BYTES) {
    throw new Error(
      `"${file.name}" is ${formatBytes(file.size)}, which exceeds the 28 MB per-file upload limit.`,
    );
  }

  const buffer = await file.arrayBuffer();
  const id = `pdf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const uploadedAt = new Date().toISOString();

  // Upload immediately as raw binary (avoids base64 +33% bloat and combined multi-PDF payloads)
  const uploaded = await uploadPdfBinaryToGemini(file.name, buffer);

  const record: StoredPdfRecord = {
    id,
    courseId,
    name: file.name,
    size: file.size,
    docCategory,
    uploadedAt,
    buffer,
    fileUri: uploaded.fileUri,
    fileExpiresAt: uploaded.expirationTime,
  };

  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to save PDF to IndexedDB.'));
  });

  return {
    id,
    name: file.name,
    size: file.size,
    uploadedAt,
    docCategory,
    fileUri: uploaded.fileUri,
    fileExpiresAt: uploaded.expirationTime,
  };
}

async function getCourseDbRecords(courseId: string): Promise<StoredPdfRecord[]> {
  const db = await openDb();
  return new Promise<StoredPdfRecord[]>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const index = tx.objectStore(STORE_NAME).index('courseId');
    const req = index.getAll(courseId);
    req.onsuccess = () => resolve((req.result as StoredPdfRecord[]) || []);
    req.onerror = () => reject(req.error ?? new Error('Failed to load PDFs from IndexedDB.'));
  });
}

async function ensureFreshPdfPayloads(records: StoredPdfRecord[]): Promise<PdfPayload[]> {
  const fiveMinutesFromNow = Date.now() + 5 * 60 * 1000;
  const results: PdfPayload[] = [];

  // Process up to 3 refreshes concurrently so re-uploading expired files stays fast
  const concurrency = 3;
  for (let i = 0; i < records.length; i += concurrency) {
    const slice = records.slice(i, i + concurrency);
    const slicePayloads = await Promise.all(
      slice.map(async (r): Promise<PdfPayload | null> => {
        const isUriFresh =
          Boolean(r.fileUri) &&
          (!r.fileExpiresAt || new Date(r.fileExpiresAt).getTime() > fiveMinutesFromNow);

        if (isUriFresh && r.fileUri) {
          return {
            name: r.name,
            docCategory: r.docCategory,
            fileUri: r.fileUri,
            mimeType: 'application/pdf',
          };
        }

        const buffer = r.buffer ?? (r.base64 ? base64ToArrayBuffer(r.base64) : undefined);
        if (!buffer) return null;

        const uploaded = await uploadPdfBinaryToGemini(r.name, buffer);
        await updatePdfFileUriInDb(r.id, uploaded.fileUri, uploaded.expirationTime);
        return {
          name: r.name,
          docCategory: r.docCategory,
          fileUri: uploaded.fileUri,
          mimeType: 'application/pdf',
        };
      }),
    );

    for (const item of slicePayloads) {
      if (item) results.push(item);
    }
  }

  return results;
}

export async function getCoursePdfsForApi(courseId: string): Promise<PdfPayload[]> {
  const records = await getCourseDbRecords(courseId);
  return ensureFreshPdfPayloads(records);
}

/**
 * Selects strictly the 1–2 most relevant PDFs for a given level so lesson &
 * study-mode generation stays well under TPM rate limits even with 25+ PDFs.
 */
export async function getTargetedCoursePdfsForLevel(
  course: Course,
  level: SkillLevel,
  maxPdfs = 2,
): Promise<PdfPayload[]> {
  const records = await getCourseDbRecords(course.id);
  if (records.length === 0) return [];

  const explicitList =
    level.relevantPdfNames && level.relevantPdfNames.length > 0
      ? level.relevantPdfNames
      : (level.sourcePdfNames ?? []);

  const normalizedExplicit = explicitList
    .map((n) => n.toLowerCase().trim())
    .filter(Boolean)
    .slice(0, maxPdfs);

  if (normalizedExplicit.length > 0) {
    const exactMatches: StoredPdfRecord[] = [];
    for (const targetName of normalizedExplicit) {
      const match = records.find((r) => r.name.toLowerCase().trim() === targetName);
      if (match && !exactMatches.some((m) => m.id === match.id)) {
        exactMatches.push(match);
      }
    }
    if (exactMatches.length > 0) {
      return ensureFreshPdfPayloads(exactMatches.slice(0, maxPdfs));
    }
  }

  if (records.length <= maxPdfs) {
    return ensureFreshPdfPayloads(records);
  }

  const levelQuery = `${level.title} ${level.summary} ${level.objectives.join(' ')}`.toLowerCase();

  const scored = records.map((rec) => {
    const meta = course.pdfFiles.find((p) => p.name === rec.name || p.id === rec.id);
    let score = 0;

    for (const targetName of normalizedExplicit) {
      if (
        rec.name.toLowerCase().includes(targetName) ||
        targetName.includes(rec.name.toLowerCase())
      ) {
        score += 50;
      }
    }

    if (
      (level.tier === 'exam' || level.tier === 'distinction') &&
      rec.docCategory === 'past_exam'
    ) {
      score += 20;
    } else if (
      (level.tier === 'foundation' || level.tier === 'application') &&
      (rec.docCategory === 'lecture_notes' || rec.docCategory === 'slides')
    ) {
      score += 15;
    }

    const topics = meta?.extractedTopics ?? [];
    for (const topic of topics) {
      if (topic && levelQuery.includes(topic.toLowerCase())) {
        score += 10;
      }
    }

    const nameWords = rec.name.toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ');
    for (const w of nameWords) {
      if (w.length > 3 && levelQuery.includes(w)) {
        score += 5;
      }
    }

    return { rec, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const chosen = scored.slice(0, maxPdfs).map((s) => s.rec);
  return ensureFreshPdfPayloads(chosen);
}

export function isStaleFileUriError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return (
    msg.includes('permission') ||
    msg.includes('permission_denied') ||
    msg.includes('not_found') ||
    msg.includes('not found') ||
    msg.includes('expired') ||
    msg.includes('files/')
  );
}

export async function withTargetedPdfRetry<T>(
  course: Course,
  level: SkillLevel,
  fn: (pdfs: PdfPayload[]) => Promise<T>,
  maxPdfs = 2,
): Promise<T> {
  const pdfs = await getTargetedCoursePdfsForLevel(course, level, maxPdfs);
  try {
    return await fn(pdfs);
  } catch (err) {
    if (!isStaleFileUriError(err) || pdfs.length === 0) {
      throw err;
    }
    await clearCourseFileUrisInDb(course.id);
    const refreshedPdfs = await getTargetedCoursePdfsForLevel(course, level, maxPdfs);
    return await fn(refreshedPdfs);
  }
}

export async function updatePdfCategoryInDb(id: string, docCategory: DocCategory): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const record = getReq.result as StoredPdfRecord | undefined;
      if (record) {
        record.docCategory = docCategory;
        store.put(record);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to update PDF category.'));
  });
}

export async function deletePdfFromDb(id: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to delete PDF.'));
  });
}

export async function clearCourseFileUrisInDb(courseId: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('courseId');
    const req = index.getAll(courseId);
    req.onsuccess = () => {
      const records = (req.result as StoredPdfRecord[]) || [];
      for (const rec of records) {
        delete rec.fileUri;
        delete rec.fileExpiresAt;
        store.put(rec);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to invalidate cached file URIs.'));
  });
}

export async function deleteCoursePdfsFromDb(courseId: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const index = store.index('courseId');
    const req = index.getAllKeys(courseId);
    req.onsuccess = () => {
      const keys = req.result || [];
      for (const key of keys) {
        store.delete(key);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Failed to clear course PDFs.'));
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
