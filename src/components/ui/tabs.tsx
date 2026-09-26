import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";

import { cn } from "@/lib/utils";

const Tabs = TabsPrimitive.Root;

type TabsVariant = "segmented" | "underline" | "pill";

const TabsVariantContext = React.createContext<TabsVariant>("segmented");

const LIST_VARIANT: Record<TabsVariant, string> = {
  segmented:
    "neo-segment neo-scroll-x inline-flex h-10 items-center justify-start text-muted-foreground",
  underline:
    "neo-scroll-x flex w-full items-center justify-start gap-1 border-b border-outline-subtle text-muted-foreground",
  pill: "neo-scroll-x inline-flex items-center justify-start gap-1.5 text-muted-foreground",
};

const TRIGGER_VARIANT: Record<TabsVariant, string> = {
  segmented:
    "rounded-full px-3.5 py-1.5 data-[state=active]:bg-chip-selected data-[state=active]:text-chip-selected-foreground data-[state=active]:font-semibold data-[state=active]:shadow-[var(--elevation-1)] hover:text-foreground disabled:data-[state=active]:opacity-70",
  underline:
    "relative px-3 py-2.5 hover:text-foreground data-[state=active]:text-foreground data-[state=active]:after:absolute data-[state=active]:after:inset-x-2 data-[state=active]:after:-bottom-px data-[state=active]:after:h-0.5 data-[state=active]:after:rounded-full data-[state=active]:after:bg-primary",
  pill: "rounded-full border border-outline-subtle bg-chip px-3.5 py-1.5 hover:text-foreground data-[state=active]:border-primary/40 data-[state=active]:bg-chip-selected data-[state=active]:text-chip-selected-foreground data-[state=active]:font-semibold",
};

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> & { variant?: TabsVariant }
>(({ className, variant = "segmented", ...props }, ref) => (
  <TabsVariantContext.Provider value={variant}>
    <TabsPrimitive.List ref={ref} className={cn(LIST_VARIANT[variant], className)} {...props} />
  </TabsVariantContext.Provider>
));
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger> & { variant?: TabsVariant }
>(({ className, variant, ...props }, ref) => {
  const inherited = React.useContext(TabsVariantContext);
  const resolved = variant ?? inherited;
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        "inline-flex items-center justify-center whitespace-nowrap text-sm font-medium ring-offset-background cursor-pointer transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 disabled:cursor-not-allowed",
        TRIGGER_VARIANT[resolved],
        className,
      )}
      {...props}
    />
  );
});
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "mt-2 ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2",
      className,
    )}
    {...props}
  />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsList, TabsTrigger, TabsContent };
