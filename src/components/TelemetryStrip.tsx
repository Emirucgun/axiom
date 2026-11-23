import React from 'react';
import { Flame, TrendingUp, Layers, Gauge } from 'lucide-react';
import type { Course } from '../types';
import { computeCourseReadiness } from '../utils/persistence';

interface TelemetryStripProps {
  elo: number;
  streakDays: number;
  activeCourse: Course | null;
}

export const TelemetryStrip: React.FC<TelemetryStripProps> = ({
  elo,
  streakDays,
  activeCourse,
}) => {
  const levels = activeCourse?.levels ?? [];
  const masteredCount = levels.filter((l) => l.mastered).length;
  const unlockedCount = levels.filter((l) => l.unlocked).length;
  const readiness = computeCourseReadiness(activeCourse);

  const readinessStatus =
    readiness >= 75
      ? { label: 'Exam Ready', colorClass: 'text-emerald-700 dark:text-emerald-400', stroke: '#059669' }
      : readiness >= 40
        ? { label: 'In Training', colorClass: 'text-sky-700 dark:text-sky-400', stroke: '#0284C7' }
        : { label: 'Early Stage', colorClass: 'text-amber-700 dark:text-amber-400', stroke: '#D97706' };

  const daysUntilExam = activeCourse?.examDate
    ? Math.ceil(
        (new Date(`${activeCourse.examDate}T23:59:59`).getTime() - Date.now()) /
          (1000 * 60 * 60 * 24),
      )
    : null;

  // Semi-circle gauge arc math
  const radius = 28;
  const circumference = Math.PI * radius;
  const dashOffset = circumference - (readiness / 100) * circumference;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
      {/* 1. Mastery Elo */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex items-center justify-between gap-3">
        <div className="space-y-1">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
            <TrendingUp className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" />
            <span>Mastery Elo</span>
          </div>
          <div className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
            {elo}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            {elo >= 1450
              ? 'Distinction Tier'
              : elo >= 1300
                ? 'Exam Competitive'
                : 'Core Calibration'}
          </div>
        </div>
      </div>

      {/* 2. Daily Streak */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex items-center justify-between gap-3">
        <div className="space-y-1">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
            <Flame className="w-3.5 h-3.5 text-amber-600 dark:text-amber-400" />
            <span>Daily Streak</span>
          </div>
          <div className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
            {streakDays} {streakDays === 1 ? 'Day' : 'Days'}
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400">
            {streakDays > 0 ? 'Active recall habit kept' : 'Complete 1 drill today'}
          </div>
        </div>
      </div>

      {/* 3. Skill Tree Mastery */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 space-y-2">
        <div className="flex items-center justify-between text-xs font-medium text-slate-500 dark:text-slate-400">
          <span className="flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" />
            <span>Levels Mastered</span>
          </span>
          <span className="font-mono tabular-nums">
            {unlockedCount}/10 Unlocked
          </span>
        </div>
        <div className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
          {masteredCount} <span className="text-sm font-normal text-slate-400">/ 10</span>
        </div>
        <div className="h-1.5 w-full rounded-full bg-slate-100 dark:bg-slate-800 overflow-hidden">
          <div
            className="h-full bg-emerald-600 dark:bg-emerald-500 transition-all duration-300"
            style={{ width: `${(masteredCount / 10) * 100}%` }}
          />
        </div>
      </div>

      {/* 4. Exam Readiness Gauge */}
      <div className="rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-4 flex items-center justify-between gap-3">
        <div className="space-y-1">
          <div className="text-xs font-medium text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
            <Gauge className="w-3.5 h-3.5 text-sky-600 dark:text-sky-400" />
            <span>Exam Readiness</span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-bold font-mono tabular-nums text-slate-900 dark:text-slate-100">
              {readiness}%
            </span>
            <span className={`text-xs font-medium ${readinessStatus.colorClass}`}>
              {readinessStatus.label}
            </span>
          </div>
          <div className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
            {daysUntilExam !== null
              ? daysUntilExam > 0
                ? `${daysUntilExam}d to exam`
                : daysUntilExam === 0
                  ? 'Exam day today'
                  : 'Exam date passed'
              : 'No exam date set'}
          </div>
        </div>

        <svg width="72" height="44" viewBox="0 0 72 44" aria-label={`Exam readiness ${readiness}%`}>
          <path
            d="M 8 38 A 28 28 0 0 1 64 38"
            fill="none"
            stroke="currentColor"
            className="text-slate-200 dark:text-slate-800"
            strokeWidth="6"
            strokeLinecap="round"
          />
          <path
            d="M 8 38 A 28 28 0 0 1 64 38"
            fill="none"
            stroke={readinessStatus.stroke}
            strokeWidth="6"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            className="transition-all duration-500"
          />
        </svg>
      </div>
    </div>
  );
};
