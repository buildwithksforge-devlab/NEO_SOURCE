import type { Json, TablesInsert } from "@/integrations/supabase/types";

type Selection = TablesInsert<"pos_order_items"> & { selection_modifiers: Json[] };
type SavedItem = { id: string };
type WriteResult = { data: SavedItem | null; error: unknown };
type SelectionCommands = {
  insert: (row: Selection & SavedItem) => PromiseLike<WriteResult>;
  find: (id: string) => PromiseLike<WriteResult>;
};

const requestId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export async function savePosItemSelection(
  selection: Selection,
  commands: SelectionCommands,
  storage: Storage,
): Promise<SavedItem> {
  const bytes = new TextEncoder().encode(JSON.stringify([
    selection.organization_id,
    selection.created_by,
    selection.order_id,
    selection.menu_item_id,
    selection.quantity,
    selection.course,
    selection.special_instructions,
    selection.allergy_note,
    selection.selection_modifiers,
  ]));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const fingerprint = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const slot = `neo:pos-item:${fingerprint}`;
  let id: string;
  try {
    id = storage.getItem(slot) ?? crypto.randomUUID();
    if (!requestId.test(id)) throw new Error("Invalid request ID");
    // Store only the UUID. Kitchen instructions and allergy notes stay out of browser storage.
    storage.setItem(slot, id);
    if (storage.getItem(slot) !== id) throw new Error("Request ID could not be retained");
  } catch {
    throw new Error("This browser could not retain the item request. Check browser storage before adding it.");
  }

  const confirmSaved = (saved: SavedItem) => {
    try {
      if (storage.getItem(slot) === id) storage.removeItem(slot);
    } catch {
      // The item is already saved. If the same ID survives, a later retry can recover it.
    }
    return saved;
  };

  let writeError: unknown;
  try {
    const { data, error } = await commands.insert({ ...selection, id });
    if (!error && data?.id === id) return confirmSaved(data);
    writeError = error;
  } catch (error) {
    writeError = error;
  }

  // Inserts use the primary key and the existing atomic modifier triggers.
  // Resolve an ambiguous response without updating a collected bill or its modifiers.
  try {
    const { data, error } = await commands.find(id);
    if (!error && data?.id === id) return confirmSaved(data);
  } catch {
    // Keep the same request ID when both the insert response and recovery read fail.
  }
  if (writeError && typeof writeError === "object" && "message" in writeError &&
      typeof writeError.message === "string") {
    throw new Error(writeError.message);
  }
  throw new Error("The saved item could not be confirmed. Check the bill or retry the same selection.");
}
