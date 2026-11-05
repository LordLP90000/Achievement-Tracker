import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  missingOperations,
  operationIds,
  REFERENCE_CSP,
  remoteLoads,
  staticReference,
  writeApiReference,
} from '../../scripts/build-api-reference.ts';
import { specOperations } from '../helpers/openapi.ts';

/** The API reference (plan M6): Redoc's prerendered page, made static, so whoever opens it contacts no third party. */

const CDN_SCRIPT =
  '<script src="https://cdn.redocly.com/redoc/v2.5.4/bundles/redoc.standalone.js" crossorigin="anonymous"></script>';
const HYDRATION =
  '<script>\n const __redoc_state = {"spec":{"info":{"description":"<\\/script> stays escaped"}}};\n' +
  " Redoc.hydrate(__redoc_state, document.getElementById('redoc'));\n</script>";
const menuEntry = (id: string, title: string) =>
  `<li tabindex="0" depth="2" data-item-id="${id}" role="menuitem" class="sc-menu">` +
  `<label class="sc-label -depth2"><span type="post" class="operation-type post">post</span>` +
  `<span tabindex="0" class="sc-title">${title}</span></label></li>`;
const section = (id: string, title: string) => `<div id="${id}" data-section-id="${id}"><h2>${title}</h2></div>`;

/** A page as Redocly's build-docs writes it, with one tag and the given operations. */
function redocPage(operations: readonly string[], extra = ''): string {
  const ids = operations.map((operation) => `tag/auth/operation/${operation}`);
  return [
    '<!DOCTYPE html>\n<html lang="en">\n<head>\n  <meta charset="utf8" />\n  <title>Questline API</title>',
    `  <style>body { padding: 0; }</style>\n  ${CDN_SCRIPT}<style data-styled="true">.sc-menu{color:#333}</style>`,
    '</head>\n<body>\n  <div id="redoc"><ul role="menu"><li data-item-id="tag/auth" class="sc-menu"><label>auth</label>',
    `<ul role="menu" class="sc-collapsed">${ids.map((id, index) => menuEntry(id, `Title ${String(index)}`)).join('')}`,
    `</ul></li></ul>${ids.map((id, index) => section(id, `Title ${String(index)}`)).join('')}${extra}</div>`,
    `  ${HYDRATION}\n</body>\n</html>\n`,
  ].join('\n');
}

describe('staticReference (scripts/build-api-reference.ts)', () => {
  it('removes every script: Redoc’s bundle from its CDN and the hydration that needs it', () => {
    const page = staticReference(redocPage(['login']));

    expect(page).not.toContain('<script');
    expect(page).not.toContain('cdn.redocly.com');
    expect(page).not.toContain('__redoc_state');
    expect(page).toContain(section('tag/auth/operation/login', 'Title 0'));
    expect(page).toContain('<style data-styled="true">.sc-menu{color:#333}</style>');
  });

  it('links each menu entry to its section, which Redoc’s script would have scrolled to', () => {
    const page = staticReference(redocPage(['login', 'register']));

    expect(page).toContain(
      '<label class="sc-label -depth2"><a class="ql-menu-link" href="#tag/auth/operation/register">' +
        '<span type="post" class="operation-type post">post</span><span tabindex="0" class="sc-title">Title 1</span>' +
        '</a></label>',
    );
    expect(page).toContain('<label><a class="ql-menu-link" href="#tag/auth">auth</a></label>');
  });

  it('puts the policy first in the head, before anything that could load, and shows every menu level', () => {
    const page = staticReference(redocPage(['login']));

    expect(page).toMatch(
      new RegExp(`<head><meta http-equiv="Content-Security-Policy" content="${REFERENCE_CSP}"><style>[^<]*</style>\\n`),
    );
    expect(page).toContain('[role=menu] ul{display:block!important}');
    expect(REFERENCE_CSP).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:");
  });

  it('refuses a page without a head, where the policy would have no place', () => {
    expect(() => staticReference('<html><body>no head</body></html>')).toThrow('no <head>');
  });
});

