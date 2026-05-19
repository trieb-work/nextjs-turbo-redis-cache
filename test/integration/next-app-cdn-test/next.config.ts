import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  cacheComponents: true,
  cacheHandlers: {
    default: require.resolve('./cache-handler.js'),
  },
  turbopack: {
    root: __dirname,
  },
  async headers() {
    return [
      {
        // runtime-data-suspense uses cookies → must NOT be CDN-cached
        source: '/cache-lab/runtime-data-suspense',
        headers: [
          {
            key: 'Cache-Control',
            value: 'private, no-store',
          },
        ],
      },
      {
        // All other cache-lab pages: cache indefinitely, rely on explicit purge for invalidation
        source: '/cache-lab/:path*',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, s-maxage=31536000, must-revalidate',
          },
        ],
      },
      {
        source: '/cache-lab',
        headers: [
          {
            key: 'Cache-Control',
            value: 'public, s-maxage=31536000, must-revalidate',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
