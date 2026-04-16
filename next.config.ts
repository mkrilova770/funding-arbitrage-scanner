import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
