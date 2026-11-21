import { createFileRoute } from "@tanstack/react-router";
import { PrintersPage } from "./_shell.platform.printers";
export const Route = createFileRoute("/admin/printers")({
  head: () => ({ meta: [{ title: "Printers & Print Queue — Configuration Centre" }] }),
  component: PrintersPage,
});
