import type { TraceKind } from '@warden/shared';
import {
  AlertTriangle,
  Brain,
  FlaskConical,
  Fingerprint,
  Gauge,
  PackageCheck,
  Power,
  Radar,
  Receipt,
  Scale,
  ScrollText,
  Send,
  ShieldCheck,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

export interface KindMeta {
  label: string;
  icon: LucideIcon;
  /** Tailwind classes for the timeline node. */
  tone: string;
}

export const KIND_META: Record<TraceKind, KindMeta> = {
  system: { label: 'System', icon: Power, tone: 'text-info bg-info/10 border-info/25' },
  plan: { label: 'Plan', icon: Brain, tone: 'text-agent bg-agent/10 border-agent/25' },
  tool_call: {
    label: 'Tool call',
    icon: Wrench,
    tone: 'text-muted-foreground bg-surface-2 border-border-strong',
  },
  tool_result: {
    label: 'Tool result',
    icon: PackageCheck,
    tone: 'text-muted-foreground bg-surface-2 border-border-strong',
  },
  score: {
    label: 'Safety score',
    icon: Gauge,
    tone: 'text-caution bg-caution/10 border-caution/25',
  },
  simulation: {
    label: 'Simulation',
    icon: FlaskConical,
    tone: 'text-info bg-info/10 border-info/25',
  },
  guard: { label: '0G guard', icon: ShieldCheck, tone: 'text-zg bg-zg/10 border-zg/25' },
  policy: { label: 'Policy', icon: Scale, tone: 'text-agent bg-agent/10 border-agent/25' },
  approval: {
    label: 'Human approval',
    icon: Fingerprint,
    tone: 'text-human bg-human/10 border-human/25',
  },
  tx: { label: 'Transaction', icon: Send, tone: 'text-info bg-info/10 border-info/25' },
  receipt: { label: 'Receipt', icon: Receipt, tone: 'text-safe bg-safe/10 border-safe/25' },
  log: {
    label: 'Log',
    icon: ScrollText,
    tone: 'text-muted-foreground bg-surface-2 border-border-strong',
  },
  error: { label: 'Error', icon: AlertTriangle, tone: 'text-danger bg-danger/10 border-danger/25' },
  detector: {
    label: 'Detector',
    icon: Radar,
    tone: 'text-caution bg-caution/10 border-caution/25',
  },
};
