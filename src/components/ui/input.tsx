import * as React from "react";

import { cn } from "@/lib/utils";

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          // Shared field appearance for every form in every app: a calm
          // resting state, a visible hover, and an unmistakable focus ring.
          // Heights are unchanged so dense operational tables keep their
          // density.
          "flex h-9 w-full [@media(pointer:coarse)]:h-11 rounded-lg border border-input bg-transparent px-3 py-1 text-base shadow-sm transition-[color,background-color,border-color,box-shadow] file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground hover:border-ring/45 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/35 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm",
          className,
        )}
        ref={ref}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

export { Input };
