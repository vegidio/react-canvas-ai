#!/usr/bin/env node
/**
 * Stamps a CalVer version (YY.M.MICRO) onto the published package.
 *
 * Changesets is built around semver and has no CalVer support, so it runs first for the
 * changelog and then this overwrites whatever version it computed. The micro counter
 * resets whenever the year or month changes.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const MANIFEST = new URL('../packages/react-canvas-ai/package.json', import.meta.url);

const pkg = JSON.parse(readFileSync(MANIFEST, 'utf8'));

const now = new Date();
const year = now.getUTCFullYear() % 100;
const month = now.getUTCMonth() + 1;

const [prevYear, prevMonth, prevMicro] = pkg.version.split('.').map(Number);
const samePeriod = prevYear === year && prevMonth === month;
const micro = samePeriod ? (Number.isFinite(prevMicro) ? prevMicro + 1 : 0) : 0;

const next = `${year}.${month}.${micro}`;
if (next === pkg.version) {
    console.log(`calver: version already ${next}, nothing to do`);
    process.exit(0);
}

pkg.version = next;
writeFileSync(MANIFEST, `${JSON.stringify(pkg, null, 4)}\n`);
console.log(`calver: ${next}`);
