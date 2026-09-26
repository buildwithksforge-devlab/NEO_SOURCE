// @vitest-environment jsdom
/**
 * Delivery tabs are five distinct pages.
 *
 * The five Delivery routes previously collapsed onto one component because the
 * layout and the index shared a file. This locks the split in: each route file
 * declares its own path, its own component, its own head metadata, and its own
 * hero plus KPI strip. A regression shows up here as two tabs sharing a title
 * or a tab losing its metrics.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const TABS = [
  {
    file: "src/routes/_shell.delivery.index.tsx",
    path: "/_shell/delivery/",
    title: "Delivery control",
    head: "Delivery — NEØ Hospitality OS",
  },
  {
    file: "src/routes/_shell.delivery.tasks.tsx",
    path: "/_shell/delivery/tasks",
    title: "Tasks & Rider Assignments",
    head: "Delivery Tasks & Rider Assignments — NEØ",
  },
  {
    file: "src/routes/_shell.delivery.requisitions.tsx",
    path: "/_shell/delivery/requisitions",
    title: "Requisitions & Supply Needs",
    head: "Delivery Requisitions & Supply Needs — NEØ",
  },
  {
    file: "src/routes/_shell.delivery.maintenance.tsx",
    path: "/_shell/delivery/maintenance",
    title: "Fleet & Equipment Maintenance",
    head: "Delivery Fleet & Equipment Maintenance — NEØ",
  },
  {
    file: "src/routes/_shell.delivery.reports.tsx",
    path: "/_shell/delivery/reports",
    title: "Department Reports",
    head: "Delivery Department Reports — NEØ",
  },
] as const;

const read = (p: string) => readFileSync(p, "utf8");
const sources = new Map(TABS.map((t) => [t.file, read(t.file)]));
const routeTree = read("src/routeTree.gen.ts");

describe("the five Delivery routes are separate pages", () => {
  it.each(TABS)("$path declares its own route and head metadata", (tab) => {
    const src = sources.get(tab.file)!;
    expect(src).toContain(`createFileRoute("${tab.path}")`);
    expect(src).toContain(tab.head);
    expect(routeTree).toContain(tab.path.replace(/\/$/, "") || "/_shell/delivery");
  });

  it("each route renders a different page component", () => {
    const components = TABS.map((tab) => {
      const src = sources.get(tab.file)!;
      const match = src.match(/function ([A-Za-z0-9_]*Page)\s*\(/);
      expect(match, `${tab.file} has no page component`).not.toBeNull();
      return match![1];
    });
    expect(new Set(components).size).toBe(TABS.length);
  });

  it("each tab shows its own hero title", () => {
    const titles = TABS.map((tab) => {
      const src = sources.get(tab.file)!;
      expect(src).toContain("<PageHeader");
      expect(src).toContain(`title="${tab.title}"`);
      return tab.title;
    });
    expect(new Set(titles).size).toBe(TABS.length);
  });

  it("each tab leads with figures built from its own data", () => {
    for (const tab of TABS) {
      const src = sources.get(tab.file)!;
      // Either the legacy KPI grid or the shared Smart Summary Strip, which is
      // the current standard for a figure band that also filters the work.
      const hasFigureBand =
        src.includes("neo-kpi-grid") ||
        src.includes("neo-metric-grid") ||
        src.includes("<SummaryStrip") ||
        src.includes("<RequisitionWorkspace");
      expect(hasFigureBand, `${tab.file} has no lead figures`).toBe(true);
    }
  });


  it("no tab re-exports another tab's component", () => {
    for (const tab of TABS) {
      const src = sources.get(tab.file)!;
      for (const other of TABS) {
        if (other.file === tab.file) continue;
        const moduleId = other.file.replace("src/routes/", "./").replace(/\.tsx$/, "");
        expect(src).not.toContain(moduleId);
      }
    }
  });
});
