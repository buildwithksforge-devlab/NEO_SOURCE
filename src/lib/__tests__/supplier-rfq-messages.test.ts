import { describe, expect, it } from "vitest";

import {
  validateSupplierMessage,
  assertSupplierMessageResult,
  parseSupplierMessages,
} from "../supplier-rfq-messages";

describe("supplier RFQ communications", () => {

  it("accepts a valid message", () => {
    expect(
      validateSupplierMessage("Can you deliver tomorrow?")
    ).toBe("Can you deliver tomorrow?");
  });

  it("normalizes surrounding whitespace", () => {
    expect(
      validateSupplierMessage("  Available  ")
    ).toBe("Available");
  });

  it("rejects blank messages", () => {
    expect(() =>
      validateSupplierMessage("   ")
    ).toThrow();
  });

  it("rejects excessive messages", () => {
    expect(() =>
      validateSupplierMessage("a".repeat(4001))
    ).toThrow();
  });

  it("accepts the maximum message length", () => {
    expect(
      validateSupplierMessage("a".repeat(4000))
    ).toHaveLength(4000);
  });

  it("requires a confirmed message identity", () => {
    expect(() =>
      assertSupplierMessageResult({
        ok:true
      })
    ).toThrow();
  });

  it("accepts a confirmed transaction", () => {
    expect(
      assertSupplierMessageResult({
        ok:true,
        message_id:"message-1",
      })
    ).toBe("message-1");
  });

  it("does not interpret a failed query as empty history", () => {
    expect(() =>
      parseSupplierMessages(null)
    ).toThrow();
  });

  it("accepts an empty confirmed conversation", () => {
    expect(
      parseSupplierMessages([])
    ).toEqual([]);
  });

  it("rejects unknown sender types", () => {
    expect(() =>
      parseSupplierMessages([
        {
          id:"message-1",
          sender_type:"unknown",
          message_body:"Test",
          created_at:"2026-11-26T10:00:00Z",
        },
      ])
    ).toThrow();
  });

  it("preserves legitimate supplier messages", () => {
    expect(
      parseSupplierMessages([
        {
          id:"message-1",
          sender_type:"supplier",
          message_body:"We have ten cartons.",
          created_at:"2026-11-26T10:00:00Z",
        },
      ])[0]?.message_body
    ).toBe("We have ten cartons.");
  });

});