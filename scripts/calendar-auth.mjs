/**
 * Google Calendar OAuth authorization script.
 * Reuses the GCP OAuth app from Gmail (~/.gmail-mcp/gcp-oauth.keys.json).
 * Writes tokens to ~/.calendar-mcp/credentials.json
 */

import http from 'http';
import { exec } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const KEYS_FILE = path.join(os.homedir(), '.gmail-mcp', 'gcp-oauth.keys.json');
const OUT_DIR = path.join(os.homedir(), '.calendar-mcp');
const OUT_FILE = path.join(OUT_DIR, 'credentials.json');

const keys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf-8'));
const { client_id, client_secret } = keys.installed || keys.web;

const REDIRECT_URI = 'http://localhost:3000/callback';
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.events',
].join(' ');

const AUTH_URL =
  `https://accounts.google.com/o/oauth2/v2/auth?` +
  `response_type=code` +
  `&client_id=${encodeURIComponent(client_id)}` +
  `&redirect_uri=${encodeURIComponent(REDIRECT_URI)}` +
  `&scope=${encodeURIComponent(SCOPES)}` +
  `&access_type=offline` +
  `&prompt=consent`;

fs.mkdirSync(OUT_DIR, { recursive: true });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:3000');
  if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return; }

  const code = url.searchParams.get('code');
  if (!code) { res.writeHead(400); res.end('Missing code'); return; }

  console.log('Got code, exchanging for tokens...');

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id,
      client_secret,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  });

  const tokens = await tokenRes.json();
  if (!tokenRes.ok || !tokens.access_token) {
    console.error('Token exchange failed:', tokens);
    res.writeHead(500); res.end('Failed: ' + JSON.stringify(tokens));
    server.close(); return;
  }

  fs.writeFileSync(OUT_FILE, JSON.stringify({ ...tokens, client_id, client_secret }, null, 2));
  console.log('✓ Calendar credentials saved to', OUT_FILE);

  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<html><body><h2>✓ Google Calendar authorized!</h2><p>You can close this tab.</p></body></html>');
  server.close();
});

server.listen(3000, () => {
  console.log('Opening browser for Google Calendar authorization...');
  exec(`open "${AUTH_URL}"`);
});
