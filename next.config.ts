import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
   serverExternalPackages: ["unpdf"],
  },
};

export default nextConfig;
