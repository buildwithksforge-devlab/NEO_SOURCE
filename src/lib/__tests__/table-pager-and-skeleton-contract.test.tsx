// @vitest-environment jsdom
/**
 * Compact table paging and layout-stable skeletons.
 *
 * Paging is presentation only: it never removes rows the account may see, and
 * its controls live under the table inside the same card, so they cannot push
 * into calendar rows or escape the parent surface.
 */
import { readFileSync } from "node:fs";
import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { TablePager, usePagedRows } from "@/components/common/TablePager";
import {
  CardSkeleton,
  SidebarNavSkeleton,
  WorkspaceShellSkeleton,
} from "@/components/common/ShellSkeleton";

afterEach(cleanup);

const rows = Array.from({ length: 120 }, (_, i) => ({ id: i + 1 }));

describe("usePagedRows", () => {
  it("pages without dropping or duplicating any record", () => {
    const { result } = renderHook(() => usePagedRows(rows, 25));
    const seen: number[] = [];
    for (let page = 1; page <= result.current.totalPages; page += 1) {
      act(() => result.current.setPage(page));
      seen.push(...result.current.pageRows.map((r) => r.id));
    }
    expect(result.current.totalPages).toBe(5);
    expect(seen).toEqual(rows.map((r) => r.id));
    expect(new Set(seen).size).toBe(rows.length);
  });

  it("reports an honest range and clamps to the last existing page", () => {
    const { result } = renderHook(() => usePagedRows(rows, 50));
    expect(result.current.from).toBe(1);
    expect(result.current.to).toBe(50);
    act(() => result.current.setPage(3));
    expect(result.current.to).toBe(120);
    act(() => result.current.setPageSize(100));
    expect(result.current.page).toBeLessThanOrEqual(result.current.totalPages);
  });

  it("handles an empty register without a phantom page", () => {
    const { result } = renderHook(() => usePagedRows([], 25));
    expect(result.current.total).toBe(0);
    expect(result.current.from).toBe(0);
    expect(result.current.totalPages).toBe(1);
  });
});

describe("TablePager rendering", () => {
  const base = {
    page: 2,
    totalPages: 5,
    total: 120,
    from: 26,
    to: 50,
    pageSize: 25,
    onPage: () => {},
    onPageSize: () => {},
  };

  it("offers icon-sized previous/next controls and a compact counter", () => {
    render(<TablePager {...base} unit="accounts" />);
    expect(screen.getByLabelText("Previous page")).toBeTruthy();
    expect(screen.getByLabelText("Next page")).toBeTruthy();
    expect(screen.getByText("2 / 5")).toBeTruthy();
    expect(screen.getByLabelText("Rows per page")).toBeTruthy();
  });

  it("cannot overflow its parent card", () => {
    const { container } = render(<TablePager {...base} />);
    const pager = container.querySelector("[data-table-pager]");
    expect(pager?.className).toContain("min-w-0");
    expect(pager?.className).toContain("flex-wrap");
  });

  it("renders nothing when there is nothing to page", () => {
    const { container } = render(<TablePager {...base} total={0} from={0} to={0} totalPages={1} />);
    expect(container.querySelector("[data-table-pager]")).toBeNull();
  });
});

describe("heavy registers use the shared pager", () => {
  for (const file of [
    "src/routes/_shell.finance.ledger.tsx",
    "src/routes/admin.approval-limits.tsx",
  ]) {
    it(`${file} pages and scrolls inside its card`, () => {
      const source = readFileSync(file, "utf8");
      expect(source).toContain("PagedRows");
      expect(source).toContain("TableScroll");
    });
  }
});

describe("layout-stable skeletons", () => {
  it("reserves the real shell geometry while the workspace boots", () => {
    const { container } = render(<WorkspaceShellSkeleton />);
    const shell = container.querySelector('[data-skeleton="workspace-shell"]');
    expect(shell).toBeTruthy();
    expect(shell?.getAttribute("aria-busy")).toBe("true");
    // Same rail token and header height as the live shell → no re-layout.
    expect(container.querySelector(".neo-sidebar-rail")).toBeTruthy();
    expect(container.querySelector(".neo-shell-main")).toBeTruthy();
    expect(container.innerHTML).toContain("h-16");
  });

  it("renders a sidebar rail placeholder in both expanded and collapsed shapes", () => {
    const expanded = render(<SidebarNavSkeleton />).container.innerHTML;
    cleanup();
    const collapsed = render(<SidebarNavSkeleton collapsed />).container.innerHTML;
    expect(expanded).not.toBe(collapsed);
    expect(collapsed).toContain("size-8");
  });

  it("keeps card placeholders on the shared card padding token", () => {
    const { container } = render(<CardSkeleton />);
    const card = container.querySelector('[data-skeleton="card"]');
    expect(card?.className).toContain("neo-card-pad");
    expect(card?.className).toContain("rounded-2xl");
  });

  it("boots the workspace through the shell skeleton rather than a spinner panel", () => {
    const gate = readFileSync("src/components/layout/WorkspaceBootGate.tsx", "utf8");
    expect(gate).toContain("WorkspaceShellSkeleton");
    expect(gate).not.toContain("Loader2");
    const sidebar = readFileSync("src/components/layout/Sidebar.tsx", "utf8");
    expect(sidebar).toContain("SidebarNavSkeleton");
  });
});
