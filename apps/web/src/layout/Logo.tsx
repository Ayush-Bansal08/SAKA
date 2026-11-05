import { cn } from '@/lib/utils';

export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn('size-8', className)}>
      <defs>
        <linearGradient id="warden-logo" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="var(--agent)" />
          <stop offset="1" stopColor="var(--human)" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="9" fill="var(--surface-2)" />
      <path
        d="M16 5l9 3.5v6.8c0 5.6-3.8 10-9 11.7-5.2-1.7-9-6.1-9-11.7V8.5L16 5z"
        fill="none"
        stroke="url(#warden-logo)"
        strokeWidth="2.2"
        strokeLinejoin="round"
      />
      <path
        d="M11.5 15.8l3.2 3.2 5.8-6"
        fill="none"
        stroke="url(#warden-logo)"
        strokeWidth="2.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function Logo({ appName, className }: { appName: string; className?: string }) {
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <LogoMark />
      <span className="text-[15px] font-semibold tracking-tight">{appName}</span>
    </span>
  );
}
