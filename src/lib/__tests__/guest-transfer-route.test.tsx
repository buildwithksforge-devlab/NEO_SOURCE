// @vitest-environment jsdom
import type { ComponentType, ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Route } from "@/routes/guest.$hotelSlug.transport";

const m = vi.hoisted(() => ({
  product: "airport",
  navigate: vi.fn(),
  save: vi.fn(),
  signedIn: true,
}));
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (options: unknown) => ({ options, useParams: () => ({ hotelSlug: "hotel" }), useSearch: () => ({ product: m.product }), useNavigate: () => m.navigate }),
  Link: ({ children }: { children: ReactNode }) => <a href="/guest/hotel">{children}</a>,
}));
vi.mock("@/components/public/GuestScreen", () => ({
  GuestScreen: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  GuestPageIntro: ({ title, children }: { title: string; children: ReactNode }) => <header><h1>{title}</h1>{children}</header>,
  GuestSection: ({ title, children }: { title: string; children: ReactNode }) => <section><h2>{title}</h2>{children}</section>,
}));
vi.mock("@/components/public/GuestSignInPrompt", () => ({ GuestSignInPrompt: ({ title }: { title: string }) => <p>{title}</p> }));
vi.mock("@/components/public/PublicAppShell", () => ({
  useWorkspace: () => ({ organization_id: "org", branch_id: "branch", hotel_name: "Hotel", currency: "KES" }),
  PublicEmptyState: ({ title }: { title: string }) => <p>{title}</p>,
}));
vi.mock("@/lib/public-session", () => ({ useCustomerSession: () => ({ user: m.signedIn ? { id: "guest" } : null, loading: false }) }));
vi.mock("@/lib/guest-app", () => ({ useGuestProfile: () => ({ data: m.signedIn ? { id: "customer" } : null }), useGuestScreenView: () => {} }));
vi.mock("@/lib/public-delivery", () => ({ money: (amount: number, currency: string) => `${currency} ${amount}` }));
vi.mock("@/lib/preview-mode", () => ({ isPreviewMode: () => false }));
vi.mock("@/lib/guest-ordering", () => ({
  useTransportProducts: () => ({ data: [
    { id: "airport", name: "Airport transfer", base_price: 3500, max_passengers: 3 },
    { id: "station", name: "Station transfer", base_price: 3000, max_passengers: 4 },
  ] }),
  useMyTransportRequests: () => ({ data: [] }),
  useRequestTransport: () => ({ mutateAsync: m.save, isPending: false }),
  transportStatusLabels: {},
}));

const Page = (Route as unknown as { options: { component: ComponentType } }).options.component;

beforeEach(() => { vi.clearAllMocks(); m.signedIn = true; m.product = "airport"; });
afterEach(cleanup);

it("uses the current URL after selection and browser navigation", () => {
  const view = render(<Page />);
  expect(screen.getByRole("button", { name: /Airport transfer/ }).getAttribute("aria-pressed")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: /Station transfer/ }));
  expect(m.navigate).toHaveBeenCalledWith({ search: { product: "station" }, hash: "transfer-request", resetScroll: false });
  m.product = "station";
  view.rerender(<Page />);
  expect(screen.getByRole("button", { name: /Station transfer/ }).getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: /Airport transfer/ }).getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Request a custom trip instead" }));
  expect(m.navigate).toHaveBeenLastCalledWith({ search: {}, hash: "transfer-request", resetScroll: false });
});

it("keeps a failed request in the form and confirms only the saved reference", async () => {
  m.save.mockRejectedValueOnce(new Error("Could not save transfer"));
  m.save.mockResolvedValueOnce({ request_number: "TR-001" });
  render(<Page />);
  fireEvent.change(screen.getByLabelText(/Pickup time/), { target: { value: "2090-11-21T15:00" } });
  fireEvent.change(screen.getByLabelText("Pickup point"), { target: { value: "Hotel lobby" } });
  fireEvent.change(screen.getByLabelText("Destination"), { target: { value: "Airport" } });
  fireEvent.click(screen.getByRole("button", { name: "Send request" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Could not save transfer");
  expect(screen.queryByText(/Transfer requested/)).toBeNull();
  expect((screen.getByLabelText("Pickup point") as HTMLInputElement).value).toBe("Hotel lobby");
  fireEvent.click(screen.getByRole("button", { name: "Send request" }));
  await waitFor(() => expect(screen.getByText(/Transfer requested.*TR-001/)).toBeTruthy());
  expect(m.save).toHaveBeenLastCalledWith(expect.objectContaining({ productId: "airport", pickupPoint: "Hotel lobby" }));
});

it("shows the sign-in prompt before exposing request controls", () => {
  m.signedIn = false;
  render(<Page />);
  expect(screen.getByText("Sign in to request transport")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Send request" })).toBeNull();
});
