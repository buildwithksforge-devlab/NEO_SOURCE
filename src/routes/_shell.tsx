import { createFileRoute, redirect } from "@tanstack/react-router";
import { AppShell } from "@/components/layout/AppShell";
import { supabase } from "@/integrations/supabase/client";

export const Route = createFileRoute("/_shell")({
  // Sessions live in browser storage, so the gate runs client-side only.
  ssr: false,
  beforeLoad: async ({ location }) => {
    const { data, error } = await supabase.auth.getUser();
    if (error || !data.user) {
      // This gate only covers deliberate workspace addresses. The NEØ root "/"
      // is a public route outside this shell, so a signed-out visitor never
      // reaches sign-in just by opening the platform.
      throw redirect({ to: "/auth", search: { redirect: location.href } });
    }
    return { user: data.user };
  },
  component: AppShell,
});
