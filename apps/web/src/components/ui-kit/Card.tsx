import type * as React from 'react';
import { cn } from '@/lib/utils';
import { Stat } from './Stat';

type Glow = 'ai' | 'warm';

const GLOW: Record<Glow, string> = {
  ai: 'bg-[linear-gradient(to_top,var(--ai-soft),transparent_70%)]',
  warm: 'bg-[linear-gradient(to_top,var(--warm-soft),transparent_70%)]',
};

/** Four small ticks at the corners: the mark of a selected or running card. */
export function CornerTicks() {
  const tick = 'absolute size-1.5 border-foreground/70';
  return (
    <span aria-hidden className="pointer-events-none absolute -inset-px">
      <span className={cn(tick, 'top-0 left-0 border-t border-l')} />
      <span className={cn(tick, 'top-0 right-0 border-t border-r')} />
      <span className={cn(tick, 'bottom-0 left-0 border-b border-l')} />
      <span className={cn(tick, 'right-0 bottom-0 border-r border-b')} />
    </span>
  );
}

/** Base surface: hairline border, inner highlight, optional glow rising from the bottom. */
export function Card({
  glow,
  selected = false,
  className,
  children,
  ...props
}: {
  glow?: Glow | undefined;
  selected?: boolean;
} & React.ComponentProps<'div'>) {
  return (
    <div
      className={cn(
        'surface-highlight relative rounded-lg border border-border bg-card transition-colors duration-150',
        selected && 'border-border-strong',
        className,
      )}
      {...props}
    >
      {glow && (
        <span aria-hidden className={cn('absolute inset-0 rounded-[inherit]', GLOW[glow])} />
      )}
      {selected && <CornerTicks />}
      <div className="relative h-full">{children}</div>
    </div>
  );
}

export function StatCard({ className, ...stat }: React.ComponentProps<typeof Stat>) {
  return (
    <Card className={cn('p-5', className)}>
      <Stat {...stat} />
    </Card>
  );
}

/** Small muted index for a numbered card. */
export function CardIndex({ value }: { value: number }) {
  return (
    <span className="micro-label text-subtle-foreground tabular" aria-hidden>
      {String(value).padStart(2, '0')}
    </span>
  );
}

/** Small tag chip for the row under a card title. */
export function TagChip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-sm border border-border px-2 py-0.5 text-[11px] leading-4 text-muted-foreground">
      {children}
    </span>
  );
}
