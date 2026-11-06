import { ExternalLink } from 'lucide-react';
import type * as React from 'react';
import { truncateMiddle } from '@/lib/format';
import { cn } from '@/lib/utils';
import { CopyButton } from './CopyButton';

/** Monospace chip for hashes and request IDs (tx hash, 0G request ID, root hash). */
export function HashChip({
  value,
  label,
  href,
  icon,
  tone = 'neutral',
  head = 8,
  tail = 6,
  className,
}: {
  value: string;
  label?: string;
  href?: string;
  icon?: React.ReactNode;
  tone?: 'neutral' | 'zg';
  head?: number;
  tail?: number;
  className?: string;
}) {
  return (
    <span
      title={value}
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-sm border py-0.5 pr-1 pl-1.5 font-mono text-[11px] leading-4',
        tone === 'zg'
          ? 'border-zg/20 bg-zg/[0.07] text-zg'
          : 'border-border bg-surface-2 text-foreground/85',
        className,
      )}
    >
      {icon}
      {label && (
        <span
          className={cn(
            'font-sans font-medium',
            tone === 'zg' ? 'text-zg' : 'text-muted-foreground',
          )}
        >
          {label}
        </span>
      )}
      <span className="truncate" aria-label={value}>
        {truncateMiddle(value, head, tail)}
      </span>
      <CopyButton value={value} label={`Copy ${label ?? 'value'}`} />
      {href && (
        <a
          href={href}
          target="_blank"
          rel="noreferrer noopener"
          aria-label="Open in explorer"
          className="inline-flex size-5 items-center justify-center rounded text-subtle-foreground hover:text-foreground"
        >
          <ExternalLink className="size-3.5" />
        </a>
      )}
    </span>
  );
}
