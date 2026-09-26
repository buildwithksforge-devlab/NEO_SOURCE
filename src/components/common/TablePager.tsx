import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export const TABLE_PAGE_SIZES = [25, 50, 100] as const;

/**
 * Client-side paging for long finance/admin registers.
 *
 * Paging is presentation only — it never filters, scopes or hides records the
 * account may see; the same rows are simply delivered a page at a time so a
 * 4,000-row ledger cannot stretch a card or push its controls into the rows
 * below it.
 */
export function usePagedRows<T>(rows: readonly T[], initialPageSize = 25) {
  const [pageSize, setPageSize] = useState(initialPageSize);
  const [page, setPage] = useState(1);

  const total = rows.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // A filter or a page-size change must never strand the operator on an empty
  // page that no longer exists.
  useEffect(() => {
    setPage((current) => Math.min(current, Math.max(1, Math.ceil(total / pageSize))));
  }, [total, pageSize]);

  const pageRows = useMemo(() => {
    const start = (page - 1) * pageSize;
    return rows.slice(start, start + pageSize);
  }, [rows, page, pageSize]);

  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);

  return { page, setPage, pageSize, setPageSize, pageRows, totalPages, total, from, to };
}

export type TablePagerProps = {
  page: number;
  totalPages: number;
  total: number;
  from: number;
  to: number;
  pageSize: number;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
  /** Plural noun used in the range summary, e.g. "accounts". */
  unit?: string;
  className?: string;
};

/**
 * Compact, contained pager.
 *
 * Phone — icon-only previous/next with a "3 / 12" counter.
 * Tablet and above — the record range and a page-size selector appear.
 *
 * The whole control is `min-w-0`, wraps within its own row and lives under
 * the table rather than beside it, so it can never overflow the parent card
 * or collide with a calendar row.
 */
export function TablePager({
  page,
  totalPages,
  total,
  from,
  to,
  pageSize,
  onPage,
  onPageSize,
  unit = "records",
  className,
}: TablePagerProps) {
  if (total === 0) return null;

  return (
    <div
      data-table-pager
      className={cn(
        "mt-3 flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-border/70 pt-3",
        className,
      )}
    >
      <p className="min-w-0 truncate text-xs text-muted-foreground">
        <span className="hidden sm:inline">
          Showing {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()} {unit}
        </span>
        <span className="sm:hidden">
          {total.toLocaleString()} {unit}
        </span>
      </p>

      <div className="flex min-w-0 shrink-0 items-center gap-1.5">
        <div className="hidden sm:block">
          <Select value={String(pageSize)} onValueChange={(v) => onPageSize(Number(v))}>
            <SelectTrigger className="h-8 w-[6.5rem]" aria-label="Rows per page">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TABLE_PAGE_SIZES.map((size) => (
                <SelectItem key={size} value={String(size)}>
                  {size} / page
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <Button
          type="button"
          size="icon"
          variant="outline"
          className="size-8 shrink-0"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => onPage(Math.max(1, page - 1))}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <span className="shrink-0 whitespace-nowrap text-xs font-medium tabular-nums text-foreground">
          {page} / {totalPages}
        </span>
        <Button
          type="button"
          size="icon"
          variant="outline"
          className="size-8 shrink-0"
          aria-label="Next page"
          disabled={page >= totalPages}
          onClick={() => onPage(Math.min(totalPages, page + 1))}
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </div>
  );
}

/**
 * Convenience wrapper: paged rows plus the pager, wired in one call.
 */
export function PagedRows<T>({
  rows,
  pageSize = 25,
  unit,
  children,
}: {
  rows: readonly T[];
  pageSize?: number;
  unit?: string;
  children: (pageRows: T[]) => React.ReactNode;
}) {
  const pager = usePagedRows(rows, pageSize);
  return (
    <>
      {children(pager.pageRows)}
      <TablePager
        page={pager.page}
        totalPages={pager.totalPages}
        total={pager.total}
        from={pager.from}
        to={pager.to}
        pageSize={pager.pageSize}
        onPage={pager.setPage}
        onPageSize={pager.setPageSize}
        {...(unit ? { unit } : {})}
      />
    </>
  );
}
