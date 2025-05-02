const { join } = require('path');

/** @type {import('next').NextConfig} */
const nextConfig = {
  cacheHandler: require.resolve('@trieb.work/nextjs-turbo-redis-cache'),
  // cacheHandler: require.resolve('./simple-cache-handler'),
};

module.exports = nextConfig;
