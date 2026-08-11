/** @type {import('next').NextConfig} */
const nextConfig = {
  // The read model lives above this directory until the console is extracted
  // into its own repo. Tracing from the repo root so the imported payloads are
  // bundled rather than resolved at runtime.
  outputFileTracingRoot: new URL("..", import.meta.url).pathname,
};
export default nextConfig;
