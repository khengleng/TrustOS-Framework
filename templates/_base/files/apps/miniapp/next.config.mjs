/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Nothing from @trustos/config is imported here: that package reads secrets, and a bundler
  // that can see it can inline them. Only NEXT_PUBLIC_* reaches the browser.
  env: {},

  eslint: {
    // Linting runs once over the whole workspace, not twice with a different configuration.
    ignoreDuringBuilds: true,
  },

  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          /*
           * A mini app runs inside the messaging client's WebView, so it must be framable — but
           * only by the platform. `frame-ancestors` is set per deployment because the host
           * differs per platform, and the default here is deliberately restrictive: a mini app
           * that is framable by anyone is a mini app an attacker can wrap.
           */
          {
            key: 'Content-Security-Policy',
            value: `frame-ancestors ${process.env.NEXT_PUBLIC_FRAME_ANCESTORS ?? "'none'"}`,
          },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
};

export default nextConfig;
