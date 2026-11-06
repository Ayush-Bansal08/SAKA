import { cva } from 'class-variance-authority';

/** Heights are 44px under `md` so every button is a comfortable touch target. */
export const buttonVariants = cva(
  'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap rounded-full text-sm font-medium transition-[background-color,border-color,color,opacity] duration-150 ease-out outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/85',
        secondary:
          'surface-highlight border border-border bg-secondary text-secondary-foreground hover:border-border-strong hover:bg-surface-3',
        outline:
          'border border-border-strong bg-transparent text-foreground hover:bg-surface-2 hover:border-border-strong',
        ghost: 'text-muted-foreground hover:bg-surface-2 hover:text-foreground',
        destructive: 'bg-destructive text-destructive-foreground hover:bg-destructive/90',
        link: 'text-foreground underline-offset-4 hover:underline',
        iconPill:
          'surface-highlight border border-border-strong bg-surface-2/60 text-foreground hover:bg-surface-3',
      },
      size: {
        default: 'h-11 px-5 md:h-10',
        sm: 'h-11 px-4 text-xs md:h-8 md:px-3.5',
        lg: 'h-12 px-7',
        icon: 'size-11 md:size-9',
      },
    },
    compoundVariants: [
      { variant: 'iconPill', class: 'pr-5 pl-1.5' },
      { variant: 'iconPill', size: 'sm', class: 'pr-3.5 pl-1 md:pr-3.5 md:pl-1' },
    ],
    defaultVariants: { variant: 'default', size: 'default' },
  },
);
