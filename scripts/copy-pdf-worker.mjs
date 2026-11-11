// Copies the pdf.js worker (legacy build, for older phones) into /public so the browser loads a worker that always
// matches the installed pdfjs-dist version, with no bundler-specific worker config.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "node_modules/pdfjs-dist/legacy/build/pdf.worker.min.mjs");
const target = join(root, "public/pdf.worker.min.mjs");

if (existsSync(source)) {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  console.log("pdf.js worker copied to public/");
} else {
  console.warn("pdfjs-dist is not installed yet; skipped worker copy");
}
