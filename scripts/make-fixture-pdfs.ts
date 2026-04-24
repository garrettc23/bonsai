/**
 * Converts fixtures/*.md to fixtures/*.pdf using headless Google Chrome.
 * No Puppeteer. No Node. Pure bun + marked + a subprocess.
 *
 * Run once after creating or editing markdown fixtures.
 */
import { marked } from "marked";
import { readdirSync, readFileSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { $ } from "bun";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = join(__dirname, "..", "fixtures");
const CHROME =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const CSS = `
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    max-width: 7.5in;
    margin: 0.5in auto;
    color: #222;
    line-height: 1.45;
    font-size: 10.5pt;
  }
  h1 { font-size: 20pt; margin: 0 0 0.1in 0; border-bottom: 2px solid #333; padding-bottom: 6px; }
  h2 { font-size: 13pt; margin-top: 0.25in; border-bottom: 1px solid #ccc; padding-bottom: 3px; }
  table { border-collapse: collapse; width: 100%; margin: 8px 0; font-size: 9.5pt; }
  th, td { border: 1px solid #bbb; padding: 4px 6px; text-align: left; vertical-align: top; }
  th { background: #f2f2f2; }
  hr { border: none; border-top: 1px solid #999; margin: 0.2in 0; }
  code { background: #f4f4f4; padding: 1px 4px; border-radius: 3px; }
  strong { color: #111; }
  ul { padding-left: 1.3em; }
  em { color: #555; }
`;

function wrapHtml(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${body}</body></html>`;
}

export interface GenerateFixturePdfsOptions {
  /** When true, skip markdown files whose matching PDF already exists. */
  onlyMissing?: boolean;
}

export interface GenerateFixturePdfsResult {
  generated: string[];
  skipped: string[];
}

export async function generateFixturePdfs(
  opts: GenerateFixturePdfsOptions = {},
): Promise<GenerateFixturePdfsResult> {
  const generated: string[] = [];
  const skipped: string[] = [];
  const mdFiles = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".md"));

  for (const name of mdFiles) {
    const src = join(FIXTURES_DIR, name);
    const pdfDst = join(FIXTURES_DIR, name.replace(/\.md$/, ".pdf"));

    if (opts.onlyMissing && existsSync(pdfDst)) {
      skipped.push(name);
      continue;
    }

    // Strip YAML front matter (Chrome doesn't care about md-to-pdf config).
    const raw = readFileSync(src, "utf8").replace(/^---[\s\S]*?---\n/, "");
    const html = wrapHtml(marked.parse(raw) as string);

    // Write a temp HTML file; Chrome prints from file URLs.
    const htmlPath = join(tmpdir(), `bill-agent-${Date.now()}-${name}.html`);
    writeFileSync(htmlPath, html, "utf8");

    await $`${CHROME} --headless --disable-gpu --no-pdf-header-footer --print-to-pdf=${pdfDst} ${`file://${htmlPath}`}`.quiet();
    rmSync(htmlPath, { force: true });
    generated.push(name);
  }

  return { generated, skipped };
}

// Script entry point: convert every markdown fixture, overwriting existing PDFs.
if (import.meta.main) {
  const mdFiles = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".md"));
  if (mdFiles.length === 0) {
    console.error("No .md fixtures found in", FIXTURES_DIR);
    process.exit(1);
  }
  const { generated } = await generateFixturePdfs({ onlyMissing: false });
  for (const name of generated) {
    console.log(`  ${name}  →  ${name.replace(/\.md$/, ".pdf")}`);
  }
  console.log("Done.");
}
