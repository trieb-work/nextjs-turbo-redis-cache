import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  cacheHandler: require.resolve('@trieb.work/nextjs-turbo-redis-cache'),
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
