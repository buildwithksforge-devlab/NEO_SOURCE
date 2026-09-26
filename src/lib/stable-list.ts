import { useRef } from "react";

/**
 * Keeps the identity of a derived list stable while its contents are unchanged.
 *
 * Several pickers are fed by queries that refetch in the background — room
 * inventory, room state, staff. Each refetch produces a brand-new array with
 * the same rows, React re-renders the option list, and a click the operator has
 * already begun lands on a node that was replaced mid-gesture, so the selection
 * silently fails while keyboard selection still works. Returning the previous
 * array whenever the content signature matches stops the list being rebuilt for
 * no reason.
 */
export function useStableList<T>(items: T[]): T[] {
  const signature = JSON.stringify(items);
  const held = useRef<{ signature: string; items: T[] }>({ signature, items });
  if (held.current.signature !== signature) held.current = { signature, items };
  return held.current.items;
}
