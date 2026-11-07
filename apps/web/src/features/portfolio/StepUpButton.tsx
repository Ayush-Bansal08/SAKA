import { Fingerprint } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';

const STEP_UP_TOOLTIP = 'Not available yet';

/** Present but disabled until approvals cover settings changes. */
export function StepUpButton({
  children,
  icon,
  size = 'default',
}: {
  children: ReactNode;
  icon?: ReactNode;
  size?: 'sm' | 'default';
}) {
  return (
    <SimpleTooltip label={STEP_UP_TOOLTIP}>
      {/* Disabled buttons swallow pointer events; the wrapper keeps the tooltip reachable. */}
      <span
        tabIndex={0}
        className="inline-flex rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Button variant="secondary" size={size} disabled>
          {icon}
          {children}
          <Fingerprint className="text-human" aria-hidden />
          <span className="sr-only">({STEP_UP_TOOLTIP})</span>
        </Button>
      </span>
    </SimpleTooltip>
  );
}
