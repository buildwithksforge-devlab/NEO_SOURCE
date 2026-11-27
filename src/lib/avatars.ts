/**
 * Shared avatar/profile-photo layer for every authenticated account type.
 *
 * Photos live in the private `avatars` storage bucket under `<auth uid>/…`.
 * Only the object path is stored in the database — never a blob — and reads go
 * through short-lived signed URLs so a photo cannot leak across tenants.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export const AVATAR_BUCKET = "avatars";

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = ["image/jpeg", "image/png", "image/webp", "image/gif"];

export function isRemoteUrl(value: string | null | undefined) {
  return Boolean(value && /^https?:\/\//i.test(value));
}

function assertImage(file: File) {
  if (!ALLOWED.includes(file.type)) {
    throw new Error("Use a JPEG, PNG, WebP or GIF image.");
  }
  if (file.size > MAX_BYTES) {
    throw new Error("Image is larger than 5 MB.");
  }
}

/**
 * Uploads a photo into a specific account's folder and returns the stored path.
 *
 * Storage policy decides whether the write is allowed: everybody may write into
 * their own folder, and only a holder of the HR staff-photo permission may
 * write into a colleague's folder inside the same organisation. The UI never
 * grants that authority on its own.
 */
/**
 * Obtain the authenticated account once per upload.
 * Never substitute an anonymous or service-role credential.
 */
async function requireAvatarUser() {

    // NEO_AVATAR_SESSION_INTEGRITY_V1

    const avatarSessionResult = await supabase.auth.getSession();

    if (avatarSessionResult.error) {

      throw new Error(
        "Unable to verify the current session for profile picture upload."
      );

    }

    const avatarSession = avatarSessionResult.data.session;

    if (!avatarSession?.access_token || !avatarSession.user?.id) {

      throw new Error(
        "Your session is unavailable. Sign in again before uploading a profile picture."
      );

    }

    if (
      typeof avatarSession.expires_at === "number" &&
      avatarSession.expires_at <= Math.floor(Date.now() / 1000) + 60
    ) {

      const refreshedAvatarSession =
        await supabase.auth.refreshSession();

      if (
        refreshedAvatarSession.error ||
        !refreshedAvatarSession.data.session?.access_token
      ) {

        throw new Error(
          "Your session could not be refreshed. Sign in again before uploading."
        );

      }

    }

  const { data, error } = await supabase.auth.getUser();

  if (error) {
    throw new Error(
      `Profile photo authentication failed: ${error.message}`
    );
  }

  if (!data.user?.id) {
    throw new Error(
      "You must be signed in to change a profile photo."
    );
  }

  return data.user;
}

/**
 * Storage remains the authoritative permission boundary.
 * Callers cannot grant themselves access to another user.
 */
async function uploadAuthenticatedAvatar(
  targetUserId: string,
  file: File
): Promise<string> {
  assertImage(file);

  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(targetUserId)) {
    throw new Error(
      "A valid staff account must be selected."
    );
  }

  if (file.size <= 0) {
    throw new Error(
      "The selected image is empty."
    );
  }

  const extensions: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
  };

  const extension = extensions[file.type];

  if (!extension) {
    throw new Error(
      "Unsupported profile photo format."
    );
  }

  const path =
    `${targetUserId}/${crypto.randomUUID()}.${extension}`;

  const { error } = await supabase.storage
    .from(AVATAR_BUCKET)
    .upload(path, file, {
      upsert: false,
      contentType: file.type,
    });

  if (error) {
    throw new Error(
      `Profile photo upload failed: ${error.message}`
    );
  }

  return path;
}

export async function uploadAvatarFor(
  targetUserId: string,
  file: File
): Promise<string> {
  assertImage(file);
  await requireAvatarUser();
  return uploadAuthenticatedAvatar(targetUserId, file);
}

export async function uploadAvatar(
  file: File
): Promise<string> {
  assertImage(file);
  const user = await requireAvatarUser();
  return uploadAuthenticatedAvatar(user.id, file);
}

/** Removes a stored photo. Remote URLs are left untouched. */
export async function removeAvatarObject(path: string | null | undefined) {
  if (!path || isRemoteUrl(path)) return;
  await supabase.storage.from(AVATAR_BUCKET).remove([path]);
}

/** Resolves a stored avatar reference into a displayable URL. */
export function useAvatarUrl(path: string | null | undefined) {
  return useQuery({
    queryKey: ["avatar-url", path ?? "none"],
    enabled: Boolean(path),
    staleTime: 20 * 60 * 1000,
    refetchInterval: 25 * 60 * 1000,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      if (!path) return null;
      if (isRemoteUrl(path)) return path;
      const { data, error } = await supabase.storage
        .from(AVATAR_BUCKET)
        .createSignedUrl(path, 60 * 60);
      if (error) return null;
      return data?.signedUrl ?? null;
    },
  });
}

export function initialsFor(name: string | null | undefined) {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
  if (!parts.length) return "—";
  return parts.map((p) => p[0]!.toUpperCase()).join("");
}
