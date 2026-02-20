/** @type {import('next').NextConfig} */
const nextConfig = {
  // Output standalone build for Docker deployment
  // This bundles all dependencies into a single folder for minimal image size
  output: 'standalone',

  // Serve the app under /meet so it can sit behind a reverse proxy
  basePath: '/meet',

  // Allow Google profile images in next/image
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'lh3.googleusercontent.com',
        pathname: '/**',
      },
    ],
  },

  // Security headers applied to all routes
  // These complement Nginx headers and provide defense-in-depth
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          // Prevent clickjacking by disallowing iframe embedding
          { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
          // Prevent MIME type sniffing attacks
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          // Control what information is sent in Referer headers
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          // Permissions Policy: only allow camera/microphone on same origin
          // Critical for a video conferencing app
          {
            key: 'Permissions-Policy',
            value: 'camera=(self), microphone=(self), geolocation=()',
          },
        ],
      },
    ];
  },
};

module.exports = nextConfig;
