// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDocumentPrintWindow } from "../browser-document";

afterEach(() => {
  document.querySelector('[aria-label="Document print preview"]')?.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("canonical PDF print preview", () => {
  it("shows the PDF in the app without requiring a popup before the export", () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:receipt"), revokeObjectURL: vi.fn() });
    const handle = openDocumentPrintWindow();
    expect(open).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Preparing your document");
    handle.show(new Blob(["%PDF"], { type: "application/pdf" }), "receipt-pos-123.pdf");
    expect(document.querySelector("iframe")?.src).toBe("blob:receipt");
    expect(document.querySelector("a")?.download).toBe("receipt-pos-123.pdf");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Receipt preview");
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Print receipt");
    handle.close();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:receipt");
  });

  it("opens the native PDF viewer from a fresh print click and retains its URL", () => {
    vi.useFakeTimers();
    const viewer = { opener: window, closed: false };
    const open = vi.spyOn(window, "open").mockReturnValue(viewer as unknown as Window);
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:receipt"), revokeObjectURL: vi.fn() });
    const handle = openDocumentPrintWindow();
    handle.show(new Blob(["%PDF"], { type: "application/pdf" }), "receipt-pos-123.pdf");
    const print = Array.from(document.querySelectorAll("button")).find((button) => button.textContent === "Print receipt")!;
    print.click();
    expect(open).toHaveBeenCalledWith("blob:receipt", "_blank");
    expect(viewer.opener).toBeNull();
    handle.close();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    viewer.closed = true;
    vi.advanceTimersByTime(1000);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:receipt");
  });
});
