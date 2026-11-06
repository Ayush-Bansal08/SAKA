import type * as React from 'react';
import { NavLink } from 'react-router';
import { cn } from '@/lib/utils';

export interface TabNavItem {
  to: string;
  label: string;
  end?: boolean;
  badge?: React.ReactNode;
}

/** Underline tabs that are real links, so each tab has a URL and works with the keyboard. */
export function TabNav({ label, items }: { label: string; items: readonly TabNavItem[] }) {
  return (
    <nav aria-label={label} className="flex gap-6 overflow-x-auto border-b border-border">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          {...(item.end ? { end: true } : {})}
          className={({ isActive }) =>
            cn(
              'relative -mb-px inline-flex min-h-11 shrink-0 items-center gap-2 rounded-t-sm border-b-2 text-sm font-medium transition-colors duration-150',
              isActive
                ? 'border-foreground text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )
          }
        >
          {item.label}
          {item.badge}
        </NavLink>
      ))}
    </nav>
  );
}
