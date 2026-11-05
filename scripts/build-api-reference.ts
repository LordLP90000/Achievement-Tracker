// The API reference (plan M6): one static HTML page made from the contract.
//   npm run docs:api   →   reports/api-reference/index.html   (CI keeps it as an artifact of every run)
// Redocly's `build-docs` (its options in redocly.yaml) prerenders the page with Redoc, every schema and response
// expanded; that page would load Redoc's script from cdn.redocly.com, and fonts from Google without
// --disableGoogleFont. This script makes it a page that needs neither: it removes every script, links each menu entry
// to its section (the script's job on a click), shows every menu level, and adds a Content-Security-Policy under which
// the page loads nothing at all — whoever opens it runs no code and contacts no third party (R-PRIV-02). It writes no
// page that would still load something, or that misses an operation of the contract.
//   node scripts/build-api-reference.ts <redoc.html> <output.html>
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

const CONTRACT = fileURLToPath(new URL('../openapi/openapi.yaml', import.meta.url));
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'head', 'options', 'trace'] as const;

/** Inline styles and the theme's inline images only: no script, font, stylesheet, frame or connection. */
export const REFERENCE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:";

const HEAD =
  `<meta http-equiv="Content-Security-Policy" content="${REFERENCE_CSP}">` +
  '<style>a.ql-menu-link{display:contents;color:inherit;text-decoration:none}' +
  '[role=menu] ul{display:block!important}</style>';

const SCRIPT = /<script\b[^>]*>[\s\S]*?<\/script\s*>/giu;
const MENU_ENTRY = /(<li\b[^>]*>)(<label\b[^>]*>)([\s\S]*?)<\/label>/gu;
const ITEM_ID = /\sdata-item-id="([^"]+)"/u;

/** Redoc's prerendered page without its scripts, its menu linked to the sections, under a policy that loads nothing. */
export function staticReference(redocPage: string): string {
  if (!redocPage.includes('<head>')) throw new Error('the Redoc page has no <head> for the policy');
  return redocPage
    .replace(SCRIPT, '')
    .replace(MENU_ENTRY, (entry, item: string, label: string, content: string) => {
      const id = ITEM_ID.exec(item)?.[1];
      return id === undefined ? entry : `${item}${label}<a class="ql-menu-link" href="#${id}">${content}</a></label>`;
    })
    .replace('<head>', `<head>${HEAD}`);
}

const ALWAYS_LOADING = /<(?:script|link|iframe|frame|frameset|object|embed|applet|base|portal)\b[^>]*>/giu;
const REFRESH = /<meta\s[^>]*http-equiv\s*=\s*["']?refresh[^>]*>/giu;
const TAG = /<([a-z][\w-]*)\b[^>]*>/giu;
const SOURCE_ATTRIBUTE =
  /\s(src|srcset|href|xlink:href|poster|data|background|action|formaction|ping|manifest|lowsrc|dynsrc|longdesc)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/giu;
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]+))\s*\)/giu;
const CSS_IMPORT = /@import\b[^;]*;?/giu;
/** Elements whose `href` only navigates, and only when clicked. */
const NAVIGATING = new Set(['a', 'area']);

const local = (address: string): boolean => /^\s*(?:#|data:)/iu.test(address);

/** Everything in a page that would make a browser fetch something, as found in the page; empty for a static page. */
export function remoteLoads(page: string): string[] {
  const found = [...page.matchAll(ALWAYS_LOADING), ...page.matchAll(REFRESH)].map(([tag]) => tag);
  for (const [tag, name = ''] of page.matchAll(TAG)) {
    for (const [, attribute = '', double, single, bare] of tag.matchAll(SOURCE_ATTRIBUTE)) {
      const value = double ?? single ?? bare ?? '';
      const navigates = attribute.toLowerCase() === 'href' && NAVIGATING.has(name.toLowerCase());
      if (!navigates && !local(value)) found.push(tag);
    }
  }
  for (const [call, double, single, bare] of page.matchAll(CSS_URL)) {
    if (!local(double ?? single ?? bare ?? '')) found.push(call);
  }
  found.push(...[...page.matchAll(CSS_IMPORT)].map(([rule]) => rule));
  return [...new Set(found)];
}

/** The operation IDs of a contract (OpenAPI YAML). */
export function operationIds(contract: string): string[] {
  const { paths = {} } = parse(contract) as { paths?: Record<string, Record<string, unknown>> };
  return Object.values(paths).flatMap((item) =>
    HTTP_METHODS.flatMap((method) => {
      const id = (item[method] as { operationId?: unknown } | undefined)?.operationId;
      return typeof id === 'string' ? [id] : [];
    }),
  );
}

/** The operations the page lacks a section or a menu link for. */
export function missingOperations(page: string, operations: readonly string[]): string[] {
  return operations.filter((operation) => {
    const target = `tag/[^"/]+/operation/${operation.replace(/[$()*+.?[\\\]^{|}]/gu, '\\$&')}"`;
    return !new RegExp(`\\sid="${target}`, 'u').test(page) || !new RegExp(`\\shref="#${target}`, 'u').test(page);
  });
}

export interface ApiReferenceOptions {
  /** The contract the page must cover (default: openapi/openapi.yaml). */
  readonly contractPath?: string;
}

/** Writes the static page made from Redoc's page, or throws and writes nothing if it is not static and complete. */
export function writeApiReference(redocPagePath: string, outputPath: string, options: ApiReferenceOptions = {}): void {
  const page = staticReference(readFileSync(redocPagePath, 'utf8'));
  const contract = readFileSync(options.contractPath ?? CONTRACT, 'utf8');
  const problems = [
    ...remoteLoads(page).map((load) => `loads ${load}`),
    ...missingOperations(page, operationIds(contract)).map((operation) => `misses ${operation}`),
  ];
  if (problems.length > 0) throw new Error(`the API reference is not static and complete:\n${problems.join('\n')}`);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, page);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [redocPagePath, outputPath] = process.argv.slice(2);
  if (redocPagePath === undefined || outputPath === undefined) {
    throw new Error('usage: node scripts/build-api-reference.ts <redoc.html> <output.html>');
  }
  writeApiReference(redocPagePath, outputPath);
  process.stdout.write(`API reference written to ${outputPath}\n`);
}
