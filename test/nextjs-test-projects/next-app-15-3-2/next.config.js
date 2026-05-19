/** @type {import('next').NextConfig} */
const nextConfig = {
  cacheHandler: require.resolve('@trieb.work/nextjs-turbo-redis-cache'),
};

module.exports = nextConfig;
