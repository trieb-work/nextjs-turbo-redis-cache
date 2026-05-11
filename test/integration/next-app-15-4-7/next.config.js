/** @type {import('next').NextConfig} */
const nextConfig = {
  cacheHandler: require.resolve('@trieb.work/nextjs-turbo-redis-cache'),
  turbopack: {
    root: __dirname,
  },
};

module.exports = nextConfig;
