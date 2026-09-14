import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  cacheComponents: true,
  cacheHandlers: {
    default: require.resolve('./cache-handler.js'),
    remote: require.resolve('./cache-handler.js'),
  },
  cacheMaxMemorySize: 0,
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
