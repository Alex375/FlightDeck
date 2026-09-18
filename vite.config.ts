import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @tauri-apps/cli injects TAURI_DEV_HOST when targeting mobile/LAN.
const host = process.env.TAURI_DEV_HOST;

// https://vitejs.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  // Tauri expects a fixed port and fails if it's not available.
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // Don't let Vite watch the Rust crates (their target/ dirs get large).
      ignored: ["**/src-tauri/**", "**/flightdeckd/**"],
    },
  },
}));
