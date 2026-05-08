import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  cacheHandler: require.resolve('@trieb.work/nextjs-turbo-redis-cache'),
};

export default nextConfig;
