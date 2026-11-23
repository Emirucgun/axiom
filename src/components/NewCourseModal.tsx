import React, { useState } from 'react';
import { X } from 'lucide-react';
import type { Course } from '../types';

interface NewCourseModalProps {
  open: boolean;
  onClose: () => void;
  onCreate: (course: Course) => void;
}

const PRESETS = [
  { name: 'Calculus II', code: 'MATH 102' },
  { name: 'Data Structures & Algorithms', code: 'CS 201' },
  { name: 'Classical Mechanics & Electromagnetism', code: 'PHYS 104' },
  { name: 'Thermodynamics', code: 'MECH 210' },
  { name: 'Signals & Linear Systems', code: 'EE 302' },
];

export const NewCourseModal: React.FC<NewCourseModalProps> = ({ open, onClose, onCreate }) => {
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [examDate, setExamDate] = useState('');

  if (!open) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;

    const newCourse: Course = {
      id: `course_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      name: trimmed,
      code: code.trim() || 'ENG',
      examDate: examDate || undefined,
      createdAt: new Date().toISOString(),
      detectedLanguage: 'English',
      courseDigest: '',
      pdfFiles: [],
      levels: [],
    };
    onCreate(newCourse);
    setName('');
    setCode('');
    setExamDate('');
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 backdrop-blur-xs p-4">
      <div className="w-full max-w-md rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 space-y-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900 dark:text-slate-100">
            Create New Course
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close modal"
            className="p-1.5 rounded-lg text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="space-y-1.5">
          <span className="text-xs font-medium text-slate-500 dark:text-slate-400">
            Quick Fill Engineering Templates
          </span>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.code}
                type="button"
                onClick={() => {
                  setName(p.name);
                  setCode(p.code);
                }}
                className="px-2.5 py-1 rounded-md border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 hover:border-sky-500 text-xs text-slate-700 dark:text-slate-200 transition-colors cursor-pointer"
              >
                {p.name}
              </button>
            ))}
          </div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-1.5">
            <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
              Course Name
            </label>
            <input
              type="text"
              required
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Calculus II"
              className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                Course Code
              </label>
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="e.g., MATH 102"
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500"
              />
            </div>

            <div className="space-y-1.5">
              <label className="block text-xs font-medium text-slate-700 dark:text-slate-300">
                Exam Date (Optional)
              </label>
              <input
                type="date"
                value={examDate}
                onChange={(e) => setExamDate(e.target.value)}
                className="w-full rounded-lg border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-950 px-3 py-2 text-sm text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-sky-500/40 focus:border-sky-500"
              />
            </div>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg border border-slate-200 dark:border-slate-700 text-xs font-medium text-slate-600 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 rounded-lg bg-sky-600 hover:bg-sky-700 text-white text-xs font-medium cursor-pointer"
            >
              Create Course
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
