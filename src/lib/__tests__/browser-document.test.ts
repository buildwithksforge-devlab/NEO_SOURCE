// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDocumentPrintWindow } from "../browser-document";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("canonical PDF print preview", () => {
  it("reports a blocked popup without printing the application", () => {
    vi.spyOn(window, "open").mockReturnValue(null);
    const print = vi.spyOn(window, "print").mockImplementation(() => {});
    expect(openDocumentPrintWindow).toThrow(/Allow pop-ups/);
    expect(print).not.toHaveBeenCalled();
  });

  it("prints only the PDF frame and retains its URL through cancelled/repeated dialogs", () => {
    vi.useFakeTimers();
    const page = document.implementation.createHTMLDocument();
    const preview = { document: page, closed: false, close: vi.fn(), opener: window };
    vi.spyOn(window, "open").mockReturnValue(preview as unknown as Window);
    const create = vi.fn(() => "blob:canonical-pdf");
    const revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: create, revokeObjectURL: revoke });
    const handle = openDocumentPrintWindow();
    const blob = new Blob(["%PDF"], { type: "application/pdf" });
    handle.show(blob, "FOL-123.pdf");
    const frame = page.querySelector("iframe")!;
    const print = vi.fn();
    Object.defineProperty(frame, "contentWindow", { value: { focus: vi.fn(), print } });
    frame.dispatchEvent(new Event("load"));
    expect(frame.src).toBe("blob:canonical-pdf");
    expect(print).toHaveBeenCalledTimes(1);
    page.querySelector("button")!.click();
    expect(print).toHaveBeenCalledTimes(2);
    expect(page.querySelector("a")!.download).toBe("FOL-123.pdf");
    expect(preview.opener).toBeNull();
    expect(revoke).not.toHaveBeenCalled();
    preview.closed = true;
    vi.advanceTimersByTime(1000);
    expect(revoke).toHaveBeenCalledWith("blob:canonical-pdf");
    vi.unstubAllGlobals();
  });
});
