/**
 * The front door: one idea, one button. It needs no session and no API, so it always loads. Links
 * the API builds as /?prefill=… and any ?plan= go straight through to the app.
 */
import { ArrowRight, Check } from 'lucide-react';
import { Link, Navigate, useLocation, useSearchParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { FlowField } from '@/components/ui-kit/FlowField';
import { Wordmark } from '@/layout/Logo';

const POINTS = ['Plans on 0G', 'Trades on Uniswap', 'Big moves wait for you'];

export function LandingPage() {
  const [params] = useSearchParams();
  const { search } = useLocation();
  if (params.get('prefill') || params.get('plan'))
    return <Navigate to={{ pathname: '/app', search }} replace />;

  return (
    <div className="relative isolate flex min-h-dvh flex-col overflow-hidden">
      <FlowField className="absolute inset-0 -z-10" />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-[radial-gradient(44%_42%_at_50%_50%,rgba(10,7,18,0.82),transparent_100%)]"
      />
      <header className="flex items-center justify-between px-6 py-6 md:px-10">
        <Wordmark className="h-8" />
        <span className="sr-only">SAKA</span>
        <span className="rounded-full border border-caution/30 bg-caution/10 px-3 py-1 text-xs font-medium text-caution">
          Testnet only
        </span>
      </header>

      <main
        id="main"
        className="view-enter flex flex-1 flex-col items-center justify-center px-6 pb-16 text-center"
      >
        <p className="glass mb-7 inline-flex items-center gap-2 rounded-full border border-border px-4 py-1.5 text-sm text-muted-foreground">
          <span className="size-1.5 rounded-full bg-agent" aria-hidden />
          Your own AI agent for DeFi
        </p>
        <h1 className="text-display max-w-4xl font-semibold">
          DeFi that thinks
          <br />
          <span className="text-gradient-ai">before it trades.</span>
        </h1>
        <p className="mt-6 max-w-xl text-[17px] leading-7 text-muted-foreground">
          SAKA plans, checks and executes on Uniswap. Every decision is verified and logged, and
          anything big waits for you.
        </p>
        <Button
          size="lg"
          asChild
          className="mt-10 h-14 px-10 text-base shadow-[0_0_48px_-6px_var(--brand)] hover:shadow-[0_0_64px_-4px_var(--brand)]"
        >
          <Link to="/app">
            Start <ArrowRight aria-hidden />
          </Link>
        </Button>
        <ul className="mt-12 flex flex-wrap justify-center gap-x-8 gap-y-2 text-sm text-muted-foreground">
          {POINTS.map((p) => (
            <li key={p} className="flex items-center gap-2">
              <Check className="size-4 text-agent" aria-hidden />
              {p}
            </li>
          ))}
        </ul>
      </main>
    </div>
  );
}
