"use client";

import dynamic from "next/dynamic";
import I18nProvider from "@/components/I18nProvider";

// The editor relies on browser-only APIs (Workers, WebAssembly, WebGPU),
// so it is rendered exclusively on the client.
const Editor = dynamic(() => import("@/components/Editor"), {
  ssr: false,
  loading: () => (
    <div className="flex h-dvh items-center justify-center bg-zinc-50 dark:bg-zinc-950">
      <div className="h-5 w-5 animate-spin rounded-full border-2 border-neutral-500 border-t-transparent dark:border-neutral-400" />
    </div>
  ),
});

export default function Home() {
  return (
    <I18nProvider>
      <Editor />
    </I18nProvider>
  );
}
