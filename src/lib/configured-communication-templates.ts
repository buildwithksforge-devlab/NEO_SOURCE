/**
 * Configured communication templates → runtime sending path.
 *
 * Administration → Communication lets a hotel brand its guest messaging per
 * channel. Those edits are saved on `organization_settings.communication_templates`.
 * The sending engine, meanwhile, looked only at the `message_templates` table —
 * so a hotel could customise every template and still have the queue fall back
 * to the wording written into the workflow action. This module is the bridge:
 * it turns a configured template into the subject and body the queue sends.
 *
 * Nothing here invents wording. When the hotel has not enabled a template for
 * that key and channel, it returns null and the caller keeps its existing
 * behaviour.
 */

export type ConfiguredTemplate = {
  key: string;
  channel: string;
  subject: string;
  greeting: string;
  body: string;
  signature: string;
  enabled: boolean;
};

export type ComposedMessage = { subject: string | null; body: string };

/** Reads the stored JSON defensively — the column is hotel-editable. */
export function parseConfiguredTemplates(raw: unknown): ConfiguredTemplate[] {
  if (!Array.isArray(raw)) return [];
  const out: ConfiguredTemplate[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const row = entry as Record<string, unknown>;
    const key = typeof row["key"] === "string" ? row["key"] : "";
    const channel = typeof row["channel"] === "string" ? row["channel"] : "";
    const body = typeof row["body"] === "string" ? row["body"] : "";
    if (!key || !channel || !body.trim()) continue;
    out.push({
      key,
      channel,
      subject: typeof row["subject"] === "string" ? row["subject"] : "",
      greeting: typeof row["greeting"] === "string" ? row["greeting"] : "",
      body,
      signature: typeof row["signature"] === "string" ? row["signature"] : "",
      enabled: row["enabled"] !== false,
    });
  }
  return out;
}

export function findConfiguredTemplate(
  templates: ConfiguredTemplate[],
  key: string,
  channel: string,
): ConfiguredTemplate | null {
  if (!key || !channel) return null;
  return templates.find((t) => t.key === key && t.channel === channel && t.enabled) ?? null;
}

/**
 * Greeting, body and sign-off become the message the recipient reads. A
 * channel without subjects (SMS, WhatsApp) keeps a null subject rather than an
 * empty one, so the queue does not show a blank subject line.
 */
export function composeConfiguredMessage(
  template: ConfiguredTemplate,
  render: (text: string) => string,
): ComposedMessage {
  const parts = [template.greeting, template.body, template.signature]
    .map((part) => (part ?? "").trim())
    .filter(Boolean)
    .map(render);
  const subject = template.subject.trim() ? render(template.subject.trim()) : null;
  return { subject, body: parts.join("\n\n") };
}
