import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex min-w-0 max-w-full items-center overflow-hidden text-ellipsis whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 [&>span]:truncate",
  {
    variants: {
      variant: {
        // Soft is the house default: tinted surface, document-contrast text.
        default: "border-transparent bg-chip text-chip-foreground",
        soft: "border-transparent bg-chip text-chip-foreground",
        brand: "border-primary/30 bg-primary-soft text-chip-selected-foreground",
        // Metadata labels stay tinted, never a solid dark slab.
        secondary: "border-outline-subtle bg-chip text-chip-foreground",
        // Guest distinction (VIP, loyalty tier) — champagne tint, readable both themes.
        vip: "border-accent/35 bg-tint-accent text-on-tint-accent",
        selected: "border-primary/35 bg-chip-selected text-chip-selected-foreground",
        success: "border-transparent bg-tint-success text-on-tint-success",
        warning: "border-transparent bg-tint-warning text-on-tint-warning",
        info: "border-transparent bg-tint-info text-on-tint-info",
        destructive: "border-transparent bg-tint-destructive text-on-tint-destructive",
        outline: "border-outline-subtle text-foreground",
        "outline-quiet": "border-outline-subtle text-muted-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
