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
export async function uploadAvatarFor(targetUserId: string, file: File): Promise<string> {
  assertImage(file);
  if (!targetUserId) throw new Error("Select the staff member whose photo is being changed.");
  const extension = (file.name.split(".").pop() ?? "jpg").toLowerCase().slice(0, 5);
  const path = `${targetUserId}/${Date.now()}.${extension}`;
  const { error } = await supabase.storage
    .from(AVATAR_BUCKET)
    .upload(path, file, { upsert: true, contentType: file.type });
  if (error) throw new Error(error.message);
  return path;
}

/** Uploads a photo for the signed-in account and returns the stored path. */
export async function uploadAvatar(file: File): Promise<string> {
  assertImage(file);
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error("You must be signed in to change your photo.");
  return uploadAvatarFor(auth.user.id, file);
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
    staleTime: 30 * 60 * 1000,
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
