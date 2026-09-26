/**
 * A single, honest banner for every AI failure state.
 *
 * The page keeps rendering its deterministic figures; this only explains why
 * generated text is missing, so an AI outage can never blank a screen.
 */
import { Link } from "@tanstack/react-router";
import { AlertTriangle, Settings2 } from "lucide-react";

export type AiStatus = "ok" | "not_configured" | "disabled" | "quota" | "unauthorised" | "unavailable" | string;

const COPY: Record<string, { title: string; body: string }> = {
  not_configured: {
    title: "AI unavailable — no provider configured",
    body: "This workspace has no AI provider key yet, so NEØ is showing deterministic system advisories instead of generated text.",
  },
  disabled: {
    title: "AI unavailable — switched off",
    body: "AI generation is turned off for this workspace. The figures below are unaffected.",
  },
  quota: {
    title: "AI unavailable — provider quota exhausted",
    body: "The configured AI provider reports no remaining credits or has rate-limited this workspace. Add credits or switch provider; all figures below remain live.",
  },
  unauthorised: {
    title: "AI unavailable — key rejected",
    body: "The AI provider rejected the configured key. Update or replace it in AI provider settings.",
  },
  unavailable: {
    title: "AI temporarily unavailable",
    body: "The AI provider could not be reached. Deterministic advisories are shown instead.",
  },
};

export function AiUnavailableBanner({
  status,
  detail,
  showSettingsLink = true,
}: {
  status: AiStatus | null | undefined;
  detail?: string | null | undefined;
  showSettingsLink?: boolean;
}) {
  if (!status || status === "ok") return null;
  const copy = COPY[status] ?? COPY["unavailable"]!;

  return (
    <div
      role="status"
      className="mb-6 flex flex-wrap items-start gap-3 rounded-xl border border-warning/40 bg-warning/10 p-4"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{copy.title}</p>
        <p className="mt-1 text-xs text-muted-foreground">{detail ? detail : copy.body}</p>
      </div>
      {showSettingsLink ? (
        <Link
          to="/admin/ai-provider"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-primary underline"
        >
          <Settings2 className="size-3.5" aria-hidden /> AI provider settings
        </Link>
      ) : null}
    </div>
  );
}
