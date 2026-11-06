import type { SimulatorScenarioView } from '@warden/shared';
import { Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardIndex, PillIcon } from '@/components/ui-kit';

export function ScenarioCard({
  scenario,
  index,
  selected,
  running,
  disabled,
  onTrigger,
}: {
  scenario: SimulatorScenarioView;
  index: number;
  selected: boolean;
  running: boolean;
  disabled: boolean;
  onTrigger: () => void;
}) {
  return (
    <li>
      <Card selected={selected} glow={running ? 'warm' : undefined} className="h-full p-5">
        <div className="flex h-full flex-col gap-3">
          <CardIndex value={index} />
          <div className="min-w-0 flex-1">
            <p className="text-h3 font-medium [overflow-wrap:anywhere]">{scenario.label}</p>
            <p className="mt-1.5 text-[13px] leading-5 text-muted-foreground [overflow-wrap:anywhere]">
              {scenario.description}
            </p>
          </div>
          <Button
            size="sm"
            variant="iconPill"
            className="self-start"
            disabled={disabled}
            onClick={onTrigger}
            aria-label={`Trigger ${scenario.label}`}
          >
            <PillIcon tone="warm" size="sm">
              <Play className="fill-current" />
            </PillIcon>
            {running ? 'Running' : 'Run'}
          </Button>
        </div>
      </Card>
    </li>
  );
}
