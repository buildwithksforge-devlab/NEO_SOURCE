import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

export const exportManagementReportPdf = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((input: {
    title: string;
    branchId: string | null;
    from: string;
    to: string;
    paths: string[];
  }) => {
    if (!input.title.trim() || input.title.length > 100) throw new Error("Invalid report title.");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.from) || !/^\d{4}-\d{2}-\d{2}$/.test(input.to)) {
      throw new Error("Invalid report period.");
    }
    if (!input.paths.length || input.paths.length > 80 || input.paths.some((path) => !/^[a-z0-9_.-]+$/.test(path))) {
      throw new Error("Invalid report selection.");
    }
    return input;
  })
  .handler(async ({ data, context }) => {
    const { buildManagementReportPdf } = await import("@/lib/report-pdf.server");
    return buildManagementReportPdf(context.supabase, context.userId, data);
  });
