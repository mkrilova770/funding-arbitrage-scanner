import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Playwright must not be bundled by webpack — it uses native Node.js modules
  serverExternalPackages: ["playwright", "playwright-core"],
  // Increase serverless function timeout for external API calls
  experimental: {
    serverActions: {
      bodySizeLimit: "2mb",
    },
  },
  // Allow all external images (not used but good practice)
  images: {
    remotePatterns: [],
  },
};

export default nextConfig;
