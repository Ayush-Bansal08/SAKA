import type { SimulatorScenarioView } from '@warden/shared';
import { Play } from 'lucide-react';
import { Button } from '@/components/ui/button';

export function ScenarioCard({
  scenario,
  disabled,
  onTrigger,
}: {
  scenario: SimulatorScenarioView;
  disabled: boolean;
  onTrigger: () => void;
}) {
  return (
    <li className="flex flex-col gap-3 rounded-lg border border-border bg-surface-2/40 p-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium [overflow-wrap:anywhere]">{scenario.label}</p>
        <p className="mt-1 text-[13px] text-muted-foreground [overflow-wrap:anywhere]">
          {scenario.description}
        </p>
      </div>
      <Button
        size="sm"
        variant="secondary"
        className="self-start"
        disabled={disabled}
        onClick={onTrigger}
        aria-label={`Trigger ${scenario.label}`}
      >
        <Play aria-hidden /> Trigger
      </Button>
    </li>
  );
}
