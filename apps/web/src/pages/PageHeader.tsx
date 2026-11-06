import type * as React from 'react';

/** View header: one plain title, one line of context, actions on the right. */
export function PageHeader({
  title,
  description,
  actions,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-7 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h1 className="text-h1 font-semibold">{title}</h1>
        {description && (
          <p className="mt-1.5 max-w-2xl text-[15px] leading-6 text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {actions}
    </div>
  );
}

export function PageContainer({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto w-full max-w-[1120px] p-4 md:p-8">{children}</div>;
}
