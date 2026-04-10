/**
 * Universal Media Server setup script.
 * Tests credentials against UMS and saves them to ~/.ums-mcp/credentials.json
 *
 * Usage: node scripts/ums-setup.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import readline from 'readline';

const OUT_DIR = path.join(os.homedir(), '.ums-mcp');
const OUT_FILE = path.join(OUT_DIR, 'credentials.json');

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, res));

const host = (await ask('UMS host (default: http://localhost:9001): ')).trim() || 'http://localhost:9001';
const username = (await ask('UMS username: ')).trim();
const password = (await ask('UMS password: ')).trim();
rl.close();

console.log('\nTesting credentials...');

const res = await fetch(`${host}/v1/api/auth/login`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username, password }),
});

const data = await res.json();
if (!res.ok || !data.token) {
  console.error('✗ Login failed:', JSON.stringify(data));
  process.exit(1);
}

// Decode token expiry
let tokenExpiry = 0;
try {
  const payload = JSON.parse(Buffer.from(data.token.split('.')[1], 'base64').toString());
  tokenExpiry = payload.exp ? payload.exp * 1000 : 0;
} catch {}

// Use host.docker.internal for container access (save localhost as the original host for reference)
const containerHost = host.replace('localhost', 'host.docker.internal').replace('127.0.0.1', 'host.docker.internal');

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT_FILE, JSON.stringify({
  host: containerHost,
  username,
  password,
  token: data.token,
  tokenExpiry,
}, null, 2));

console.log('✓ UMS credentials saved to', OUT_FILE);
console.log('  Host (container-facing):', containerHost);

// Verify by listing renderers
const r2 = await fetch(`${host}/v1/api/renderers/`, {
  headers: { Authorization: `Bearer ${data.token}` },
});
const renderers = await r2.json();
console.log(`\nDetected ${renderers.renderers?.length ?? 0} renderer(s):`);
for (const r of renderers.renderers ?? []) {
  console.log(`  [${r.id}] ${r.name} (${r.address})`);
}
