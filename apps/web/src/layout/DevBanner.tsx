import { FlaskConical } from 'lucide-react';
import { cn } from '@/lib/utils';
import { DEV_BANNER_TEXT } from './dev-mode';

/** Always-visible amber strip whenever DEV identity/approval providers are active (PHASE_00 §7). */
export function DevBanner({ className }: { className?: string }) {
  return (
    <div
      role="note"
      aria-label="Development identity mode"
      className={cn(
        'flex items-center justify-center gap-2 border-b border-caution/30 bg-caution/10 px-4 py-1.5 text-center text-xs font-medium text-caution',
        className,
      )}
    >
      <FlaskConical className="size-3.5 shrink-0" aria-hidden />
      <span>{DEV_BANNER_TEXT}</span>
      <span className="hidden text-caution/70 sm:inline">· not a real human verification</span>
    </div>
  );
}
