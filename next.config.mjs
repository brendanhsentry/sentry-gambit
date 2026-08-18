/** @type {import('next').NextConfig} */
const nextConfig = {
  async headers() {
    // The Maia model and ONNX runtime never change in place; let browsers keep them.
    return [
      {
        source: "/:prefix(maia3|ort)/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
    ];
  },
};

export default nextConfig;
