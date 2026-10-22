/**
 * Supply-chain checks over package.json, package-lock.json and the runtime dependency allowlist in
 * docs/architecture.md §7 (threat T-10, R-SUP-01, R-GMB-05).
 */

const ALLOWLIST_HEADING = '## 7. ';
const NEXT_SECTION = '## ';
const TABLE_ROW_PACKAGE = /^\|\s*`([^`]+)`/;
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[\da-z-]+(?:\.[\da-z-]+)*)?$/i;
const NODE_MODULES = 'node_modules/';
const PAYMENT_PACKAGE =
  /^(?:stripe|@stripe\/.+|paypal.*|@paypal\/.+|braintree.*|adyen.*|@adyen\/.+|@revenuecat\/.+|mollie.*|@mollie\/.+|@klarna\/.+|react-native-iap|in-app-purchase|google-play-billing.*)$/;

/** Package names listed in the first column of the runtime dependency table (architecture §7). */
export function documentedRuntimeDependencies(architectureMarkdown: string): string[] {
  const lines = architectureMarkdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(ALLOWLIST_HEADING));
  if (start === -1) {
    throw new Error('docs/architecture.md has no section 7 with the runtime dependency allowlist');
  }
  const section = lines.slice(start + 1);
  const end = section.findIndex((line) => line.startsWith(NEXT_SECTION));
  return (end === -1 ? section : section.slice(0, end))
    .map((line) => TABLE_ROW_PACKAGE.exec(line)?.[1])
    .filter((name) => name !== undefined);
}

export function undocumentedDependencies(
  dependencies: Readonly<Record<string, string>>,
  documented: readonly string[],
): string[] {
  return Object.keys(dependencies).filter((name) => !documented.includes(name));
}

/** Names whose version is not an exact registry version (ranges, tags, git/file/URL sources, aliases). */
export function inexactVersions(dependencies: Readonly<Record<string, string>>): string[] {
  return Object.entries(dependencies)
    .filter(([, version]) => !EXACT_VERSION.test(version))
    .map(([name]) => name);
}

/** Lockfile paths (`node_modules/…`) whose package is a payment or in-app-purchase SDK. */
export function paymentPackages(lockfilePaths: readonly string[]): string[] {
  return lockfilePaths.filter((path) =>
    PAYMENT_PACKAGE.test(path.slice(path.lastIndexOf(NODE_MODULES) + NODE_MODULES.length)),
  );
}
