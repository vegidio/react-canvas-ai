#!/usr/bin/env node
/**
 * Stamps an explicit CalVer version (YY.M.MICRO) onto the published package.
 *
 * The git tag is the source of truth for a release, so nothing here computes a version —
 * the release workflow passes the tag name in and this writes it to the manifest.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const MANIFEST = new URL('../packages/react-canvas-ai/package.json', import.meta.url);
const CALVER = /^\d{2}\.\d{1,2}\.\d+$/;

const version = process.argv[2];

if (!version) {
    console.error('set-version: expected a version argument, e.g. `node scripts/set-version.mjs 26.8.0`');
    process.exit(1);
}

if (!CALVER.test(version)) {
    console.error(`set-version: '${version}' is not YY.M.MICRO`);
    process.exit(1);
}

const pkg = JSON.parse(readFileSync(MANIFEST, 'utf8'));
pkg.version = version;
writeFileSync(MANIFEST, `${JSON.stringify(pkg, null, 4)}\n`);
console.log(`set-version: ${version}`);
