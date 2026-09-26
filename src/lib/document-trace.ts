/**
 * Immutable public trace code for printed documents.
 *
 * A document must always print the same identifier — reprinting never mints a
 * new one. The code is therefore *derived*, not generated: it is a pure
 * function of the organisation, property, document type and the canonical
 * document number that Finance already issued. No database UUID is exposed and
 * no second numbering system is introduced.
 *
 *   SCN-RCP-2026-000123-A7F2
 *   └── canonical document number ──┘ └ checksum of org + property + type
 */

const ALPHABET = "0123456789ABCDEF";

/** FNV-1a — small, stable across runtimes, and not a security primitive. */
function hash(value: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function suffix(value: string): string {
  let h = hash(value);
  let out = "";
  for (let i = 0; i < 4; i += 1) {
    out += ALPHABET[h & 15];
    h >>>= 4;
  }
  return out;
}

export type TraceInput = {
  organizationId?: string | null;
  propertyId?: string | null;
  documentType: string;
  documentNumber?: string | null | undefined;
};

/**
 * Returns the printable trace code, or null when the document has no canonical
 * number yet (an unissued draft prints without a trace code rather than with
 * an invented one).
 */
export function documentTraceCode({
  organizationId,
  propertyId,
  documentType,
  documentNumber,
}: TraceInput): string | null {
  const number = (documentNumber ?? "").trim();
  if (!number) return null;
  const scope = [
    (organizationId ?? "").trim(),
    (propertyId ?? "").trim(),
    documentType.trim().toLowerCase(),
    number.toUpperCase(),
  ].join("|");
  return `SCN-${number.toUpperCase()}-${suffix(scope)}`;
}
