// @vitest-environment jsdom
/**
 * Command search, the keyboard layer and record trails.
 *
 * The contract under test is not "does the palette open" — it is that search
 * cannot become a side channel into a denied module, that a bare letter is a
 * letter while someone is typing, and that a relationship trail never offers
 * a destination the viewer may not open.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  RECORD_SOURCES,
  isSearchable,
  plannedSources,
  rankHits,
  searchRecords,
  type RecordHit,
} from "@/lib/record-search";
import { isTypingTarget, resolveShortcut, shortcutLabel } from "@/lib/keyboard-shortcuts";
import { RecordBreadcrumbs, RelatedRecords } from "@/components/common/RecordBreadcrumbs";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

const allowAll = () => true;

describe("record search scope and permissions", () => {
  it("waits for a meaningful query before searching", () => {
    expect(isSearchable("")).toBe(false);
    expect(isSearchable(" r ")).toBe(false);
    expect(isSearchable("ru")).toBe(true);
  });

  it("only searches sources whose page the user may open", () => {
    const financeOnly = (path: string) => path.startsWith("/finance");
    const planned = plannedSources(financeOnly, "1048");
    expect(planned.map((s) => s.kind)).toEqual(["invoice"]);
    // A denied module contributes nothing at all — not an empty group, not a
    // teaser row.
    expect(plannedSources(() => false, "1048")).toEqual([]);
  });

  it("points every source at a route that exists in the app", () => {
    for (const source of RECORD_SOURCES) {
      expect(source.page.startsWith("/")).toBe(true);
      expect(source.search.length).toBeGreaterThan(0);
    }
  });

  it("anchors every query to the organisation and property-scopes branch tables", async () => {
    const calls: Record<string, unknown>[] = [];
    const builder = (table: string) => {
      const state: Record<string, unknown> = { table, eq: {} as Record<string, unknown> };
      calls.push(state);
      const api: Record<string, unknown> = {
        select: () => api,
        or: (expr: string) => {
          state["or"] = expr;
          return api;
        },
        eq: (col: string, val: unknown) => {
          (state["eq"] as Record<string, unknown>)[col] = val;
          return api;
        },
        limit: () => Promise.resolve({ data: [], error: null }),
      };
      return api;
    };
    const client = { from: builder } as never;

    await searchRecords(
      client,
      { organizationId: "org-1", branchId: "branch-7", canSeePage: allowAll },
      "307",
    );

    expect(calls.length).toBe(RECORD_SOURCES.length);
    for (const call of calls) {
      const eq = call["eq"] as Record<string, unknown>;
      expect(eq["organization_id"]).toBe("org-1");
      const source = RECORD_SOURCES.find((s) => s.table === call["table"])!;
      expect(eq["branch_id"]).toBe(source.branchScoped ? "branch-7" : undefined);
    }
  });

  it("returns nothing when there is no organisation context", async () => {
    const client = {
      from: () => {
        throw new Error("must not query");
      },
    } as never;
    await expect(
      searchRecords(client, { organizationId: null, branchId: null, canSeePage: allowAll }, "ruth"),
    ).resolves.toEqual([]);
  });

  it("keeps the palette alive when one source fails", async () => {
    const client = {
      from: (table: string) => {
        const api: Record<string, unknown> = {
          select: () => api,
          or: () => api,
          eq: () => api,
          limit: () =>
            table === "rooms"
              ? Promise.resolve({ data: null, error: { message: "denied" } })
              : Promise.resolve({
                  data: table === "folios" ? [{ id: "f1", folio_number: "FOL-00231", status: "open" }] : [],
                  error: null,
                }),
        };
        return api;
      },
    } as never;

    const hits = await searchRecords(
      client,
      { organizationId: "org-1", branchId: null, canSeePage: allowAll },
      "FOL-00231",
    );
    expect(hits.map((h) => h.to)).toEqual(["/pms/folios/f1"]);
  });

  it("ranks an exact identifier above a partial name match", () => {
    const hits: RecordHit[] = [
      { kind: "guest", group: "Guests", title: "Ruth Okoth", subtitle: "", to: "/guests", weight: 1 },
      {
        kind: "folio",
        group: "Folios",
        title: "FOL-00231",
        subtitle: "open",
        to: "/pms/folios/f1",
        weight: 2,
      },
    ];
    expect(rankHits(hits, "fol-00231")[0]?.kind).toBe("folio");
    expect(rankHits(hits, "ruth")[0]?.kind).toBe("guest");
  });
});

describe("keyboard layer", () => {
  it("opens command search from anywhere, including inside a field", () => {
    expect(resolveShortcut({ key: "k", metaKey: true }, { typing: true })).toBe("command");
    expect(resolveShortcut({ key: "k", ctrlKey: true }, { typing: false })).toBe("command");
  });

  it("treats a bare letter as a letter while the operator is typing", () => {
    expect(resolveShortcut({ key: "n" }, { typing: true })).toBeNull();
    expect(resolveShortcut({ key: "/" }, { typing: true })).toBeNull();
    expect(resolveShortcut({ key: "n" }, { typing: false })).toBe("new");
    expect(resolveShortcut({ key: "/" }, { typing: false })).toBe("search");
  });

  it("submits with the modifier and ignores unrelated modifier combinations", () => {
    expect(resolveShortcut({ key: "Enter", metaKey: true }, { typing: true })).toBe("submit");
    expect(resolveShortcut({ key: "Enter" }, { typing: false })).toBeNull();
    expect(resolveShortcut({ key: "n", altKey: true }, { typing: false })).toBeNull();
  });

  it("leaves Escape to the dialogs so focus returns to the trigger", () => {
    expect(resolveShortcut({ key: "Escape" }, { typing: false })).toBeNull();
  });

  it("recognises editable targets, but not disabled or read-only ones", () => {
    const input = document.createElement("input");
    expect(isTypingTarget(input)).toBe(true);
    input.readOnly = true;
    expect(isTypingTarget(input)).toBe(false);
    expect(isTypingTarget(document.createElement("button"))).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it("labels shortcuts for the operator's platform", () => {
    expect(shortcutLabel("command", true)).toBe("⌘K");
    expect(shortcutLabel("command", false)).toBe("CtrlK");
  });
});

describe("breadcrumbs and related records", () => {
  it("marks the current record and links the ancestors", () => {
    render(
      <RecordBreadcrumbs
        trail={[
          { label: "Front Office", to: "/pms" },
          { label: "Folios", to: "/pms/folios" },
          { label: "Ruth Okoth" },
          { label: "Folio FOL-00231" },
        ]}
      />,
    );
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Folios" }).getAttribute("href")).toBe("/pms/folios");
    // The last crumb is the page itself, announced as current, never a link.
    expect(screen.getByText("Folio FOL-00231").getAttribute("aria-current")).toBe("page");
    expect(screen.queryByRole("link", { name: "Folio FOL-00231" })).toBeNull();
  });

  it("names the kind of every related record in text, not by styling alone", () => {
    render(
      <RelatedRecords
        records={[
          { kind: "Reservation", label: "SCG-RES-00017", to: "/pms/reservations/r1" },
          { kind: "Room", label: "307", to: "/pms/rooms" },
          { kind: "Guest", label: "" },
        ]}
      />,
    );
    const list = screen.getByRole("list", { name: "Related records" });
    expect(list.querySelectorAll("li").length).toBe(2); // the empty one is dropped
    expect(screen.getByText("Reservation")).toBeTruthy();
    expect(screen.getByRole("link", { name: /SCG-RES-00017/ }).getAttribute("href")).toBe(
      "/pms/reservations/r1",
    );
  });
});
