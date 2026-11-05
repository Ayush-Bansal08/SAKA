import { Compass } from 'lucide-react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui-kit';
import { PageContainer } from './PageHeader';

export function NotFoundPage() {
  return (
    <PageContainer>
      <EmptyState
        className="py-24"
        icon={<Compass />}
        title="Page not found"
        description="That page doesn't exist. Head back to your cockpit."
        action={
          <Button asChild variant="secondary">
            <Link to="/">Go to cockpit</Link>
          </Button>
        }
      />
    </PageContainer>
  );
}