describe('remoteLoads', () => {
  it.each([
    ['a script', '<script src="https://example.com/x.js"></script>'],
    ['an inline script', '<script>fetch("/x")</script>'],
    ['a stylesheet', '<link rel="stylesheet" href="https://fonts.googleapis.com/css">'],
    ['a frame', '<iframe src="https://example.com/"></iframe>'],
    ['an object', '<object data="https://example.com/x.swf"></object>'],
    ['a remote image', '<img src="https://example.com/logo.png">'],
    ['a remote image set', '<img srcset="https://example.com/logo-2x.png 2x">'],
    ['a remote background in CSS', '<style>.logo{background:url(https://example.com/logo.png)}</style>'],
    ['a quoted remote URL in CSS', '<div style="background-image: url(\'//example.com/logo.png\')"></div>'],
    ['a CSS import', '<style>@import "https://example.com/theme.css";</style>'],
    ['a refresh', '<meta http-equiv="refresh" content="0; url=https://example.com/">'],
    ['a base address', '<base href="https://example.com/">'],
    ['a link that pings on a click', '<a href="#x" ping="https://example.com/track">x</a>'],
    ['an SVG image', '<svg><image href="https://example.com/x.png"></image></svg>'],
  ])('finds %s', (_name, markup) => {
    expect(remoteLoads(`<html><head></head><body>${markup}</body></html>`)).not.toEqual([]);
  });

  it('accepts inline images, in-page anchors and links that only navigate when clicked', () => {
    const markup = [
      "<style>.icon{background-image:url('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')}</style>",
      '<svg xmlns="http://www.w3.org/2000/svg"><polygon points="1 2 3"></polygon></svg>',
      '<a href="#tag/auth/operation/login">Log in</a>',
      '<a target="_blank" rel="noopener noreferrer" href="https://redocly.com/redoc/">API docs by Redocly</a>',
      '<img src="data:image/png;base64,iVBORw0KGgo=">',
      '<li data-item-id="tag/auth" data-section-id="tag/auth">auth</li>',
    ].join('');

    expect(remoteLoads(`<html><head></head><body>${markup}</body></html>`)).toEqual([]);
  });

  it('finds nothing in a page made static', () => {
    expect(remoteLoads(staticReference(redocPage(['login', 'register'])))).toEqual([]);
  });
});

describe('operationIds and missingOperations', () => {
  const contract = readFileSync('openapi/openapi.yaml', 'utf8');

  it('reads every operation of the contract', () => {
    const expected = specOperations.map(({ operationId }) => operationId);

    expect(operationIds(contract).toSorted()).toEqual(expected.toSorted());
    expect(expected).not.toEqual([]);
  });

  it('names each operation without a section or a menu link', () => {
    const page = staticReference(redocPage(['login']));
    const sectionOnly = page.replace('<a class="ql-menu-link" href="#tag/auth/operation/login">', '<a>');
    const linkOnly = page.replace('<div id="tag/auth/operation/login"', '<div');

    expect(missingOperations(page, ['login'])).toEqual([]);
    expect(missingOperations(page, ['login', 'register'])).toEqual(['register']);
    expect(missingOperations(sectionOnly, ['login'])).toEqual(['login']);
    expect(missingOperations(linkOnly, ['login'])).toEqual(['login']);
  });
});

describe('writeApiReference', () => {
  let directory: string;
  const contractOf = (operations: readonly string[]) =>
    [
      'openapi: 3.1.0',
      'paths:',
      ...operations.flatMap((operation) => [`  /${operation}:`, '    post:', `      operationId: ${operation}`]),
    ].join('\n');

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'questline-api-reference-'));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function write(page: string, operations: readonly string[]): () => void {
    writeFileSync(join(directory, 'redoc.html'), page);
    writeFileSync(join(directory, 'openapi.yaml'), contractOf(operations));
    return () => {
      writeApiReference(join(directory, 'redoc.html'), join(directory, 'out', 'index.html'), {
        contractPath: join(directory, 'openapi.yaml'),
      });
    };
  }

  it('writes the static page, creating its directory', () => {
    write(redocPage(['login', 'register']), ['login', 'register'])();

    const written = readFileSync(join(directory, 'out', 'index.html'), 'utf8');
    expect(written).toBe(staticReference(redocPage(['login', 'register'])));
  });

  it('writes nothing when the page would still load something', () => {
    const run = write(redocPage(['login'], '<img src="https://example.com/x.png">'), ['login']);

    expect(run).toThrow('loads <img src="https://example.com/x.png">');
    expect(existsSync(join(directory, 'out', 'index.html'))).toBe(false);
  });

  it('writes nothing when an operation of the contract is missing', () => {
    const run = write(redocPage(['login']), ['login', 'register']);

    expect(run).toThrow('misses register');
    expect(existsSync(join(directory, 'out', 'index.html'))).toBe(false);
  });
});
