import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The portal is a browser app talking to two services that run elsewhere, so
// both are proxied rather than hard-coded: it keeps the app origin-relative
// (no CORS, no baked-in hostnames) and makes the two dependencies visible in
// one place.
//
//   /api/spec/*    the spec plugin's HTTP facade  (the requirements read model)
//   /api/ground/*  a PROJECT's grounding adapter  (populations for a term)
//
// The second is deliberately a separate origin. spec never queries a project's
// database — the project answers in its own environment and returns counts. The
// proxy makes that boundary visible in the config rather than implied.
export default defineConfig({
  plugins: [react()],
  server: {
    // ⚠ Bind IPv4 explicitly. Vite's default binds ::1 (IPv6 loopback) ONLY, so
    // http://127.0.0.1:5174 is refused while http://localhost:5174 works —
    // whichever your browser resolves to first. `curl localhost` follows the
    // same resolution and reports 200, so the server looks healthy from the
    // terminal while the address people are given does not connect.
    host: "127.0.0.1",
    port: 5174,
    proxy: {
      "/api/spec": {
        target: process.env.SPEC_URL ?? "http://127.0.0.1:8091",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/spec/, ""),
        // LOCAL DEV ONLY. spec refuses a write with no principal rather than
        // attributing it to nobody — an append-only log of anonymous edits is
        // worse than no log. In production the console's gateway injects these;
        // here they come from SPEC_AUTHOR, so every proposal this portal writes
        // still carries a real name.
        configure: (proxy) => {
          const who = process.env.SPEC_AUTHOR ?? "";
          if (!who) return;
          const [sub, email] = who.includes("@") ? [who.split("@")[0], who] : [who, `${who}@local`];
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("x-fastverk-user-sub", sub ?? who);
            proxyReq.setHeader("x-fastverk-user-email", email ?? who);
          });
        },
      },
      "/api/ground": {
        target: process.env.ADAPTER_URL ?? "http://127.0.0.1:3010",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/ground/, "/api/spec"),
        // LOCAL DEV ONLY. The adapter is staff-gated, and the portal runs on a
        // different origin, so its cookies never reach it. Rather than add an
        // auth bypass to the product, this reuses the dev-login path Studio
        // already has (DEV_AUTH_ENABLED, AUTH-66) by attaching the same cookies
        // /dev/login would set.
        //
        // ⛔ It only works when the product has DEV_AUTH_ENABLED on, which
        // AUTH-66 says must never be true outside local development — so this
        // cannot become a way in anywhere real. Set DEV_SESSION to change who
        // the portal acts as.
        configure: (proxy) => {
          const who = process.env.DEV_SESSION;
          if (!who) return;
          const [user, org] = who.split("@");
          proxy.on("proxyReq", (proxyReq) => {
            proxyReq.setHeader("cookie", `studio_dev_user=${user}; studio_dev_org=${org}`);
          });
        },
      },
    },
  },
});
