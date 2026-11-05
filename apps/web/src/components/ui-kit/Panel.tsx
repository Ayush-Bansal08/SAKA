import type * as React from 'react';
import { cn } from '@/lib/utils';

/** Titled card — the basic surface of every view. */
export function Panel({
  title,
  icon,
  actions,
  subtitle,
  children,
  className,
  bodyClassName,
  ...props
}: {
  title?: React.ReactNode;
  icon?: React.ReactNode;
  actions?: React.ReactNode;
  subtitle?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  bodyClassName?: string;
} & Omit<React.ComponentProps<'section'>, 'title'>) {
  const headingId = props.id ? `${props.id}-title` : undefined;
  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        'flex min-h-0 flex-col rounded-lg border border-border bg-card text-card-foreground',
        className,
      )}
      {...props}
    >
      {(title || actions) && (
        <header className="flex min-h-14 items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex min-w-0 items-center gap-2.5">
            {icon && <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>}
            <div className="min-w-0">
              <h2 id={headingId} className="truncate text-sm font-semibold tracking-tight">
                {title}
              </h2>
              {subtitle && <p className="truncate text-xs text-muted-foreground">{subtitle}</p>}
            </div>
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cn('min-h-0 flex-1 p-4', bodyClassName)}>{children}</div>
    </section>
  );
}
