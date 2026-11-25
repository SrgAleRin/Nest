import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * A release tag must name exactly the version that electron-builder puts into
 * the installer and latest.yml. Without this guard a mistyped tag would publish
 * assets that the updater never offers (or, worse, overwrite a feed entry with
 * the wrong version).
 *
 * Usage: node scripts/check-release-version.mjs v0.1.0
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tag = process.argv[2] ?? process.env.GITHUB_REF_NAME;

if (!tag) {
  console.error('Usage: node scripts/check-release-version.mjs <tag>');
  process.exit(1);
}

if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(tag)) {
  console.error(`Release tag "${tag}" is not v<semver>, for example v0.1.0.`);
  process.exit(1);
}

const desktopPackage = JSON.parse(
  readFileSync(path.join(root, 'apps', 'desktop', 'package.json'), 'utf8'),
);
const expected = tag.slice(1);

if (desktopPackage.version !== expected) {
  console.error(
    `Release tag "${tag}" does not match apps/desktop/package.json version "${desktopPackage.version}".`,
  );
  console.error(`Bump the version to ${expected} and commit it before tagging.`);
  process.exit(1);
}

console.log(`Release tag ${tag} matches desktop version ${expected}.`);
