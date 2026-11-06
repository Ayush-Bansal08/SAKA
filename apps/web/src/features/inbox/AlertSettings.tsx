/** Settings (PHASE 08 §5): Telegram connect / mute, per-detector auto-act, time zone. */
import {
  AUTO_ACT_DETECTORS,
  TelegramLinkResponseSchema,
  type AutoActSettings,
  type SettingsResponse,
  type TelegramLinkResponse,
} from '@warden/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, Clock3, ExternalLink, Send, Zap } from 'lucide-react';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Badge, ErrorState, Panel, SkeletonRows, Switch } from '@/components/ui-kit';
import { queryKeys as authKeys } from '@/features/auth/hooks';
import { useOnTraceEvent, useSettings, walletKeys } from '@/features/portfolio/hooks';
import { api, ApiError } from '@/lib/api';
import { AUTO_ACT_COPY, timeZones } from './suggestion-meta';

const LINK_POLL_MS = 3_000;

const message = (err: unknown) =>
  err instanceof ApiError ? err.message : 'That did not go through. Please try again.';

function useSettingsCache() {
  const qc = useQueryClient();
  return {
    patch: (fn: (s: SettingsResponse) => SettingsResponse) =>
      qc.setQueryData<SettingsResponse>(walletKeys.settings, (s) => (s ? fn(s) : s)),
    refresh: () => {
      void qc.invalidateQueries({ queryKey: walletKeys.settings });
      void qc.invalidateQueries({ queryKey: authKeys.me });
    },
  };
}

function TelegramSection({ telegram }: { telegram: SettingsResponse['telegram'] }) {
  const cache = useSettingsCache();
  const [link, setLink] = useState<TelegramLinkResponse | null>(null);

  // The human finishes in Telegram, so the page cannot know when: poll until it lands.
  useQuery({
    queryKey: ['telegram', 'waiting', link?.url],
    enabled: Boolean(link) && !telegram.linked,
    refetchInterval: LINK_POLL_MS,
    queryFn: () => {
      cache.refresh();
      return null;
    },
  });
  useOnTraceEvent(
    (e) => e.kind === 'system' && e.title.startsWith('Telegram'),
    () => cache.refresh(),
  );

  const connect = useMutation({
    mutationFn: () =>
      api('/telegram/link-code', {
        method: 'POST',
        body: {},
        schema: TelegramLinkResponseSchema,
      }),
    onSuccess: (r) => {
      setLink(r);
      window.open(r.url, '_blank', 'noopener');
    },
    onError: (err) => toast.error(message(err)),
  });
  const disconnect = useMutation({
    mutationFn: () =>
      api('/telegram/disconnect', { method: 'POST', body: {}, schema: z.unknown() }),
    onSuccess: () => {
      setLink(null);
      toast.success('Telegram disconnected.');
    },
    onError: (err) => toast.error(message(err)),
    onSettled: cache.refresh,
  });
  const mute = useMutation({
    mutationFn: (muted: boolean) =>
      api('/telegram/mute', { method: 'PUT', body: { muted }, schema: z.unknown() }),
    onMutate: (muted) => cache.patch((s) => ({ ...s, telegram: { ...s.telegram, muted } })),
    onError: (err) => toast.error(message(err)),
    onSettled: cache.refresh,
  });

  if (!telegram.available)
    return (
      <p className="text-sm text-muted-foreground">
        Telegram is not set up on this server. Alerts stay in Autopilot.
      </p>
    );

  if (!telegram.linked)
    return (
      <div className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Get alerts and approval requests on your phone. The bot only sends alerts; everything else
          happens here.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" disabled={connect.isPending} onClick={() => connect.mutate()}>
            <Send aria-hidden /> {link ? 'New link' : 'Connect Telegram'}
          </Button>
          {link && (
            <>
              <Button size="sm" variant="secondary" asChild>
                <a href={link.url} target="_blank" rel="noreferrer">
                  Open Telegram <ExternalLink aria-hidden />
                </a>
              </Button>
              <span className="text-xs text-subtle-foreground" aria-live="polite">
                Waiting for you to press Start… the link works for 10 minutes.
              </span>
            </>
          )}
        </div>
      </div>
    );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-sm font-medium">
            Telegram <Badge tone="safe">Connected</Badge>
          </p>
          {telegram.botUsername && (
            <p className="truncate text-xs text-muted-foreground">@{telegram.botUsername}</p>
          )}
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={disconnect.isPending}
          onClick={() => disconnect.mutate()}
        >
          Disconnect
        </Button>
      </div>
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm">Mute alerts</p>
          <p className="text-xs text-muted-foreground">Autopilot keeps everything.</p>
        </div>
        <Switch
          checked={telegram.muted}
          label="Mute Telegram alerts"
          disabled={mute.isPending}
          onChange={(next) => mute.mutate(next)}
        />
      </div>
    </div>
  );
}

