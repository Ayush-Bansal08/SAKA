import { ChevronsRight } from 'lucide-react';
import type * as React from 'react';
import { cn } from '@/lib/utils';

/** The filled circle of an `iconPill` button. Warm for demo actions, blue for agent ones. */
export function PillIcon({
  tone = 'ai',
  size = 'md',
  children,
}: {
  tone?: 'ai' | 'warm';
  size?: 'sm' | 'md';
  children?: React.ReactNode;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'flex shrink-0 items-center justify-center rounded-full text-background',
        size === 'md' ? 'size-8' : 'size-6',
        tone === 'ai' ? 'bg-agent' : 'bg-warm',
      )}
    >
      {children ?? <ChevronsRight />}
    </span>
  );
}
