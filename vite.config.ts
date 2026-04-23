import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  base: "./",
  plugins: [react()],
  build: {
    chunkSizeWarningLimit: 750,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (
            id.includes("node_modules/@codemirror") ||
            id.includes("node_modules/@lezer") ||
            id.includes("node_modules/@uiw")
          ) {
            return "editor";
          }

          if (id.includes("node_modules")) {
            return "vendor";
          }
        },
      },
    },
  },
});
