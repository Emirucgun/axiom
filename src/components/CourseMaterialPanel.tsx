import React, { useState, useRef } from 'react';
import {
  FileText,
  Upload,
  Trash2,
  Loader2,
  AlertCircle,
  Sparkles,
  CheckCircle2,
} from 'lucide-react';
import type { Course, DocCategory, PdfAttachmentMeta } from '../types';
import {
  deleteCoursePdf,
  formatBytes,
  generateRoadmap,
  inferDocCategory,
  updatePdfCategory,
  uploadCoursePdf,
} from '../services/courseService';

interface CourseMaterialPanelProps {
  course: Course;
  onUpdateCourse: (updated: Course) => void;
  onNotifyError?: (message: string) => void;
}

const CATEGORY_LABELS: Record<DocCategory, string> = {
  lecture_notes: 'Lecture Notes',
  slides: 'Lecture Slides',
  past_exam: 'Past Exam',
  problem_set: 'Problem Set',
};

export const CourseMaterialPanel: React.FC<CourseMaterialPanelProps> = ({
  course,
  onUpdateCourse,
  onNotifyError,
}) => {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<{ done: number; total: number } | null>(null);
  const [generating, setGenerating] = useState(false);
  const [roadmapProgress, setRoadmapProgress] = useState<{
    label: string;
    percent: number;
  } | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [confirmRegenerate, setConfirmRegenerate] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const reportError = (msg: string) => {
    setErrorMsg(msg);
    onNotifyError?.(msg);
  };

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    setErrorMsg(null);
    setUploading(true);

    const added: PdfAttachmentMeta[] = [];
    const failures: string[] = [];
    try {
      const pdfFiles = Array.from(fileList).filter(
        (f) => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'),
      );
      if (pdfFiles.length === 0) {
        throw new Error('Please upload PDF files (.pdf).');
      }

      setUploadProgress({ done: 0, total: pdfFiles.length });
      const concurrency = 3;

      for (let i = 0; i < pdfFiles.length; i += concurrency) {
        const chunk = pdfFiles.slice(i, i + concurrency);
        // Pass the growing list so duplicate-name checks include this session's uploads
        const snapshot: Course = { ...course, pdfFiles: [...course.pdfFiles, ...added] };
        const results = await Promise.allSettled(
          chunk.map((file) => uploadCoursePdf(snapshot, file, inferDocCategory(file.name))),
        );
        for (const r of results) {
          if (r.status === 'fulfilled') added.push(r.value);
          else failures.push(r.reason instanceof Error ? r.reason.message : String(r.reason));
        }
        setUploadProgress({ done: Math.min(pdfFiles.length, i + chunk.length), total: pdfFiles.length });
      }
      if (failures.length > 0) {
        reportError(failures.join(' '));
      }
    } catch (err) {
      reportError(err instanceof Error ? err.message : 'Failed to upload PDF file.');
    } finally {
      if (added.length > 0) {
        onUpdateCourse({ ...course, pdfFiles: [...course.pdfFiles, ...added] });
      }
      setUploading(false);
      setUploadProgress(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleCategoryChange = async (pdfId: string, nextCat: DocCategory) => {
    try {
      await updatePdfCategory(pdfId, nextCat);
      onUpdateCourse({
        ...course,
        pdfFiles: course.pdfFiles.map((p) => (p.id === pdfId ? { ...p, docCategory: nextCat } : p)),
      });
    } catch (err) {
      reportError(err instanceof Error ? err.message : 'Failed to update document type.');
    }
  };

  const handleDeletePdf = async (pdf: PdfAttachmentMeta) => {
    try {
      await deleteCoursePdf(pdf);
      onUpdateCourse({
        ...course,
        pdfFiles: course.pdfFiles.filter((p) => p.id !== pdf.id),
      });
    } catch (err) {
      reportError(err instanceof Error ? err.message : 'Failed to delete PDF.');
    }
  };

  const handleGenerateRoadmap = async () => {
    setErrorMsg(null);
    setConfirmRegenerate(false);
    setGenerating(true);
    setRoadmapProgress({ label: 'Preparing PDFs from cloud storage…', percent: 5 });

    try {
      const updated = await generateRoadmap(course, (label, percent) =>
        setRoadmapProgress({ label, percent }),
      );
      onUpdateCourse(updated);
    } catch (err) {
      reportError(err instanceof Error ? err.message : 'Roadmap generation failed.');
    } finally {
      setGenerating(false);
      setRoadmapProgress(null);
    }
  };

  const hasRoadmap = course.levels.length > 0;

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
            Course Materials &amp; Syllabus Ingestion
          </h3>
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Upload lecture slides, notes, and past exam PDFs. Stored securely in your cloud account and extracted in 5-PDF batches to prevent timeouts.
          </p>
        </div>

        <div className="flex items-center gap-2.5">
          <input
            ref={fileInputRef}
            type="file"
            accept="application/pdf,.pdf"
            multiple
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
          <button
            type="button"
            disabled={uploading || generating}
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 hover:bg-slate-50 dark:hover:bg-slate-800 disabled:opacity-50 text-xs font-medium text-slate-700 dark:text-slate-200 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Upload className="w-3.5 h-3.5" />
            <span>
              {uploading && uploadProgress
                ? `Uploading ${uploadProgress.done}/${uploadProgress.total}…`
                : 'Add PDFs'}
            </span>
          </button>

          {hasRoadmap && !confirmRegenerate ? (
            <button
              type="button"
              disabled={generating || uploading || course.pdfFiles.length === 0}
              onClick={() => setConfirmRegenerate(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 hover:opacity-90 disabled:opacity-50 text-xs font-medium transition-opacity whitespace-nowrap shrink-0 cursor-pointer"
            >
              {generating ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Processing…</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Regenerate Roadmap</span>
                </>
              )}
            </button>
          ) : confirmRegenerate ? (
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={handleGenerateRoadmap}
                className="px-3 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer"
              >
                Confirm Rebuild
              </button>
              <button
                type="button"
                onClick={() => setConfirmRegenerate(false)}
                className="px-2.5 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs text-slate-600 dark:text-slate-300 whitespace-nowrap shrink-0 cursor-pointer"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              disabled={generating || uploading || course.pdfFiles.length === 0}
              onClick={handleGenerateRoadmap}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 disabled:opacity-50 text-white text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {generating ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>Building 10-Level Roadmap…</span>
                </>
              ) : (
                <>
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Generate 10-Level Mastery Roadmap</span>
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {/* Dropzone when empty or dragging */}
      {(course.pdfFiles.length === 0 || dragging) && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            handleFiles(e.dataTransfer.files);
          }}
          onClick={() => fileInputRef.current?.click()}
          className={`rounded-lg border border-dashed p-6 text-center transition-colors cursor-pointer ${
            dragging
              ? 'border-sky-500 bg-sky-50/70 dark:bg-sky-950/30'
              : 'border-slate-300 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-600 bg-slate-50/70 dark:bg-slate-950/40'
          }`}
        >
          <p className="text-sm font-medium text-slate-700 dark:text-slate-200">
            Drop multiple PDF files here or click to browse
          </p>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
            Supports large multi-file decks (25+ PDFs) via automatic 5-PDF batch syllabus extraction
          </p>
        </div>
      )}

      {/* Attached PDF List */}
      {course.pdfFiles.length > 0 && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          className="max-h-64 overflow-y-auto divide-y divide-slate-100 dark:divide-slate-800 border border-slate-200 dark:border-slate-800 rounded-lg"
        >
          {course.pdfFiles.map((pdf) => (
            <div
              key={pdf.id}
              className="flex flex-wrap items-center justify-between gap-3 px-3.5 py-2.5 bg-slate-50/50 dark:bg-slate-950/50 text-xs"
            >
              <div className="flex items-center gap-2.5 min-w-0 flex-1">
                <FileText className="w-4 h-4 text-sky-600 dark:text-sky-400 shrink-0" />
                <span className="font-medium text-slate-800 dark:text-slate-200 truncate">
                  {pdf.name}
                </span>
                <span className="font-mono text-slate-400 dark:text-slate-500 tabular-nums shrink-0">
                  {formatBytes(pdf.size)}
                </span>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <select
                  aria-label={`Document type for ${pdf.name}`}
                  value={pdf.docCategory}
                  onChange={(e) => handleCategoryChange(pdf.id, e.target.value as DocCategory)}
                  className="rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1 text-xs text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-sky-500"
                >
                  {(Object.keys(CATEGORY_LABELS) as DocCategory[]).map((cat) => (
                    <option key={cat} value={cat}>
                      {CATEGORY_LABELS[cat]}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  title="Remove PDF"
                  onClick={() => handleDeletePdf(pdf)}
                  className="p-1 rounded text-slate-400 hover:text-red-600 dark:hover:text-red-400 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Real-time Two-Step Batch Progress Bar */}
      {generating && roadmapProgress && (
        <div className="p-4 rounded-lg border border-sky-200 dark:border-sky-900/60 bg-sky-50/60 dark:bg-sky-950/30 space-y-2.5">
          <div className="flex items-center justify-between gap-3 text-xs text-sky-900 dark:text-sky-200">
            <div className="flex items-center gap-2">
              <Loader2 className="w-4 h-4 animate-spin shrink-0 text-sky-600 dark:text-sky-400" />
              <span className="font-medium">{roadmapProgress.label}</span>
            </div>
            <span className="font-mono font-semibold tabular-nums">
              {roadmapProgress.percent}%
            </span>
          </div>
          <div className="h-2 w-full rounded-full bg-sky-100 dark:bg-sky-950 overflow-hidden">
            <div
              className="h-full bg-sky-600 dark:bg-sky-400 transition-all duration-300"
              style={{ width: `${roadmapProgress.percent}%` }}
            />
          </div>
        </div>
      )}

      {hasRoadmap && !generating && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500 dark:text-slate-400 pt-1">
          <span className="inline-flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400 font-medium">
            <CheckCircle2 className="w-3.5 h-3.5" />
            <span>10-Level Roadmap Active</span>
          </span>
          <span>
            Detected Language:{' '}
            <strong className="text-slate-700 dark:text-slate-200">{course.detectedLanguage}</strong>{' '}
            · Sequential lock enabled (≥ 80% to advance)
          </span>
        </div>
      )}

      {errorMsg && (
        <div className="p-3 rounded-lg border border-red-200 dark:border-red-900/60 bg-red-50 dark:bg-red-950/40 text-xs text-red-700 dark:text-red-300 flex items-start gap-2">
          <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
          <span>{errorMsg}</span>
        </div>
      )}
    </div>
  );
};
