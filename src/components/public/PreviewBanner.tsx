import { Eye } from "lucide-react";
import { clearPreviewMode, isPreviewMode, PREVIEW_PARAM } from "@/lib/preview-mode";

/**
 * Persistent notice shown at the top of the Guest and Rider experiences while
 * a staff member is previewing them. Preview writes nothing at all — the
 * banner states that plainly rather than relying on disabled buttons.
 */
export function PreviewBanner({ experience }: { experience: "Guest" | "Rider" }) {
  if (!isPreviewMode()) return null;
  return (
    <div
      role="status"
      className="sticky top-0 z-40 flex items-center justify-center gap-2 bg-amber-400 px-3 py-2 text-center text-[0.7rem] font-semibold uppercase tracking-wide text-amber-950"
    >
      <Eye className="size-3.5 shrink-0" aria-hidden />
      <span>
        Preview — no activity will be saved ({experience} experience)
      </span>
      <button
        type="button"
        className="ml-2 rounded-full bg-amber-950/10 px-2 py-0.5 text-[0.65rem] font-semibold normal-case"
        onClick={() => {
          clearPreviewMode();
          const url = new URL(window.location.href);
          url.searchParams.delete(PREVIEW_PARAM);
          window.location.replace(url.toString());
        }}
      >
        Exit preview
      </button>
    </div>
  );
}
