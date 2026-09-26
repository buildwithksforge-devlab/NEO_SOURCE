/**
 * Menu item photographs.
 *
 * Images are managed in NEØ after the structured data arrives by file import —
 * a spreadsheet can never carry a usable local file path. Objects live in the
 * private `menu-images` bucket under `<organisation>/…` and are displayed
 * through short-lived signed URLs, so a photo never leaks across tenants.
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export const MENU_IMAGE_BUCKET = "menu-images";

const MAX_BYTES = 5 * 1024 * 1024;
const ALLOWED = ["image/jpeg", "image/png", "image/webp"];

export function isRemoteUrl(value: string | null | undefined) {
  return Boolean(value && /^https?:\/\//i.test(value));
}

/** Uploads a menu photo for one organisation and returns the stored path. */
export async function uploadMenuImage(organizationId: string, file: File): Promise<string> {
  if (!organizationId) throw new Error("No organisation is active.");
  if (!ALLOWED.includes(file.type)) throw new Error("Use a JPEG, PNG or WebP image.");
  if (file.size > MAX_BYTES) throw new Error("Image is larger than 5 MB.");
  const extension = (file.name.split(".").pop() ?? "jpg").toLowerCase().slice(0, 5);
  const path = `${organizationId}/${crypto.randomUUID()}.${extension}`;
  const { error } = await supabase.storage
    .from(MENU_IMAGE_BUCKET)
    .upload(path, file, { upsert: true, contentType: file.type });
  if (error) throw new Error(error.message);
  return path;
}

/** Removes a stored menu photo. Remote URLs are left untouched. */
export async function removeMenuImage(path: string | null | undefined) {
  if (!path || isRemoteUrl(path)) return;
  await supabase.storage.from(MENU_IMAGE_BUCKET).remove([path]);
}

/** Resolves a stored menu image reference into a displayable URL. */
export function useMenuImageUrl(path: string | null | undefined) {
  return useQuery({
    queryKey: ["menu-image-url", path ?? "none"],
    enabled: Boolean(path),
    staleTime: 30 * 60 * 1000,
    queryFn: async () => {
      if (!path) return null;
      if (isRemoteUrl(path)) return path;
      const { data, error } = await supabase.storage
        .from(MENU_IMAGE_BUCKET)
        .createSignedUrl(path, 60 * 60);
      if (error) return null;
      return data?.signedUrl ?? null;
    },
  });
}
