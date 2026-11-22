import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

export function LegalPage({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="mx-auto min-h-screen max-w-3xl bg-[#0b0d0f] px-5 py-12 text-[#f4f6f8] sm:px-8 sm:py-16">
      <Link to="/" className="text-sm font-semibold underline underline-offset-4">Back to NEØ</Link>
      <h1 className="mt-8 text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
      <div className="mt-6 space-y-7 leading-relaxed [&_h2]:mb-2 [&_h2]:text-lg [&_h2]:font-semibold">
        {children}
      </div>
    </main>
  );
}
