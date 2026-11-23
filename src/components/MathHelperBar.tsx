import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { MathText } from './MathText';

interface MathHelperBarProps {
  value: string;
  onInsert: (snippet: string) => void;
}

const SYMBOLS = [
  { label: '∫', insert: '\\int ', title: 'Integral' },
  { label: '∑', insert: '\\sum ', title: 'Summation' },
  { label: '∂', insert: '\\partial ', title: 'Partial derivative' },
  { label: '∇', insert: '\\nabla ', title: 'Nabla / Gradient' },
  { label: 'lim', insert: '\\lim_{x \\to 0} ', title: 'Limit' },
  { label: 'frac', insert: '\\frac{a}{b}', title: 'Fraction' },
  { label: '√', insert: '\\sqrt{}', title: 'Square root' },
  { label: '→', insert: '\\to ', title: 'Approaches / Implies' },
  { label: '≤', insert: '\\le ', title: 'Less or equal' },
  { label: '≥', insert: '\\ge ', title: 'Greater or equal' },
  { label: '∞', insert: '\\infty', title: 'Infinity' },
  { label: 'λ', insert: '\\lambda', title: 'Lambda' },
  { label: 'θ', insert: '\\theta', title: 'Theta' },
  { label: 'ω', insert: '\\omega', title: 'Omega' },
  { label: 'Δ', insert: '\\Delta ', title: 'Delta' },
  { label: '$…$', insert: '$ $', title: 'Wrap inline KaTeX math' },
];

export const MathHelperBar: React.FC<MathHelperBarProps> = ({ value, onInsert }) => {
  const [showPreview, setShowPreview] = useState(false);

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1">
          {SYMBOLS.map((sym) => (
            <button
              key={sym.label}
              type="button"
              title={sym.title}
              onClick={() => onInsert(sym.insert)}
              className="px-2 py-1 text-xs font-mono rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
            >
              {sym.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => setShowPreview((p) => !p)}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          {showPreview ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          <span>{showPreview ? 'Hide Preview' : 'Preview Math'}</span>
        </button>
      </div>
      {showPreview && (
        <div className="p-3 rounded-lg border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-900/60 text-sm text-slate-800 dark:text-slate-200">
          {value.trim() ? (
            <MathText text={value} />
          ) : (
            <span className="text-slate-400 dark:text-slate-500 text-xs">
              Use $...$ for inline math or $$...$$ for display equations to preview rendered KaTeX here.
            </span>
          )}
        </div>
      )}
    </div>
  );
};
