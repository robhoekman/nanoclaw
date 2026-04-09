/**
 * Enphase OAuth authorization script.
 * Opens browser, captures authorization code via local callback, exchanges for tokens.
 * Writes ENPHASE_ACCESS_TOKEN and ENPHASE_REFRESH_TOKEN to .env
 */

import http from 'http';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = path.join(__dirname, '..', '.env');

const CLIENT_ID = process.env.ENPHASE_CLIENT_ID;
const CLIENT_SECRET = process.env.ENPHASE_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:3000/callback';

const AUTH_URL = `https://api.enphaseenergy.com/oauth/authorize?response_type=code&client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}`;

function appendEnv(key, value) {
  let content = fs.existsSync(ENV_FILE) ? fs.readFileSync(ENV_FILE, 'utf-8') : '';
  const regex = new RegExp(`^${key}=.*$`, 'm');
  if (regex.test(content)) {
    content = content.replace(regex, `${key}=${value}`);
  } else {
    content = content.trimEnd() + `\n${key}=${value}\n`;
  }
  fs.writeFileSync(ENV_FILE, content);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:3000');
  if (url.pathname !== '/callback') {
    res.writeHead(404);
    res.end();
    return;
  }

  const code = url.searchParams.get('code');
  if (!code) {
    res.writeHead(400);
    res.end('Missing authorization code');
    return;
  }

  console.log('Got authorization code, exchanging for tokens...');

  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const tokenRes = await fetch('https://api.enphaseenergy.com/oauth/token', {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
    }),
  });

  const data = await tokenRes.json();

  if (!tokenRes.ok || !data.access_token) {
    console.error('Token exchange failed:', JSON.stringify(data));
    res.writeHead(500);
    res.end('Token exchange failed: ' + JSON.stringify(data));
    server.close();
    return;
  }

  appendEnv('ENPHASE_ACCESS_TOKEN', data.access_token);
  appendEnv('ENPHASE_REFRESH_TOKEN', data.refresh_token);

  console.log('✓ Tokens saved to .env');
  console.log(`  Access token: ${data.access_token.slice(0, 20)}...`);
  console.log(`  Expires in: ${data.expires_in}s`);

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<html><body><h2>✓ Enphase authorized successfully!</h2><p>You can close this tab.</p></body></html>');
  server.close();
});

server.listen(3000, () => {
  console.log('Opening browser for Enphase authorization...');
  console.log(`URL: ${AUTH_URL}`);
  exec(`open "${AUTH_URL}"`);
});
