/** @type {import('next').NextConfig} */
const nextConfig = {
  cacheHandler: require.resolve('./customized-cache-handler'),
};

module.exports = nextConfig;
