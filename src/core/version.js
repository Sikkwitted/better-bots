import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The product is Better Bots. Each major release gets a little mo' better:
//   1.x  Better Bots
//   2.x  Mo Better Bots
//   3.x  Lil Bit Mo Better Bots
//   4.x  Lil Bit Lil Bit Mo Better Bots, and so on — the name grows with the software.

export const PRODUCT = 'Better Bots';

const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8'));
export const VERSION = pkg.version;

export function codenameFor(version) {
  const major = Number(String(version).split('.')[0]) || 1;
  if (major <= 1) return 'Better Bots';
  if (major === 2) return 'Mo Better Bots';
  return `${'Lil Bit '.repeat(major - 2)}Mo Better Bots`;
}

export const CODENAME = codenameFor(VERSION);
// 0.x is the public preview; the semver itself stays plain for headers and clients.
export const DISPLAY_VERSION = Number(VERSION.split('.')[0]) === 0 ? `${VERSION} preview` : VERSION;
export const BANNER = CODENAME === PRODUCT ? `${PRODUCT} ${DISPLAY_VERSION}` : `${PRODUCT} ${DISPLAY_VERSION} — "${CODENAME}"`;
