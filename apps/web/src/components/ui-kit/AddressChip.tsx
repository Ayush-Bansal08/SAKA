import { explorerAddressUrl, type ChainId } from '@warden/shared';
import { ExternalLink } from 'lucide-react';
import { truncateAddress } from '@/lib/format';
import { cn } from '@/lib/utils';
import { CopyButton } from './CopyButton';

/** Truncated address with copy + explorer link. Full address is in the title and for screen readers. */
export function AddressChip({
  address,
  chainId,
  label,
  className,
}: {
  address: string;
  chainId?: ChainId;
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex max-w-full items-center gap-1 rounded-sm border border-border bg-surface-2 py-0.5 pr-1 pl-2 font-mono text-xs text-foreground/90',
        className,
      )}
      title={address}
    >
      {label && <span className="font-sans text-muted-foreground">{label}</span>}
      <span aria-label={address} className="truncate">
        {truncateAddress(address)}
      </span>
      <CopyButton value={address} label="Copy address" />
      {chainId !== undefined && (
        <a
          href={explorerAddressUrl(chainId, address)}
          target="_blank"
          rel="noreferrer noopener"
          aria-label="View on block explorer"
          title="View on block explorer"
          className="inline-flex size-5 items-center justify-center rounded text-subtle-foreground transition-colors hover:text-foreground"
        >
          <ExternalLink className="size-3.5" />
        </a>
      )}
    </span>
  );
}
