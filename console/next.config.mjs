/** @type {import('next').NextConfig} */
const nextConfig = {
  // The read model lives above this directory until the console is extracted
  // into its own repo. Tracing from the repo root so the imported payloads are
  // bundled rather than resolved at runtime.
  outputFileTracingRoot: new URL("..", import.meta.url).pathname,

  // A self-contained server bundle, for the container image. Harmless on
  // Vercel, which ignores it and does its own tracing.
  output: "standalone",
};
export default nextConfig;
