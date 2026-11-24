import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";

const STORAGE_KEY = "neo.browser-storage-notice.v1";

export function BrowserStorageNotice() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    try {
      setOpen(localStorage.getItem(STORAGE_KEY) !== "essential");
    } catch {
      setOpen(true);
    }
  }, []);

  function keepEssential() {
    try {
      localStorage.setItem(STORAGE_KEY, "essential");
    } catch {
      // Dismiss for this visit when the browser blocks storage.
    }
    setOpen(false);
  }

  return (
    <>
      <button type="button" className="w-fit text-left text-white/75 hover:underline"
        aria-expanded={open} aria-controls={open ? "neo-browser-storage" : undefined}
        onClick={() => setOpen(!open)}>
        Cookie settings
      </button>
      {open && (
        <aside id="neo-browser-storage" aria-label="Cookie settings"
          className="fixed inset-x-4 bottom-4 z-50 mx-auto flex max-w-2xl flex-col gap-3 rounded-xl border border-white/20 bg-[#15191e] p-4 text-sm text-white shadow-xl sm:flex-row sm:items-center"
          style={{ bottom: "max(1rem, env(safe-area-inset-bottom))" }}>
          <p className="leading-relaxed text-white/85">
            NEØ uses essential browser storage to keep you signed in and remember your settings.{" "}
            <Link to="/privacy" className="font-medium text-white underline underline-offset-4">Privacy Policy</Link>
          </p>
          <button type="button" onClick={keepEssential}
            className="min-h-11 shrink-0 rounded-md bg-white px-4 font-semibold text-[#15191e] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white">
            Use essential only
          </button>
        </aside>
      )}
    </>
  );
}
