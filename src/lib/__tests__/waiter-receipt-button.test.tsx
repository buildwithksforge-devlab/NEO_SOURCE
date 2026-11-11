// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { SendToPrinterButton } from "@/components/common/SendToPrinterButton";
const m = vi.hoisted(() => ({ waiter: true }));
vi.mock("@/lib/auth", () => ({
  useAuth: () => ({
    organizationId: "org",
    isAdmin: false,
    can: (module: string, feature: string, action: string) =>
      m.waiter && module === "restaurant" && feature === "orders" && action === "create",
  }),
}));
vi.mock("@/lib/printing", () => ({
  usePrintJobDelivery: () => ({ data: null }),
  usePrinters: () => ({ data: [] }),
  useQueuePrint: () => ({ mutate: vi.fn() }),
}));
afterEach(cleanup);
describe("waiter first receipt control", () => {
  it("shows receipt printing for waiter order creators", () => {
    m.waiter = true;
    render(<SendToPrinterButton type="pos_receipt" id="order" label="Print receipt" />);
    expect(screen.getByText("Print receipt")).toBeTruthy();
  });
  it("keeps the action hidden without a print or ordering capability", () => {
    m.waiter = false;
    render(<SendToPrinterButton type="pos_receipt" id="order" label="Print receipt" />);
    expect(screen.queryByText("Print receipt")).toBeNull();
  });
});
