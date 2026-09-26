import { createFileRoute, redirect } from "@tanstack/react-router";
import { AppShell } from "@/components/layout/AppShell";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/admin")({
  // Sessions live in browser storage, so the gate runs client-side only —
  // the same contract the operational `_shell` subtree uses.
  ssr: false,
  beforeLoad: async ({ location }) => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      throw redirect({ to: "/auth", search: { redirect: location.href } });
    }
    // The legacy administration hub no longer competes with the Configuration
    // Centre: `/admin` itself is a bookmark-safe redirect into it. Deep
    // `/admin/*` pages keep their URLs and render inside the normal workspace
    // shell, where `RouteAccessGate` enforces their own capability.
    const clean = location.pathname.replace(/\/+$/, "");
    if (clean === "" || clean === "/admin") {
      throw redirect({ to: "/settings" });
    }
    return { user: data.user };
  },
  component: AppShell,
});
