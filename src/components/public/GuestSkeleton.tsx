/**
 * Loading placeholders that are the same size as what replaces them.
 *
 * A spinner is a smaller element than a list of menu rows, so swapping one for
 * the other moves everything below it. These skeletons reproduce the exact row
 * height, padding and thumbnail box of the real content, and they respect a
 * reduced-motion preference.
 */
export function GuestRowsSkeleton({
  rows = 4,
  label = "Loading",
  withThumb = true,
}: {
  rows?: number;
  label?: string;
  withThumb?: boolean;
}) {
  return (
    <ul className="space-y-2" role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }).map((_, index) => (
        <li
          key={index}
          className="flex items-center gap-3 rounded-xl border border-black/5 p-3"
        >
          {withThumb ? (
            <span className="size-14 shrink-0 animate-pulse rounded-lg bg-black/5 motion-reduce:animate-none" />
          ) : null}
          <span className="min-w-0 flex-1 space-y-2 py-1">
            <span className="block h-4 w-2/5 animate-pulse rounded bg-black/5 motion-reduce:animate-none" />
            <span className="block h-3 w-4/5 animate-pulse rounded bg-black/5 motion-reduce:animate-none" />
          </span>
          <span className="h-4 w-16 animate-pulse rounded bg-black/5 motion-reduce:animate-none" />
        </li>
      ))}
      <span className="sr-only">{label}…</span>
    </ul>
  );
}

/** Same footprint as a loaded card list item. */
export function GuestCardsSkeleton({ cards = 3, label = "Loading" }: { cards?: number; label?: string }) {
  return (
    <ul className="space-y-3" role="status" aria-busy="true" aria-label={label}>
      {Array.from({ length: cards }).map((_, index) => (
        <li key={index} className="rounded-2xl bg-white p-4 shadow-sm">
          <span className="flex items-center justify-between gap-3">
            <span className="min-w-0 flex-1 space-y-2">
              <span className="block h-4 w-1/3 animate-pulse rounded bg-black/5 motion-reduce:animate-none" />
              <span className="block h-3 w-2/3 animate-pulse rounded bg-black/5 motion-reduce:animate-none" />
            </span>
            <span className="h-8 w-20 animate-pulse rounded bg-black/5 motion-reduce:animate-none" />
          </span>
        </li>
      ))}
      <span className="sr-only">{label}…</span>
    </ul>
  );
}
