import { fileURLToPath } from "url";
import { dirname } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: __dirname,
  typescript: {
    // !! WARN !!
    // Dangerously allow production builds to successfully complete even if
    // your project has type errors.
    // !! WARN !!
    ignoreBuildErrors: true,
  },
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
          { key: "Origin-Agent-Cluster", value: "?1" },
        ],
      },
      {
        source: "/onnx/:path*",
        headers: [
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
          // Worker and glue scripts change with the app, so browsers revalidate them.
          { key: "Cache-Control", value: "no-cache" },
        ],
      },
      {
        // Model weights and wasm binaries are large and change only with a sherpa upgrade.
        source: "/onnx/:file(.*\\.(?:wasm|data))",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=31536000, immutable",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
