// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { webcrypto } from "node:crypto";
import { savePosItemSelection } from "../pos-item-selection";

const selection = {
  organization_id: "hotel",
  order_id: "bill",
  menu_item_id: "chips",
  item_name: "Chips",
  created_by: "waiter",
  quantity: 2,
  unit_price: 200,
  selection_modifiers: [{ group_id: "sauce", option_id: "ketchup" }],
};

describe("POS item selection recovery", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.stubGlobal("crypto", webcrypto);
  });

  it("recovers the saved item and modifiers when the insert response is lost", async () => {
    let saved: { id: string } | null = null;
    const insert = vi.fn(async (row) => {
      saved = { id: row.id };
      throw Error("Connection lost");
    });
    const find = vi.fn(async () => ({ data: saved, error: null }));
    const result = await savePosItemSelection(selection, { insert, find }, sessionStorage);
    expect(find).toHaveBeenCalledWith(result.id);
    expect(insert).toHaveBeenCalledWith({ ...selection, id: result.id });
    expect(sessionStorage.length).toBe(0);
  });

  it("uses the original UUID after a failed recovery read or a catalogue price change", async () => {
    const insert = vi.fn()
      .mockResolvedValueOnce({ data: null, error: { message: "Connection lost" } })
      .mockResolvedValueOnce({ data: null, error: { message: "Duplicate key" } });
    const find = vi.fn().mockRejectedValueOnce(Error("Network unavailable"));
    await expect(savePosItemSelection(selection, { insert, find }, sessionStorage)).rejects.toThrow("Connection lost");
    const firstId = insert.mock.calls[0]?.[0].id;
    find.mockResolvedValueOnce({ data: { id: firstId }, error: null });
    await expect(savePosItemSelection({ ...selection, unit_price: 250 }, { insert, find }, sessionStorage))
      .resolves.toEqual({ id: firstId });
    expect(insert.mock.calls[1]?.[0].id).toBe(firstId);
  });

  it("uses a new identity for a deliberate second addition after confirmation", async () => {
    const insert = vi.fn(async (row) => ({ data: { id: row.id }, error: null }));
    const find = vi.fn();
    const first = await savePosItemSelection(selection, { insert, find }, sessionStorage);
    const second = await savePosItemSelection(selection, { insert, find }, sessionStorage);
    expect(second.id).not.toBe(first.id);
    expect(find).not.toHaveBeenCalled();
  });

  it("rejects an unrelated response and preserves the request for retry", async () => {
    const insert = vi.fn().mockResolvedValue({ data: { id: "wrong-item" }, error: null });
    const find = vi.fn().mockResolvedValue({ data: null, error: null });
    await expect(savePosItemSelection(selection, { insert, find }, sessionStorage)).rejects.toThrow("could not be confirmed");
    expect(sessionStorage.getItem(sessionStorage.key(0)!)).toBe(insert.mock.calls[0]?.[0].id);
  });

  it("does not write when the browser fails to retain the request ID", async () => {
    const insert = vi.fn();
    const storage = {
      ...sessionStorage,
      getItem: () => null,
      setItem: () => { throw Error("Storage blocked"); },
    } as Storage;
    await expect(savePosItemSelection(selection, { insert, find: vi.fn() }, storage)).rejects.toThrow("retain the item request");
    expect(insert).not.toHaveBeenCalled();
  });
});
