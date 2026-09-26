/**
 * Files an invoice or credit note with KRA eTIMS.
 *
 * The button only asks the server to file; the fiscal status shown everywhere
 * else comes from the KRA result recorded server-side, never from this click.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { Loader2, Receipt } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { fileTaxDocument } from "@/lib/etims.functions";

type Props = {
  invoiceId?: string | null;
  creditNoteId?: string | null;
  label?: string;
  size?: "sm" | "default";
  variant?: "default" | "outline" | "secondary";
  disabled?: boolean;
};

export function FileWithKraButton({
  invoiceId = null,
  creditNoteId = null,
  label = "File with KRA",
  size = "sm",
  variant = "outline",
  disabled = false,
}: Props) {
  const file = useServerFn(fileTaxDocument);
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async () => file({ data: { invoiceId, creditNoteId } }),
    onSuccess: (result) => {
      if (result.ok) toast.success(result.detail);
      else toast.error(result.detail);
      void queryClient.invalidateQueries({ queryKey: ["finance", "etims"] });
      void queryClient.invalidateQueries({ queryKey: ["finance", "invoices"] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <Button
      size={size}
      variant={variant}
      disabled={disabled || mutation.isPending}
      onClick={() => mutation.mutate()}
    >
      {mutation.isPending ? <Loader2 className="mr-2 size-3.5 animate-spin" /> : <Receipt className="mr-2 size-3.5" />}
      {label}
    </Button>
  );
}
