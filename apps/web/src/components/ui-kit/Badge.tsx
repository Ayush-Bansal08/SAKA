import { cva, type VariantProps } from 'class-variance-authority';
import { Bot, Fingerprint, ShieldAlert, ShieldCheck, ShieldX, BadgeCheck } from 'lucide-react';
import type * as React from 'react';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4 [&_svg]:size-3 [&_svg]:shrink-0',
  {
    variants: {
      tone: {
        neutral: 'border-border-strong bg-surface-2 text-muted-foreground',
        safe: 'border-safe/25 bg-safe/10 text-safe',
        caution: 'border-caution/25 bg-caution/10 text-caution',
        danger: 'border-danger/25 bg-danger/10 text-danger',
        info: 'border-info/25 bg-info/10 text-info',
        agent: 'border-agent/25 bg-agent/10 text-agent',
        human: 'border-human/25 bg-human/10 text-human',
        zg: 'border-zg/25 bg-zg/10 text-zg',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>['tone']>;

export interface BadgeProps
  extends React.ComponentProps<'span'>, VariantProps<typeof badgeVariants> {
  icon?: React.ReactNode;
}

export function Badge({ className, tone, icon, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props}>
      {icon}
      {children}
    </span>
  );
}

/** Preset badges used across the product. */
export const SafeBadge = (p: Omit<BadgeProps, 'tone'>) => (
  <Badge tone="safe" icon={<ShieldCheck aria-hidden />} {...p}>
    {p.children ?? 'Safe'}
  </Badge>
);
export const CautionBadge = (p: Omit<BadgeProps, 'tone'>) => (
  <Badge tone="caution" icon={<ShieldAlert aria-hidden />} {...p}>
    {p.children ?? 'Caution'}
  </Badge>
);
export const DangerBadge = (p: Omit<BadgeProps, 'tone'>) => (
  <Badge tone="danger" icon={<ShieldX aria-hidden />} {...p}>
    {p.children ?? 'Danger'}
  </Badge>
);
export const ZgVerifiedBadge = (p: Omit<BadgeProps, 'tone'>) => (
  <Badge tone="zg" icon={<BadgeCheck aria-hidden />} {...p}>
    {p.children ?? '0G verified'}
  </Badge>
);
export const AgentBadge = (p: Omit<BadgeProps, 'tone'>) => (
  <Badge tone="agent" icon={<Bot aria-hidden />} {...p}>
    {p.children ?? 'Agent'}
  </Badge>
);
export const HumanBadge = (p: Omit<BadgeProps, 'tone'>) => (
  <Badge tone="human" icon={<Fingerprint aria-hidden />} {...p}>
    {p.children ?? 'Human'}
  </Badge>
);
