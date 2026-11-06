import { FlaskConical } from 'lucide-react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { useProviders } from '@/features/auth/hooks';

/** Renders nothing unless the server has the simulator switched on. */
export function DemoButton() {
  const providers = useProviders();
  if (!providers.data?.demoSimulator) return null;
  return (
    <Button size="sm" variant="outline" asChild>
      <Link to="/inbox/simulator">
        <FlaskConical aria-hidden /> Demo
      </Link>
    </Button>
  );
}
