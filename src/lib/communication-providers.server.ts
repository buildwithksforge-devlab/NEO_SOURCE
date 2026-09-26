/**
 * Outbound delivery adapters (server only).
 *
 * Until now the communication queue looked up a provider and stopped: nothing
 * ever left the building. These adapters perform the real provider call and
 * return a truthful result — a provider reference on success, a classified
 * failure otherwise. Nothing is ever reported as sent without a provider
 * response, and a failure the provider will never accept (a bad address, a
 * rejected sender) is marked permanent so the queue does not retry it forever.
 */

export type SendOutcome =
  | { ok: true; reference: string | null; detail: string }
  | { ok: false; permanent: boolean; code: string; detail: string };

export type OutboundMessage = {
  channel: string;
  recipient: string;
  subject: string | null;
  body: string;
};

/** Per-organisation provider settings held on `provider_connections.configuration`. */
export type ProviderConfiguration = Record<string, unknown>;

/**
 * The workspace's own provider credentials, loaded server-side from
 * `provider_credentials`. Empty when the workspace has not connected its own
 * account, in which case a platform-wide key is used if one exists.
 */
export type ProviderSecrets = Record<string, string>;

function text(config: ProviderConfiguration, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = config[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

/** Normalises a Kenyan-style mobile number to E.164 without inventing a country. */
export function normaliseMsisdn(raw: string, defaultCountryCode: string | null): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("+")) {
    const digits = trimmed.slice(1).replace(/\D/g, "");
    return digits.length >= 9 ? `+${digits}` : null;
  }
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 9) return null;
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  if (!defaultCountryCode) return null;
  const cc = defaultCountryCode.replace(/\D/g, "");
  if (!cc) return null;
  return `+${cc}${digits.replace(/^0+/, "")}`;
}

/** Email through Resend. Requires RESEND_API_KEY and a configured sender. */
export async function sendEmail(
  message: OutboundMessage,
  config: ProviderConfiguration,
  secrets: ProviderSecrets = {},
): Promise<SendOutcome> {
  const apiKey = secrets["api_key"] || process.env["RESEND_API_KEY"];
  if (!apiKey) {
    return {
      ok: false,
      permanent: false,
      code: "provider_credentials_missing",
      detail: "No email provider key is available to this workspace.",
    };
  }
  const fromEmail = text(config, "from_email", "sender_email", "from");
  if (!fromEmail || !looksLikeEmail(fromEmail)) {
    return {
      ok: false,
      permanent: false,
      code: "sender_not_configured",
      detail:
        "No verified sending address is set for this workspace. Set the sender address on the email provider before messages can go out.",
    };
  }
  if (!looksLikeEmail(message.recipient)) {
    return {
      ok: false,
      permanent: true,
      code: "invalid_recipient",
      detail: `"${message.recipient}" is not a usable email address.`,
    };
  }
  const fromName = text(config, "from_name", "sender_name");
  const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail;
  const replyTo = text(config, "reply_to", "reply_to_email");

  let response: Response;
  try {
    response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [message.recipient],
        subject: message.subject ?? "(no subject)",
        html: message.body,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });
  } catch (error) {
    return {
      ok: false,
      permanent: false,
      code: "provider_unreachable",
      detail: error instanceof Error ? error.message : "The email provider could not be reached.",
    };
  }

  const payload = (await response.json().catch(() => null)) as
    | { id?: string; message?: string; name?: string }
    | null;
  if (!response.ok) {
    return {
      ok: false,
      // 4xx other than rate limiting will not succeed on a retry.
      permanent: response.status >= 400 && response.status < 500 && response.status !== 429,
      code: `email_${response.status}`,
      detail: payload?.message ?? `The email provider refused the message (${response.status}).`,
    };
  }
  return { ok: true, reference: payload?.id ?? null, detail: "Accepted by the email provider." };
}

/**
 * SMS through Africa's Talking. Uses the workspace's own account when a
 * manager has saved one, and otherwise falls back to a platform key.
 */
