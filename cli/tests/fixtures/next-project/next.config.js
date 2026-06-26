/** @type {import('next').NextConfig} */
const withMDX = require('@next/mdx')();

module.exports = withMDX({
  pageExtensions: ['js', 'jsx', 'ts', 'tsx', 'md', 'mdx'],
  images: {
    domains: ['cdn.example.com'],
  },
  async redirects() {
    return [
      { source: '/old-blog/:slug', destination: '/blog/:slug', permanent: true },
    ];
  },
  env: {
    SITE_NAME: 'My Next Blog',
  },
});
