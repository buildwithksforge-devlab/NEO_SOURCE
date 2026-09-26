/**
 * Server-only resolver for generic connector secrets.
 *
 * A workspace can choose which connector-specific secret name a gateway uses,
 * but it must never be able to name arbitrary host environment variables such
 * as SUPABASE_SERVICE_ROLE_KEY. Generic connector secrets therefore live in a
 * dedicated NEO_CONNECTOR_* namespace.
 */

const CONNECTOR_SECRET_NAME = /^NEO_CONNECTOR_[A-Z0-9_]{1,80}$/;

export type ConnectorSecretResolution =
  | { status: "none"; value: undefined }
  | { status: "invalid"; value: undefined }
  | { status: "missing"; value: undefined }
  | { status: "ready"; value: string };

export function resolveConnectorSecret(name: string | null | undefined): ConnectorSecretResolution {
  const normalized = String(name ?? "").trim();
  if (!normalized) return { status: "none", value: undefined };
  if (!CONNECTOR_SECRET_NAME.test(normalized)) {
    return { status: "invalid", value: undefined };
  }
  const value = process.env[normalized]?.trim();
  if (!value) return { status: "missing", value: undefined };
  return { status: "ready", value };
}

export function isConnectorSecretName(name: string): boolean {
  const normalized = name.trim();
  return normalized.length === 0 || CONNECTOR_SECRET_NAME.test(normalized);
}
