// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StockAwareMenuItem } from "@/components/pos/StockAwareMenuItem";
afterEach(cleanup);
describe("stock explanations before adding to the bill", () => {
  it("shows the exact missing stock explanation without opening item configuration", async () => {
    const add = vi.fn(); const report = vi.fn();
    const detail = "Out of stock: Ginger. Needs 2 g; 0 available in Pastry store.";
    render(<StockAwareMenuItem name="Cookie" disabled={false} checkStock={async () => detail} onAvailable={add} onUnavailable={report}>Cookie</StockAwareMenuItem>);
    fireEvent.click(screen.getByRole("button", { name: "Cookie" }));
    await waitFor(() => expect(report).toHaveBeenCalledWith(detail)); expect(screen.queryByRole("dialog")).toBeNull();
    expect(add).not.toHaveBeenCalled();
  });
  it("opens configuration only after a fresh successful availability check", async () => {
    const add = vi.fn(); const report = vi.fn(); const check = vi.fn().mockResolvedValue(null);
    render(<StockAwareMenuItem name="Cookie" disabled={false} checkStock={check} onAvailable={add} onUnavailable={report}>Cookie</StockAwareMenuItem>);
    fireEvent.click(screen.getByRole("button", { name: "Cookie" }));
    await waitFor(() => expect(add).toHaveBeenCalledOnce());
    expect(check).toHaveBeenCalledOnce(); expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("keeps a manually disabled item blocked even when ingredient stock exists", async () => {
    const add = vi.fn(); const report = vi.fn();
    render(<StockAwareMenuItem name="Cookie" disabled={false} unavailableReason="Marked out of stock" checkStock={async () => null} onAvailable={add} onUnavailable={report}>Cookie</StockAwareMenuItem>);
    fireEvent.click(screen.getByRole("button", { name: "Cookie" }));
    await waitFor(() => expect(report).toHaveBeenCalledWith("Marked out of stock")); expect(add).not.toHaveBeenCalled();
  });
  it("fails closed when stock cannot be checked", async () => {
    const add = vi.fn(); const report = vi.fn();
    render(<StockAwareMenuItem name="Cookie" disabled={false} checkStock={async () => { throw Error('private backend detail'); }} onAvailable={add} onUnavailable={report}>Cookie</StockAwareMenuItem>);
    fireEvent.click(screen.getByRole("button", { name: "Cookie" }));
    await waitFor(() => expect(report).toHaveBeenCalledWith(expect.stringContaining("could not be verified"))); expect(add).not.toHaveBeenCalled();
    expect(screen.queryByText("private backend detail")).toBeNull();
  });
  it("does not make a request or add when the caller lacks permission", () => {
    const add = vi.fn(); const report = vi.fn(); const check = vi.fn();
    render(<StockAwareMenuItem name="Cookie" disabled checkStock={check} onAvailable={add} onUnavailable={report}>Cookie</StockAwareMenuItem>);
    fireEvent.click(screen.getByRole("button", { name: "Cookie" })); expect(check).not.toHaveBeenCalled(); expect(add).not.toHaveBeenCalled();
  });
});
