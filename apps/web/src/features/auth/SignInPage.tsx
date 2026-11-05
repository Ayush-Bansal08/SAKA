import { DisplayNameSchema, type ProvidersResponse } from '@warden/shared';
import { ArrowRight, BadgeCheck, Fingerprint, Loader2, ShieldCheck } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Banner } from '@/components/ui-kit';
import { DevBanner } from '@/layout/DevBanner';
import { usesDevProviders } from '@/layout/dev-mode';
import { LogoMark } from '@/layout/Logo';
import { ApiError } from '@/lib/api';
import { useDevSignIn } from './hooks';

const PILLARS = [
  {
    icon: Fingerprint,
    title: 'One human, one agent',
    body: 'Your agent belongs to a verified human.',
  },
  { icon: ShieldCheck, title: 'You stay in control', body: 'Big moves always wait for you.' },
  { icon: BadgeCheck, title: 'Verifiable decisions', body: 'Every decision is logged on 0G.' },
];

export function SignInPage({ providers }: { providers: ProvidersResponse }) {
  return (
    <div className="flex min-h-dvh flex-col">
      {usesDevProviders(providers) && <DevBanner />}
      <main className="flex flex-1 items-center justify-center px-4 py-10">
        <div className="w-full max-w-[400px]">
          <div className="mb-8 flex flex-col items-center text-center">
            <LogoMark className="size-12" />
            <h1 className="mt-5 text-2xl font-semibold tracking-tight">{providers.appName}</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Your own AI agent for DeFi — it plans, checks and executes on Uniswap, and asks you
              before anything big.
            </p>
          </div>

          <div className="rounded-xl border border-border bg-card p-6 shadow-2xl shadow-black/30">
            {providers.identity === 'dev' ? (
              <DevSignInForm />
            ) : (
              <Banner tone="info" title="Sign-in unavailable">
                World ID sign-in is not enabled on this server yet.
              </Banner>
            )}
          </div>

          <ul className="mt-8 grid gap-3 sm:grid-cols-3">
            {PILLARS.map((p) => (
              <li key={p.title} className="flex gap-2.5 sm:flex-col sm:items-center sm:text-center">
                <p.icon className="mt-0.5 size-4 shrink-0 text-human sm:mt-0" aria-hidden />
                <div>
                  <p className="text-xs font-medium">{p.title}</p>
                  <p className="mt-0.5 text-xs text-subtle-foreground">{p.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </main>
    </div>
  );
}

function DevSignInForm() {
  const inputId = useId();
  const errorId = useId();
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const signIn = useDevSignIn();

  function onSubmit(e: FormEvent) {
    e.preventDefault();
    const parsed = DisplayNameSchema.safeParse(name);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Enter a name');
      return;
    }
    setError(null);
    signIn.mutate(parsed.data, {
      onSuccess: (res) => toast.success(`Welcome, ${res.user.displayName ?? parsed.data}`),
      onError: (err) =>
        setError(err instanceof ApiError ? err.message : 'Sign-in failed. Please try again.'),
    });
  }

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">Sign in</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Development identity: the same name always signs in as the same human.
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor={inputId}>Your name</Label>
        <Input
          id={inputId}
          name="displayName"
          autoComplete="nickname"
          autoFocus
          placeholder="e.g. alice"
          value={name}
          maxLength={40}
          onChange={(e) => {
            setName(e.target.value);
            if (error) setError(null);
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          disabled={signIn.isPending}
        />
        {error && (
          <p id={errorId} role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}
      </div>
      <Button type="submit" size="lg" className="w-full" disabled={signIn.isPending}>
        {signIn.isPending ? (
          <>
            <Loader2 className="animate-spin" aria-hidden /> Signing in…
          </>
        ) : (
          <>
            Continue (dev identity) <ArrowRight aria-hidden />
          </>
        )}
      </Button>
    </form>
  );
}
