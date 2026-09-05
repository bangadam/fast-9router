import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

export default defineConfig({
  plugins: [preact()],
  root: import.meta.dirname,
  base: "./",
  build: {
    outDir: "../public",
    emptyOutDir: true,
  },
});
