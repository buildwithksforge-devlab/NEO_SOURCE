// @vitest-environment jsdom
/**
 * An enquiry that cannot hold its dates cannot become an event, so this covers
 * the three things that broke: blanks reaching a date column, typed answers
 * disappearing when the screen rebuilds, and a record saving without the one
 * detail conversion requires.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

afterEach(() => cleanup());
import { RecordForm, clearFormDraft } from "@/components/events/EventsShared";
import { sanitizeEventValues } from "@/lib/events-data";
import { menuConsumptionReady } from "@/lib/pos-data";

const fields = [
  { name: "contact_name", label: "Contact name", required: true },
  { name: "proposed_date", label: "Proposed date", type: "date" as const },
];

const problem = (v: Record<string, unknown>) =>
  String(v["proposed_date"] ?? "").trim() ? null : "An event date is required.";

describe("enquiry values", () => {
  it("turns a cleared date into a null rather than an empty string", () => {
    expect(sanitizeEventValues({ proposed_date: "", phone: " 0700 ", adults: 3 })).toEqual({
      proposed_date: null,
      phone: "0700",
      adults: 3,
    });
  });
});

describe("enquiry form", () => {
  it("refuses to save without an event date", () => {
    const onSubmit = vi.fn();
    render(<RecordForm fields={fields} submitLabel="Save" validate={problem} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText("Contact name"), { target: { value: "Asha" } });
    fireEvent.click(screen.getByText("Save"));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText("An event date is required.")).toBeTruthy();
  });

  it("restores typed answers when the screen rebuilds underneath the form", () => {
    clearFormDraft("t");
    const first = render(
      <RecordForm fields={fields} submitLabel="Save" draftKey="t" onSubmit={vi.fn()} />,
    );
    fireEvent.change(first.getByLabelText("Proposed date"), { target: { value: "2026-09-25" } });
    first.unmount();

    const second = render(
      <RecordForm fields={fields} submitLabel="Save" draftKey="t" onSubmit={vi.fn()} />,
    );
    expect((second.getByLabelText("Proposed date") as HTMLInputElement).value).toBe("2026-09-25");
    second.unmount();
    clearFormDraft("t");
  });

  it("clears the draft once the record is saved", () => {
    clearFormDraft("t2");
    const onSubmit = vi.fn();
    const view = render(
      <RecordForm fields={fields} submitLabel="Save" draftKey="t2" onSubmit={onSubmit} />,
    );
    fireEvent.change(view.getByLabelText("Contact name"), { target: { value: "Asha" } });
    fireEvent.change(view.getByLabelText("Proposed date"), { target: { value: "2026-09-25" } });
    fireEvent.click(view.getByText("Save"));
    expect(onSubmit).toHaveBeenCalled();
    view.unmount();

    const again = render(
      <RecordForm fields={fields} submitLabel="Save" draftKey="t2" onSubmit={vi.fn()} />,
    );
    expect((again.getByLabelText("Proposed date") as HTMLInputElement).value).toBe("");
  });
});

describe("menu consumption", () => {
  it("counts a direct-from-stock item as configured", () => {
    expect(menuConsumptionReady("direct-stock")).toBe(true);
    expect(menuConsumptionReady("linked")).toBe(true);
    expect(menuConsumptionReady("incomplete")).toBe(false);
    expect(menuConsumptionReady("not-linked")).toBe(false);
  });
});
