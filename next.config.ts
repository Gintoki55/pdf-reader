/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["unpdf"],  // ← خارج experimental
};

module.exports = nextConfig;