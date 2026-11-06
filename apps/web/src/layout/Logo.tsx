import { cn } from '@/lib/utils';
import { SYMBOL_PATH, WORDMARK_PATH, WORDMARK_VIEWBOX } from './logo-paths';

/** The monogram. Themes through currentColor. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" aria-hidden className={cn('size-8', className)}>
      <path fill="currentColor" d={SYMBOL_PATH} />
    </svg>
  );
}

export function Wordmark({ className }: { className?: string }) {
  return (
    <svg viewBox={WORDMARK_VIEWBOX} aria-hidden className={cn('h-9 w-auto', className)}>
      <path fill="currentColor" d={WORDMARK_PATH} />
    </svg>
  );
}

/** The wordmark with an accessible name. */
export function Logo({ appName, className }: { appName: string; className?: string }) {
  return (
    <span className={cn('inline-flex items-center', className)}>
      <Wordmark />
      <span className="sr-only">{appName}</span>
    </span>
  );
}
