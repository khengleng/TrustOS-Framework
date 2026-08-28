/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Nothing from @trustos/config is imported here: that package reads secrets,
  // and a bundler that can see it can inline them. Only NEXT_PUBLIC_* reaches
  // the browser, and the only one used is the API base URL.
  env: {},

  eslint: {
    // Linting runs once over the whole workspace, not twice with a different
    // configuration.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
