/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'standalone',
  reactStrictMode: true,
  // pg is a server-only native-ish dependency; keep it external to the bundle.
  serverExternalPackages: ['pg'],
};

export default nextConfig;
