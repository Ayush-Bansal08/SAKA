import { Switch } from '@/components/ui-kit';
import { useAgentInternals } from '@/hooks/useStoredFlag';

/** Remembered display preference: shows the trace and opens technical details by default. */
export function InternalsToggle() {
  const [on, setOn] = useAgentInternals();
  return (
    <label className="flex items-center gap-2.5">
      <span className="micro-label text-subtle-foreground">Agent internals</span>
      <Switch checked={on} label="Show agent internals" onChange={setOn} />
    </label>
  );
}
