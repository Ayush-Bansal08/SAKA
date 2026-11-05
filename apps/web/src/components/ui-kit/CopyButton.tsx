import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

export function CopyButton({
  value,
  label = 'Copy',
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(t);
  }, [copied]);

  return (
    <button
      type="button"
      aria-label={copied ? 'Copied' : label}
      title={copied ? 'Copied' : label}
      onClick={async (e) => {
        e.stopPropagation();
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
        } catch {
          toast.error('Could not copy to clipboard');
        }
      }}
      className={cn(
        'inline-flex size-5 items-center justify-center rounded text-subtle-foreground transition-colors hover:text-foreground focus-visible:text-foreground',
        className,
      )}
    >
      {copied ? <Check className="size-3.5 text-safe" /> : <Copy className="size-3.5" />}
    </button>
  );
}
