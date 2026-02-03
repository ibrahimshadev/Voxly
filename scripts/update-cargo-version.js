#!/usr/bin/env node
/**
 * Updates version in Cargo.toml and tauri.conf.json
 * Usage: node scripts/update-cargo-version.js <version>
 */

import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const version = process.argv[2];

if (!version) {
  console.error('Usage: node update-cargo-version.js <version>');
  process.exit(1);
}

console.log(`Updating version to ${version}`);

// Update Cargo.toml
const cargoPath = join(__dirname, '..', 'src-tauri', 'Cargo.toml');
let cargo = readFileSync(cargoPath, 'utf8');
cargo = cargo.replace(/^version = ".*"$/m, `version = "${version}"`);
writeFileSync(cargoPath, cargo);
console.log('Updated src-tauri/Cargo.toml');

// Update tauri.conf.json
const tauriConfPath = join(__dirname, '..', 'src-tauri', 'tauri.conf.json');
const tauriConf = JSON.parse(readFileSync(tauriConfPath, 'utf8'));
tauriConf.version = version;
writeFileSync(tauriConfPath, JSON.stringify(tauriConf, null, 2) + '\n');
console.log('Updated src-tauri/tauri.conf.json');

console.log('Version update complete!');
