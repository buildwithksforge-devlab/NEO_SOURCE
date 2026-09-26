/**
 * Inspector Sheet — the detail half of a master–detail workspace.
 *
 * Selecting a record opens the inspector beside the list instead of navigating
 * away, so the operator never loses their place, their scroll position or their
 * filters. On a phone the same component covers the screen; on tablet and
 * laptop it is a right-hand panel.
 *
 * Content is grouped into sections (bands with a hairline), not nested cards.
 */
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";

export type InspectorTab = {
  value: string;
  label: string;
  content: ReactNode;
};

export function InspectorSheet({
  open,
  onOpenChange,
  title,
  subtitle,
  media,
  chips,
  tabs,
  defaultTab,
  footer,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  subtitle?: string | undefined;
  /** Object identity: photo, avatar or glyph. */
  media?: ReactNode;
  /** Small state chips shown under the title. */
  chips?: ReactNode;
  /** Optional tabbed body. Ignored when `children` is supplied. */
  tabs?: InspectorTab[];
  defaultTab?: string | undefined;
  footer?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-xl"
      >
        <SheetHeader className="border-b border-outline-subtle p-4 text-left sm:p-5">
          <div className="flex min-w-0 items-start gap-3">
            {media ? <div className="shrink-0">{media}</div> : null}
            <div className="min-w-0">
              <SheetTitle className="neo-line-1 text-base font-semibold">{title}</SheetTitle>
              {subtitle ? (
                <SheetDescription className="neo-contain mt-0.5 text-sm">
                  {subtitle}
                </SheetDescription>
              ) : null}
              {chips ? (
                <div className="mt-2 flex flex-wrap items-center gap-1.5">{chips}</div>
              ) : null}
            </div>
          </div>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {children ? (
            <div className="p-4 sm:p-5">{children}</div>
          ) : tabs && tabs.length > 0 ? (
            <Tabs defaultValue={defaultTab ?? tabs[0]!.value} className="w-full">
              <div className="neo-scroll-x sticky top-0 z-10 border-b border-outline-subtle bg-background/95 px-4 py-2 backdrop-blur sm:px-5">
                <TabsList>
                  {tabs.map((t) => (
                    <TabsTrigger key={t.value} value={t.value}>
                      {t.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </div>
              {tabs.map((t) => (
                <TabsContent key={t.value} value={t.value} className="mt-0 p-4 sm:p-5">
                  {t.content}
                </TabsContent>
              ))}
            </Tabs>
          ) : null}
        </div>

        {footer ? (
          <div
            data-action-cluster
            className="flex flex-wrap items-center justify-end gap-2 border-t border-outline-subtle p-4 sm:p-5"
          >
            {footer}
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

/**
 * A labelled band inside an inspector. Use this instead of another Card so
 * detail panels never read as card-inside-card.
 */
export function InspectorSection({
  title,
  actions,
  children,
  className,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("mb-5 last:mb-0", className)}>
      <div className="mb-2 flex items-center justify-between gap-2 border-b border-outline-subtle pb-1.5">
        <h3 className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          {title}
        </h3>
        {actions}
      </div>
      {children}
    </section>
  );
}

/** Label → value row used inside inspector sections. */
export function InspectorField({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] items-start gap-3 py-1.5 text-sm">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 text-foreground">{children}</span>
    </div>
  );
}
