import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,
  // PGlite ships WASM and pg uses native bindings optionally; both must stay external.
  serverExternalPackages: ["@electric-sql/pglite", "pg", "mammoth"],
  // Fonts are read from disk when a value contains characters outside WinAnsi.
  outputFileTracingIncludes: { "/**": ["./assets/fonts/*.ttf"] },
  experimental: { serverActions: { bodySizeLimit: "4mb" } },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      // Signing links carry a bearer token in the path. Never leak it via Referer, never index it.
      {
        source: "/sign/:path*",
        headers: [
          { key: "Referrer-Policy", value: "no-referrer" },
          { key: "X-Robots-Tag", value: "noindex, nofollow" },
          { key: "Cache-Control", value: "no-store" },
        ],
      },
    ];
  },
};

export default nextConfig;
