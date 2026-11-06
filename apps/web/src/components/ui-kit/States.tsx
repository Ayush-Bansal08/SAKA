import { AlertTriangle, Info, RotateCw, TriangleAlert } from 'lucide-react';
import type * as React from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
  children,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <div
      className={cn('flex flex-col items-center justify-center px-6 py-10 text-center', className)}
    >
      {icon && (
        <div className="relative mb-5 flex size-16 items-center justify-center text-muted-foreground [&_svg]:size-6 [&_svg]:stroke-[1.25]">
          <span aria-hidden className="absolute inset-0 rounded-full border border-border" />
          <span aria-hidden className="absolute inset-2.5 rounded-full border border-border" />
          {icon}
        </div>
      )}
      <h3 className="text-sm font-medium">{title}</h3>
      {description && (
        <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}
      {children}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function ErrorState({
  title = 'Something went wrong',
  description,
  onRetry,
  retrying,
  className,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  onRetry?: () => void;
  retrying?: boolean;
  className?: string;
}) {
  return (
    <div
      role="alert"
      className={cn('flex flex-col items-center px-6 py-10 text-center', className)}
    >
      <div className="mb-4 flex size-12 items-center justify-center rounded-full border border-danger/25 bg-danger/10 text-danger">
        <AlertTriangle className="size-5" aria-hidden />
      </div>
      <h3 className="text-sm font-medium">{title}</h3>
      {description && (
        <p className="mt-1.5 max-w-sm text-sm leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}
      {onRetry && (
        <Button
          variant="secondary"
          size="sm"
          className="mt-5"
          onClick={onRetry}
          disabled={retrying}
        >
          <RotateCw className={cn(retrying && 'animate-spin')} aria-hidden />
          {retrying ? 'Retrying…' : 'Try again'}
        </Button>
      )}
    </div>
  );
}

export function SkeletonRows({
  rows = 4,
  className,
  label = 'Loading',
}: {
  rows?: number;
  className?: string;
  label?: string;
}) {
  return (
    <div role="status" aria-label={label} className={cn('space-y-3', className)}>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Skeleton className="size-8 shrink-0 rounded-full" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3" style={{ width: `${70 - ((i * 13) % 30)}%` }} />
            <Skeleton className="h-2.5 w-1/3" />
          </div>
        </div>
      ))}
      <span className="sr-only">{label}…</span>
    </div>
  );
}

export function Banner({
  tone = 'info',
  title,
  children,
  className,
  icon,
}: {
  tone?: 'info' | 'warn';
  title?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  icon?: React.ReactNode;
}) {
  return (
    <div
      role={tone === 'warn' ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2.5 rounded-md border px-3.5 py-2.5 text-sm',
        tone === 'warn'
          ? 'border-caution/30 bg-caution/10 text-caution'
          : 'border-border bg-surface-2 text-muted-foreground',
        className,
      )}
    >
      <span className="mt-0.5 shrink-0 [&_svg]:size-4">
        {icon ?? (tone === 'warn' ? <TriangleAlert aria-hidden /> : <Info aria-hidden />)}
      </span>
      <div className="min-w-0">
        {title && <div className="font-medium">{title}</div>}
        {children && <div className={cn(title && 'mt-0.5', 'text-foreground/80')}>{children}</div>}
      </div>
    </div>
  );
}
