import React from 'react';
import katex from 'katex';

interface MathTextProps {
  text: string;
  className?: string;
}

type Segment =
  | { type: 'text'; value: string }
  | { type: 'inline-math'; value: string }
  | { type: 'display-math'; value: string };

function tokenizeMath(input: string): Segment[] {
  const segments: Segment[] = [];
  // Match $$...$$, \[...\], \(...\), or $...$
  const regex = /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|\$(?:\\.|[^$\n])+?\$)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(input)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ type: 'text', value: input.slice(lastIndex, match.index) });
    }
    const token = match[0];
    if (token.startsWith('$$') && token.endsWith('$$')) {
      segments.push({ type: 'display-math', value: token.slice(2, -2).trim() });
    } else if (token.startsWith('\\[') && token.endsWith('\\]')) {
      segments.push({ type: 'display-math', value: token.slice(2, -2).trim() });
    } else if (token.startsWith('\\(') && token.endsWith('\\)')) {
      segments.push({ type: 'inline-math', value: token.slice(2, -2).trim() });
    } else if (token.startsWith('$') && token.endsWith('$')) {
      segments.push({ type: 'inline-math', value: token.slice(1, -1).trim() });
    }
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < input.length) {
    segments.push({ type: 'text', value: input.slice(lastIndex) });
  }

  return segments;
}

function renderInlineFormatting(text: string, keyPrefix: string): React.ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return parts.map((part, idx) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={`${keyPrefix}-b-${idx}`} className="font-semibold text-slate-900 dark:text-slate-100">
          {part.slice(2, -2)}
        </strong>
      );
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code
          key={`${keyPrefix}-c-${idx}`}
          className="px-1.5 py-0.5 rounded bg-slate-100 dark:bg-slate-800 font-mono text-[0.875em]"
        >
          {part.slice(1, -1)}
        </code>
      );
    }
    return <React.Fragment key={`${keyPrefix}-t-${idx}`}>{part}</React.Fragment>;
  });
}

export const MathText: React.FC<MathTextProps> = ({ text, className = '' }) => {
  if (!text) return null;
  const segments = tokenizeMath(text);

  return (
    <div className={`whitespace-pre-wrap leading-relaxed ${className}`}>
      {segments.map((seg, i) => {
        if (seg.type === 'text') {
          return <React.Fragment key={i}>{renderInlineFormatting(seg.value, `s-${i}`)}</React.Fragment>;
        }
        try {
          const html = katex.renderToString(seg.value, {
            displayMode: seg.type === 'display-math',
            throwOnError: false,
            strict: false,
          });
          if (seg.type === 'display-math') {
            return (
              <span
                key={i}
                className="block my-2 overflow-x-auto"
                dangerouslySetInnerHTML={{ __html: html }}
              />
            );
          }
          return (
            <span
              key={i}
              className="inline-block align-middle mx-0.5"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          );
        } catch {
          return (
            <code key={i} className="font-mono text-xs bg-slate-100 dark:bg-slate-800 px-1 rounded">
              {seg.value}
            </code>
          );
        }
      })}
    </div>
  );
};
