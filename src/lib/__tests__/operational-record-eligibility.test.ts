import { describe, expect, it } from "vitest";

import {
  isOperationallyEnabled,
  operationalOptions,
  operationalSelectionAllowed,
  assertOperationalSelection,
} from "../operational-record-eligibility";

describe("operational record eligibility", () => {

  it("preserves active records", () => {
    expect(
      isOperationallyEnabled({
        id: "active",
        active: true,
        status: "active",
      })
    ).toBe(true);
  });

  it.each([
    "archived",
    "inactive",
    "disabled",
    "retired",
    "deleted",
    "terminated",
    "suspended",
  ])("rejects %s records", status => {
    expect(
      isOperationallyEnabled({ status })
    ).toBe(false);
  });

  it("rejects inactive accounts", () => {
    expect(
      isOperationallyEnabled({
        account_status: "inactive",
        active: true,
      })
    ).toBe(false);
  });

  it("rejects terminated employees", () => {
    expect(
      isOperationallyEnabled({
        employment_status: "terminated",
        active: true,
      })
    ).toBe(false);
  });

  it("rejects archived roles", () => {
    expect(
      isOperationallyEnabled({
        role_status: "archived",
      })
    ).toBe(false);
  });

  it("rejects explicit inactive flags", () => {
    expect(
      isOperationallyEnabled({ active: false })
    ).toBe(false);

    expect(
      isOperationallyEnabled({ is_active: false })
    ).toBe(false);
  });

  it("rejects archived flags", () => {
    expect(
      isOperationallyEnabled({ archived: true })
    ).toBe(false);

    expect(
      isOperationallyEnabled({ is_archived: true })
    ).toBe(false);
  });

  it("rejects archive timestamps", () => {
    expect(
      isOperationallyEnabled({
        archived_at: "2026-11-25T18:00:00Z",
      })
    ).toBe(false);
  });

  it("rejects deletion timestamps", () => {
    expect(
      isOperationallyEnabled({
        deleted_at: "2026-11-25T18:00:00Z",
      })
    ).toBe(false);
  });

  it("rejects invalid records", () => {

    for (const value of [
      null, undefined, false, 1, "active", [],
    ]) {
      expect(
        isOperationallyEnabled(value)
      ).toBe(false);
    }

  });

  it("handles status case and whitespace", () => {
    expect(
      isOperationallyEnabled({
        status: " ARCHIVED ",
      })
    ).toBe(false);
  });

  it("filters operational choices without mutating history", () => {

    const source = [
      { id: "a", active: true },
      { id: "b", active: false },
      { id: "c", status: "archived" },
    ];

    expect(
      operationalOptions(source)
    ).toEqual([source[0]]);

    expect(source).toHaveLength(3);

  });

  it("rejects a stale archived selection", () => {

    expect(
      operationalSelectionAllowed(
        [{ id: "a", status: "archived" }],
        "a",
      )
    ).toBe(false);

  });

  it("rejects selections outside the supplied catalogue", () => {

    expect(
      operationalSelectionAllowed(
        [{ id: "a", active: true }],
        "b",
      )
    ).toBe(false);

  });

  it("allows a valid operational selection", () => {

    expect(() =>
      assertOperationalSelection(
        [{ id: "a", active: true }],
        "a",
      )
    ).not.toThrow();

  });

  it("blocks submission of a stale selection", () => {

    expect(() =>
      assertOperationalSelection(
        [{ id: "a", active: false }],
        "a",
      )
    ).toThrow("unavailable or inactive");

  });

  it("rejects blank selection identifiers", () => {

    expect(
      operationalSelectionAllowed(
        [{ id: "", active: true }],
        "",
      )
    ).toBe(false);

  });

});