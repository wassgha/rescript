import type { NextConfig } from "next";

// Static export for GitHub Pages: set STATIC_EXPORT=1 and (for project pages
// served under /<repo>/) NEXT_PUBLIC_BASE_PATH=/<repo>. Static hosts cannot
// send custom headers, so cross-origin isolation is provided at runtime by
// public/coi-serviceworker.js instead of the headers() below.
const isExport = process.env.STATIC_EXPORT === "1";
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // ESM timeline / CFB helpers and parakeet.js ship modern/raw ESM; transpile for Next's bundler.
  transpilePackages: ["@chatoctopus/timeline", "cfb", "parakeet.js"],
  ...(isExport
    ? {
        output: "export" as const,
        basePath,
        images: { unoptimized: true },
      }
    : {
        // SharedArrayBuffer (required by ffmpeg.wasm multi-threading and
        // onnxruntime multi-threading) is only available in
        // cross-origin-isolated contexts. COEP "credentialless" (rather than
        // "require-corp") keeps the page cross-origin isolated while still
        // allowing third-party scripts like Google Analytics, which don't
        // send Cross-Origin-Resource-Policy headers.
        async headers() {
          return [
            {
              source: "/(.*)",
              headers: [
                { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
                { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
              ],
            },
          ];
        },
      }),
};

export default nextConfig;
