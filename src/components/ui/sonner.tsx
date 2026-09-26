import { AlertTriangle, CheckCircle2, Info, Loader2, XCircle } from "lucide-react";
import { Toaster as Sonner } from "sonner";

type ToasterProps = React.ComponentProps<typeof Sonner>;

/**
 * NEØ feedback surface. One semantic language for every operation result:
 * success (calm green), warning (amber), error (destructive red), info
 * (brand turquoise) and neutral — each on a rounded, lightly elevated card
 * with an icon, readable foreground and a close affordance. Colours come from
 * theme tokens, so light and dark both stay legible.
 */
const Toaster = ({ ...props }: ToasterProps) => {
  return (
    <Sonner
      className="toaster group"
      position="top-right"
      closeButton
      icons={{
        success: <CheckCircle2 className="size-4 text-success" />,
        warning: <AlertTriangle className="size-4 text-warning" />,
        error: <XCircle className="size-4 text-destructive" />,
        info: <Info className="size-4 text-primary" />,
        loading: <Loader2 className="size-4 animate-spin text-muted-foreground" />,
      }}
      toastOptions={{
        classNames: {
          toast:
            "group toast neo-toast group-[.toaster]:items-start group-[.toaster]:gap-3 group-[.toaster]:rounded-2xl group-[.toaster]:border group-[.toaster]:border-border group-[.toaster]:bg-card group-[.toaster]:p-4 group-[.toaster]:text-foreground group-[.toaster]:shadow-lg",
          title: "group-[.toast]:text-sm group-[.toast]:font-medium",
          description: "group-[.toast]:text-sm group-[.toast]:text-muted-foreground",
          icon: "group-[.toast]:mt-0.5",
          closeButton:
            "group-[.toast]:border-border group-[.toast]:bg-card group-[.toast]:text-muted-foreground hover:group-[.toast]:text-foreground",
          actionButton:
            "group-[.toast]:rounded-lg group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton:
            "group-[.toast]:rounded-lg group-[.toast]:bg-muted group-[.toast]:text-muted-foreground",
          success: "neo-toast-success",
          warning: "neo-toast-warning",
          error: "neo-toast-error",
          info: "neo-toast-info",
        },
      }}
      {...props}
    />
  );
};

export { Toaster };