export async function sendSms(
  message: OutboundMessage,
  config: ProviderConfiguration,
  secrets: ProviderSecrets = {},
): Promise<SendOutcome> {
  const apiKey = secrets["api_key"] || process.env["AT_API_KEY"];
  const username = secrets["username"] || process.env["AT_USERNAME"];
  if (!apiKey || !username) {
    return {
      ok: false,
      permanent: false,
      code: "provider_credentials_missing",
      detail: "No SMS provider credentials are available to this workspace.",
    };
  }
  const to = normaliseMsisdn(message.recipient, text(config, "default_country_code") ?? null);
  if (!to) {
    return {
      ok: false,
      permanent: true,
      code: "invalid_recipient",
      detail: `"${message.recipient}" is not a usable mobile number in international format.`,
    };
  }
  const senderId = text(config, "sender_id", "from", "short_code");

  const host =
    username.toLowerCase() === "sandbox"
      ? "https://api.sandbox.africastalking.com"
      : "https://api.africastalking.com";

  const form = new URLSearchParams({ username, to, message: message.body });
  if (senderId) form.set("from", senderId);

  let response: Response;
  try {
    response = await fetch(`${host}/version1/messaging`, {
      method: "POST",
      headers: {
        apiKey,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
  } catch (error) {
    return {
      ok: false,
      permanent: false,
      code: "provider_unreachable",
      detail: error instanceof Error ? error.message : "The SMS provider could not be reached.",
    };
  }

  const payload = (await response.json().catch(() => null)) as {
    SMSMessageData?: { Message?: string; Recipients?: { status?: string; statusCode?: number; messageId?: string }[] };
  } | null;

  if (!response.ok) {
    return {
      ok: false,
      permanent: response.status >= 400 && response.status < 500 && response.status !== 429,
      code: `sms_${response.status}`,
      detail: payload?.SMSMessageData?.Message ?? `The SMS provider refused the message (${response.status}).`,
    };
  }

  const recipient = payload?.SMSMessageData?.Recipients?.[0];
  const status = recipient?.status ?? "";
  // Africa's Talking answers 200 even when it rejects an individual recipient.
  if (!recipient || !/^success$/i.test(status)) {
    const code = recipient?.statusCode ?? 0;
    return {
      ok: false,
      // 4xx-family recipient codes (invalid number, blacklisted) will not change.
      permanent: code >= 400 && code < 500,
      code: `sms_recipient_${code || "unknown"}`,
      detail: status || payload?.SMSMessageData?.Message || "The SMS provider did not accept the recipient.",
    };
  }
  return { ok: true, reference: recipient.messageId ?? null, detail: `Accepted by the SMS provider (${status}).` };
}

/**
 * WhatsApp through the Meta Cloud API. Requires WHATSAPP_TOKEN and
 * WHATSAPP_PHONE_ID. When the workspace has configured an approved template
 * name the message is sent as that template (the only way to open a new
 * conversation); otherwise it is sent as a plain text reply, which Meta only
 * accepts inside an open 24-hour customer window.
 */
export async function sendWhatsApp(
  message: OutboundMessage,
  config: ProviderConfiguration,
  secrets: ProviderSecrets = {},
): Promise<SendOutcome> {
  const token = secrets["token"] || process.env["WHATSAPP_TOKEN"];
  const phoneId = secrets["phone_id"] || process.env["WHATSAPP_PHONE_ID"];
  if (!token || !phoneId) {
    return {
      ok: false,
      permanent: false,
      code: "provider_credentials_missing",
      detail: "No WhatsApp credentials are available to this workspace.",
    };
  }
  const to = normaliseMsisdn(message.recipient, text(config, "default_country_code") ?? null);
  if (!to) {
    return {
      ok: false,
      permanent: true,
      code: "invalid_recipient",
      detail: `"${message.recipient}" is not a usable mobile number in international format.`,
    };
  }

  const templateName = text(config, "template_name", "pin_template", "default_template");
  const language = text(config, "template_language", "language") ?? "en";
  const version = text(config, "api_version") ?? "v21.0";

  const body = templateName
    ? {
        messaging_product: "whatsapp",
        to: to.replace(/^\+/, ""),
        type: "template",
        template: {
          name: templateName,
          language: { code: language },
          components: [{ type: "body", parameters: [{ type: "text", text: message.body }] }],
        },
      }
    : {
        messaging_product: "whatsapp",
        to: to.replace(/^\+/, ""),
        type: "text",
        text: { preview_url: false, body: message.body },
      };

  let response: Response;
  try {
    response = await fetch(`https://graph.facebook.com/${version}/${phoneId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return {
      ok: false,
      permanent: false,
      code: "provider_unreachable",
      detail: error instanceof Error ? error.message : "WhatsApp could not be reached.",
    };
  }

  const payload = (await response.json().catch(() => null)) as {
    messages?: { id?: string }[];
    error?: { message?: string; code?: number };
  } | null;

  if (!response.ok || payload?.error) {
    const code = payload?.error?.code ?? response.status;
    // 131047 is "no open conversation": a template is required, and retrying
    // the same plain message will never succeed.
    const permanent =
      code === 131047 || (response.status >= 400 && response.status < 500 && response.status !== 429);
    return {
      ok: false,
      permanent,
      code: `whatsapp_${code}`,
      detail:
        code === 131047 && !templateName
          ? "WhatsApp refused the message because the customer has no open conversation. Set an approved template name on the WhatsApp provider so messages like this can start one."
          : (payload?.error?.message ?? `WhatsApp refused the message (${response.status}).`),
    };
  }

  return {
    ok: true,
    reference: payload?.messages?.[0]?.id ?? null,
    detail: "Accepted by WhatsApp.",
  };
}

/** Dispatches by channel. An unsupported channel stays queued, never "sent". */
export async function dispatchMessage(
  channel: string,
  message: OutboundMessage,
  config: ProviderConfiguration,
  secrets: ProviderSecrets = {},
): Promise<SendOutcome> {
  if (channel === "email") return sendEmail(message, config, secrets);
  if (channel === "sms") return sendSms(message, config, secrets);
  if (channel === "whatsapp") return sendWhatsApp(message, config, secrets);
  return {
    ok: false,
    permanent: false,
    code: "channel_not_supported",
    detail: `Sending over ${channel} is not wired up yet; the message stays queued.`,
  };
}
