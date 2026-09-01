/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  /**
   * Only NEXT_PUBLIC_* variables reach the browser, and only the API base URL
   * is one. Nothing from @trustsystem/config is imported here: that package reads
   * secrets, and a bundler that can see it can inline them.
   */
  env: {},

  eslint: {
    // Linting is a separate CI step over the whole workspace; running it again
    // during the build would use a different config and report twice.
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
