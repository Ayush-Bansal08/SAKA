import * as Collapsible from '@radix-ui/react-collapsible';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import type * as React from 'react';
import { useAgentInternals } from '@/hooks/useStoredFlag';
import { cn } from '@/lib/utils';

/**
 * Expander for "Why", "Technical details" and the like. `technical` sections follow the "Show
 * agent internals" preference until the human opens or closes one themselves.
 *
 * Never wrap amounts, fees or warnings the human is deciding on: those stay on the card.
 */
export function Disclosure({
  title,
  aside,
  defaultOpen = false,
  technical = false,
  children,
  className,
}: {
  title: React.ReactNode;
  aside?: React.ReactNode;
  defaultOpen?: boolean;
  technical?: boolean;
  children: React.ReactNode;
  className?: string;
}) {
  const [internals] = useAgentInternals();
  const [choice, setChoice] = useState<boolean | null>(null);
  const open = choice ?? (defaultOpen || (technical && internals));
  return (
    <Collapsible.Root open={open} onOpenChange={setChoice} className={className}>
      <div className="flex items-center justify-between gap-2">
        <Collapsible.Trigger className="group -ml-1 inline-flex min-h-8 items-center gap-1 rounded-sm px-1 text-left focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none">
          <ChevronRight
            className="size-3.5 shrink-0 text-subtle-foreground transition-transform duration-150 group-data-[state=open]:rotate-90"
            aria-hidden
          />
          <span
            className={cn(
              technical
                ? 'micro-label text-subtle-foreground group-hover:text-muted-foreground'
                : 'text-xs font-medium text-muted-foreground group-hover:text-foreground',
            )}
          >
            {title}
          </span>
        </Collapsible.Trigger>
        {aside}
      </div>
      <Collapsible.Content className="pt-1.5 data-[state=open]:animate-in data-[state=open]:fade-in-0">
        {children}
      </Collapsible.Content>
    </Collapsible.Root>
  );
}
