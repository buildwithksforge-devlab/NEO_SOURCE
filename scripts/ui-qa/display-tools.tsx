import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  createRootRoute,
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import "../../src/styles.css";
import { SharedDisplayTools } from "../../src/components/kitchen/SharedDisplayTools";
function Screen() {
  const [station, setStation] = useState("all"),
    [compact, setCompact] = useState(false),
    [exited, setExited] = useState(false);
  return (
    <main className={`min-h-dvh bg-background text-foreground ${compact ? "p-2" : "p-4"}`}>
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm text-muted-foreground">
            Synthetic property — no operational connection
          </p>
          <h1 className="text-2xl font-semibold">Kitchen display</h1>
        </div>
        <div className="flex flex-wrap gap-2">
          <SharedDisplayTools
            stations={[
              { id: "kitchen", name: "Hot Kitchen" },
              { id: "pastry", name: "Pastry" },
            ]}
            station={station}
            onStationChange={setStation}
            compact={compact}
            onCompactChange={setCompact}
            onLogout={() => setExited(true)}
          />
        </div>
      </header>
      <section className="mt-6 rounded-xl border p-5">
        <p>View: {station}</p>
        <p>Compact spacing: {compact ? "on" : "off"}</p>
        <p role="status">{exited ? "Fixture logout selected" : "Display remains open"}</p>
      </section>
    </main>
  );
}
const root = createRootRoute({ component: Screen });
const router = createRouter({
  routeTree: root,
  history: createMemoryHistory({ initialEntries: ["/"] }),
});
createRoot(document.getElementById("root")!).render(<RouterProvider router={router} />);
