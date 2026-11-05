import { supabase } from "@/integrations/supabase/client";
import { guardedRpc } from "@/lib/rpc-guard";

export const STAFF_DEVICE_TOKEN_KEY =
  "neo.staffPinDevice.token";
export const STAFF_DEVICE_META_KEY =
  "neo.staffPinDevice.meta";
export const STAFF_PIN_SESSION_KEY =
  "neo.staffPinSession.v1";

const DEVICE_TOKEN = /^neowd_[0-9a-f]{64}$/;

export type TrustedStaffDevice = {
  deviceId: string;
  branchId: string;
  propertyName: string;
  label: string;
  expiresAt: string;
};

type PairResult = {
  ok?: boolean;
  device_id?: string;
  device_token?: string;
  branch_id?: string;
  property_name?: string;
  label?: string;
  expires_at?: string;
};

type PinLoginResponse = {
  token_hash?: string;
  branch_id?: string;
  error?: string;
  message?: string;
};

function storageAvailable() {
  return typeof window !== "undefined";
}

export function markStaffPinSession() {
  if (!storageAvailable()) return;
  window.sessionStorage.setItem(STAFF_PIN_SESSION_KEY, "1");
}

export function clearStaffPinSession() {
  if (!storageAvailable()) return;
  window.sessionStorage.removeItem(STAFF_PIN_SESSION_KEY);
}

export function isStaffPinSession() {
  if (!storageAvailable()) return false;
  return window.sessionStorage.getItem(STAFF_PIN_SESSION_KEY) === "1";
}

export function readTrustedStaffDevice():
  | TrustedStaffDevice
  | null {
  if (!storageAvailable()) return null;

  try {
    const token =
      window.localStorage.getItem(STAFF_DEVICE_TOKEN_KEY);
    const raw =
      window.localStorage.getItem(STAFF_DEVICE_META_KEY);

    if (!token || !DEVICE_TOKEN.test(token) || !raw) {
      return null;
    }

    const device = JSON.parse(raw) as TrustedStaffDevice;

    if (
      !device.deviceId ||
      !device.branchId ||
      !device.propertyName ||
      !device.label ||
      !device.expiresAt
    ) {
      return null;
    }

    if (Date.parse(device.expiresAt) <= Date.now()) {
      clearTrustedStaffDevice();
      return null;
    }

    return device;
  } catch {
    return null;
  }
}

export function clearTrustedStaffDevice() {
  if (!storageAvailable()) return;

  window.localStorage.removeItem(STAFF_DEVICE_TOKEN_KEY);
  window.localStorage.removeItem(STAFF_DEVICE_META_KEY);
}

export async function pairTrustedStaffDevice(
  branchId: string,
  label: string,
): Promise<TrustedStaffDevice> {
  const { data, error } = await guardedRpc<PairResult>(
    supabase,
    "neo_staff_login_device_pair",
    {
      _branch: branchId,
      _label: label,
    },
  );

  if (error) throw new Error(error.message);

  const token = data?.device_token ?? "";

  if (
    !data?.ok ||
    !DEVICE_TOKEN.test(token) ||
    !data.device_id ||
    !data.branch_id ||
    !data.property_name ||
    !data.label ||
    !data.expires_at
  ) {
    throw new Error(
      "The trusted-device response was incomplete.",
    );
  }

  const device: TrustedStaffDevice = {
    deviceId: data.device_id,
    branchId: data.branch_id,
    propertyName: data.property_name,
    label: data.label,
    expiresAt: data.expires_at,
  };

  // The raw token exists only in this authorised browser. The database stores
  // its SHA-256 hash, and PINs remain server-side inputs only.
  window.localStorage.setItem(STAFF_DEVICE_TOKEN_KEY, token);
  window.localStorage.setItem(
    STAFF_DEVICE_META_KEY,
    JSON.stringify(device),
  );

  return device;
}

export async function revokeTrustedStaffDevice() {
  const device = readTrustedStaffDevice();

  if (!device) {
    clearTrustedStaffDevice();
    return;
  }

  const { error } = await guardedRpc(
    supabase,
    "neo_staff_login_device_revoke",
    { _device: device.deviceId },
  );

  if (error) throw new Error(error.message);

  clearTrustedStaffDevice();
}

export async function signInWithStaffPin(
  pin: string,
): Promise<{ branchId: string }> {
  if (!/^[0-9]{6}$/.test(pin)) {
    throw new Error("Enter your six-digit personal PIN.");
  }

  if (!storageAvailable()) {
    throw new Error(
      "Staff PIN sign-in is unavailable on this device.",
    );
  }

  const token =
    window.localStorage.getItem(STAFF_DEVICE_TOKEN_KEY);

  if (!token || !DEVICE_TOKEN.test(token)) {
    clearTrustedStaffDevice();
    throw new Error(
      "This device has not been authorised for staff PIN sign-in.",
    );
  }

  const result = await fetch("/api/public/staff-pin-login", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ pin }),
  });

  const payload =
    (await result.json().catch(() => ({}))) as PinLoginResponse;

  if (!result.ok) {
    if (payload.error === "device") {
      clearTrustedStaffDevice();
    }

    throw new Error(
      payload.message ??
        "PIN not accepted. Check your PIN or ask your supervisor.",
    );
  }

  if (!payload.token_hash || !payload.branch_id) {
    throw new Error(
      "Staff PIN sign-in returned an incomplete response.",
    );
  }

  const verified = await supabase.auth.verifyOtp({
    token_hash: payload.token_hash,
    type: "magiclink",
  });

  if (verified.error || !verified.data.session) {
    throw new Error(
      "The staff session could not be started. Please try again.",
    );
  }

  markStaffPinSession();

  return { branchId: payload.branch_id };
}