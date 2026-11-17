// Single entry for the plugin loader: plain Node cannot resolve the NodeNext .js -> .ts specifiers
// src uses, so this points at the compiled output. Run `bun run build` before loading the plugin.
export { default } from "./dist/index.js"
