import { ArrowDownRight, ArrowUpRight } from 'lucide-react';
import type * as React from 'react';
import { cn } from '@/lib/utils';

/** Label + big number + optional delta. Values are pre-formatted strings (never raw floats). */
export function Stat({
  label,
  value,
  delta,
  deltaTone,
  hint,
  size = 'md',
  className,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  delta?: string;
  deltaTone?: 'up' | 'down' | 'flat';
  hint?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg';
  className?: string;
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="micro-label text-subtle-foreground">{label}</div>
      <div
        className={cn(
          'mt-2 truncate font-medium tracking-tight tabular',
          size === 'lg' && 'text-[32px] leading-10',
          size === 'md' && 'text-2xl',
          size === 'sm' && 'text-lg',
        )}
      >
        {value}
      </div>
      {(delta || hint) && (
        <div className="mt-1 flex items-center gap-2 text-xs">
          {delta && (
            <span
              className={cn(
                'inline-flex items-center gap-0.5 font-medium tabular',
                deltaTone === 'up' && 'text-safe',
                deltaTone === 'down' && 'text-danger',
                (!deltaTone || deltaTone === 'flat') && 'text-muted-foreground',
              )}
            >
              {deltaTone === 'up' && <ArrowUpRight className="size-3.5" aria-hidden />}
              {deltaTone === 'down' && <ArrowDownRight className="size-3.5" aria-hidden />}
              {delta}
            </span>
          )}
          {hint && <span className="text-subtle-foreground">{hint}</span>}
        </div>
      )}
    </div>
  );
}