function AutoActSection({ autoAct }: { autoAct: AutoActSettings }) {
  const cache = useSettingsCache();
  const save = useMutation({
    mutationFn: (patch: Partial<AutoActSettings>) =>
      api('/settings/auto-act', { method: 'PUT', body: patch, schema: z.unknown() }),
    onMutate: (patch) => cache.patch((s) => ({ ...s, autoAct: { ...s.autoAct, ...patch } })),
    onError: (err) => toast.error(message(err)),
    onSettled: cache.refresh,
  });
  return (
    <ul className="divide-y divide-border">
      {AUTO_ACT_DETECTORS.map((d) => (
        <li key={d} className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0">
          <div className="min-w-0">
            <p className="text-sm">{AUTO_ACT_COPY[d].label}</p>
            <p className="text-xs text-muted-foreground">{AUTO_ACT_COPY[d].hint}</p>
          </div>
          <Switch
            checked={autoAct[d]}
            label={`Auto-act: ${AUTO_ACT_COPY[d].label}`}
            onChange={(next) => save.mutate({ [d]: next })}
          />
        </li>
      ))}
    </ul>
  );
}

function TimeZoneSection({ timezone }: { timezone: string }) {
  const cache = useSettingsCache();
  const qc = useQueryClient();
  const zones = useMemo(() => timeZones(timezone), [timezone]);
  const save = useMutation({
    mutationFn: (next: string) =>
      api('/settings/timezone', { method: 'PUT', body: { timezone: next }, schema: z.unknown() }),
    onMutate: (next) => cache.patch((s) => ({ ...s, timezone: next })),
    onSuccess: () => toast.success('Time zone saved.'),
    onError: (err) => toast.error(message(err)),
    onSettled: () => {
      cache.refresh();
      void qc.invalidateQueries({ queryKey: walletKeys.portfolio });
      void qc.invalidateQueries({ queryKey: ['triggers'] });
    },
  });
  return (
    <div className="space-y-1.5">
      <label htmlFor="timezone" className="text-sm">
        Your time zone
      </label>
      <select
        id="timezone"
        value={timezone}
        disabled={save.isPending}
        onChange={(e) => save.mutate(e.target.value)}
        className="h-11 w-full rounded-md border border-input bg-surface-2 px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 md:h-10"
      >
        {zones.map((z) => (
          <option key={z} value={z}>
            {z.replace(/_/g, ' ')}
          </option>
        ))}
      </select>
      <p className="text-xs text-muted-foreground">
        Sets your 08:00 morning brief, your DCA runs and when the daily limit resets.
      </p>
    </div>
  );
}

type Section = 'telegram' | 'autoAct' | 'timezone';

/** All three sections by default; Settings and Autopilot each show the ones that belong there. */
export function AlertSettings({
  sections = ['telegram', 'autoAct', 'timezone'],
}: {
  sections?: readonly Section[];
}) {
  const settings = useSettings();
  if (settings.isPending)
    return (
      <Panel title="Alerts" icon={<Bell />}>
        <SkeletonRows rows={2} />
      </Panel>
    );
  if (settings.isError)
    return (
      <Panel title="Alerts" icon={<Bell />}>
        <ErrorState
          className="py-4"
          title="Couldn't load your alert settings"
          description={settings.error.message}
          onRetry={() => void settings.refetch()}
          retrying={settings.isFetching}
        />
      </Panel>
    );
  const s = settings.data;
  return (
    <>
      {sections.includes('telegram') && (
        <Panel title="Alerts" subtitle="Where your agent reaches you" icon={<Bell />}>
          <TelegramSection telegram={s.telegram} />
        </Panel>
      )}
      {sections.includes('autoAct') && (
        <Panel
          title="Auto-act on suggestions"
          subtitle="Under your limits and safety checks, your agent may do these without asking"
          icon={<Zap />}
        >
          <AutoActSection autoAct={s.autoAct} />
          <p className="mt-3 text-xs text-subtle-foreground">
            Hook pools are never rebalanced or exited on their own, whatever is switched on here.
          </p>
        </Panel>
      )}
      {sections.includes('timezone') && (
        <Panel title="Time zone" icon={<Clock3 />}>
          <TimeZoneSection timezone={s.timezone} />
        </Panel>
      )}
    </>
  );
}
