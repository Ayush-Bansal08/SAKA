import type * as React from 'react';

/** View header: bracketed mono eyebrow, title, at most one serif accent phrase, actions. */
export function PageHeader({
  eyebrow,
  title,
  accent,
  description,
  actions,
}: {
  eyebrow?: string;
  title: React.ReactNode;
  accent?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && (
          <p className="micro-label mb-3 text-subtle-foreground sm:hidden">[ {eyebrow} ]</p>
        )}
        <h1 className="text-h1 font-medium">
          {title}
          {accent && <span className="serif-accent"> {accent}</span>}
        </h1>
        {description && (
          <p className="mt-2 max-w-2xl text-[15px] leading-6 text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {actions}
    </div>
  );
}

export function PageContainer({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-[1240px] p-4 md:p-8">{children}</div>;
}
