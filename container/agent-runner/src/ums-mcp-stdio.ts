/**
 * Universal Media Server MCP Server for NanoClaw
 * Reads credentials from /home/node/.ums-mcp/credentials.json
 *
 * Tools:
 *   ums_list_renderers   — list connected DLNA renderers and their playback state
 *   ums_browse_media     — browse the media library on a renderer (folders + files)
 *   ums_play_on_renderer — push a media item to a renderer and start playback
 *   ums_control_renderer — transport control: play/pause/stop/next/prev/mute/volume
 *   ums_renderer_info    — detailed info about a specific renderer
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';

const CREDS_FILE = '/home/node/.ums-mcp/credentials.json';

interface UmsCreds {
  host: string;       // e.g. "http://host.docker.internal:9001"
  username: string;
  password: string;
  token?: string;
  tokenExpiry?: number; // unix ms
}

function loadCreds(): UmsCreds {
  return JSON.parse(fs.readFileSync(CREDS_FILE, 'utf-8'));
}

function saveCreds(creds: UmsCreds): void {
  fs.writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2));
}

function decodeJwtExpiry(token: string): number {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
    return payload.exp ? payload.exp * 1000 : 0;
  } catch {
    return 0;
  }
}

let creds = loadCreds();

async function ensureToken(): Promise<string> {
  const now = Date.now();
  if (creds.token && creds.tokenExpiry && now < creds.tokenExpiry - 60_000) {
    return creds.token;
  }

  // Re-authenticate
  const res = await fetch(`${creds.host}/v1/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: creds.username, password: creds.password }),
  });
  const data = (await res.json()) as { token?: string };
  if (!res.ok || !data.token) throw new Error(`UMS login failed: ${JSON.stringify(data)}`);

  creds.token = data.token;
  creds.tokenExpiry = decodeJwtExpiry(data.token);
  saveCreds(creds);
  return creds.token;
}

async function umsFetch(path: string, options?: RequestInit): Promise<unknown> {
  const token = await ensureToken();
  const res = await fetch(`${creds.host}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(options?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`UMS API ${res.status}: ${err}`);
  }
  return res.json();
}

function playbackState(code: number): string {
  switch (code) {
    case -1: return 'idle';
    case 0:  return 'stopped';
    case 1:  return 'playing';
    case 2:  return 'paused';
    default: return `unknown(${code})`;
  }
}

const server = new McpServer({ name: 'ums', version: '1.0.0' });

// ── List renderers ─────────────────────────────────────────────────────────────
server.tool(
  'ums_list_renderers',
  'List all connected DLNA/UPnP renderers detected by Universal Media Server, with their current playback state.',
  {},
  async () => {
    try {
      const data = (await umsFetch('/v1/api/renderers/')) as {
        renderers: {
          id: number;
          name: string;
          address: string;
          icon: string;
          playing?: string;
          isActive: boolean;
          state: {
            playback: number;
            volume: number;
            mute: boolean;
            name?: string;
            uri?: string;
          };
        }[];
      };

      if (!data.renderers.length) {
        return { content: [{ type: 'text' as const, text: 'No renderers detected.' }] };
      }

      const lines = ['Connected renderers:\n'];
      for (const r of data.renderers) {
        const status = playbackState(r.state.playback);
        const now = r.state.name?.trim() ? ` — now playing: "${r.state.name.trim()}"` : '';
        const vol = `vol ${r.state.volume}%${r.state.mute ? ' (muted)' : ''}`;
        lines.push(`  [${r.id}] ${r.name} (${r.address}) — ${status}, ${vol}${now}`);
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  },
);

// ── Browse media ───────────────────────────────────────────────────────────────
server.tool(
  'ums_browse_media',
  'Browse the media library as seen by a specific renderer. Returns folders and playable files with their IDs. Use the returned IDs to navigate deeper or play files with ums_play_on_renderer.',
  {
    renderer_id: z.number().int().describe('Renderer ID from ums_list_renderers'),
    folder_id: z.string().optional().describe('Folder ID to browse into (default: root "0"). Use IDs returned by previous browse calls.'),
  },
  async ({ renderer_id, folder_id = '0' }) => {
    try {
      const data = (await umsFetch('/v1/api/renderers/browse', {
        method: 'POST',
        body: JSON.stringify({ id: renderer_id, media: folder_id }),
      })) as {
        parents: { value: string; label: string }[];
        childrens: { value: string; label: string; browsable: boolean }[];
      };

      const path = data.parents.length
        ? data.parents.map((p) => p.label).reverse().join(' › ')
        : 'root';

      const lines = [`Media library at: ${path}\n`];

      if (!data.childrens.length) {
        lines.push('  (empty folder)');
      } else {
        for (const item of data.childrens) {
          const type = item.browsable ? '📁' : '🎵';
          const action = item.browsable
            ? `folder_id="${item.value}"`
            : `media_id="${item.value}" (playable)`;
          lines.push(`  ${type} [${action}] ${item.label}`);
        }
      }

      lines.push('\nTo play a file: use ums_play_on_renderer with the media_id shown above.');
      lines.push('To navigate into a folder: call ums_browse_media again with that folder_id.');

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  },
);

// ── Play on renderer ───────────────────────────────────────────────────────────
server.tool(
  'ums_play_on_renderer',
  'Push a specific media item to a DLNA renderer and start playing it. Get the media_id from ums_browse_media (items marked as "playable").',
  {
    renderer_id: z.number().int().describe('Renderer ID from ums_list_renderers'),
    media_id: z.string().describe('Media ID of the playable file, from ums_browse_media'),
  },
  async ({ renderer_id, media_id }) => {
    try {
      // Set the media item on the renderer
      await umsFetch('/v1/api/renderers/control', {
        method: 'POST',
        body: JSON.stringify({ id: renderer_id, action: 'mediaid', value: media_id }),
      });

      // Then send play command
      await umsFetch('/v1/api/renderers/control', {
        method: 'POST',
        body: JSON.stringify({ id: renderer_id, action: 'play' }),
      });

      // Read back current state to confirm
      const data = (await umsFetch('/v1/api/renderers/')) as {
        renderers: { id: number; name: string; state: { name?: string; playback: number } }[];
      };
      const renderer = data.renderers.find((r) => r.id === renderer_id);
      const name = renderer?.state.name?.trim() || '(unknown)';
      const rendererName = renderer?.name || `Renderer ${renderer_id}`;

      return {
        content: [{
          type: 'text' as const,
          text: `▶ Playing "${name}" on ${rendererName} (id ${renderer_id})`,
        }],
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  },
);

// ── Control renderer ───────────────────────────────────────────────────────────
server.tool(
  'ums_control_renderer',
  'Send a transport control command to a renderer: play, pause, stop, next track, previous track, mute/unmute, or set volume.',
  {
    renderer_id: z.number().int().describe('Renderer ID from ums_list_renderers'),
    action: z.enum(['play', 'pause', 'stop', 'next', 'prev', 'mute', 'volume', 'forward', 'back']).describe(
      'Control action: play/pause/stop/next/prev/mute/forward/back resume the current item, or use "volume" with a value (0–100)'
    ),
    value: z.number().int().min(0).max(100).optional().describe('Required for action=volume: volume level 0–100'),
  },
  async ({ renderer_id, action, value }) => {
    try {
      const body: Record<string, unknown> = { id: renderer_id, action };
      if (action === 'volume') {
        if (value === undefined) throw new Error('value (0–100) is required for volume action');
        body.value = value;
      }

      await umsFetch('/v1/api/renderers/control', {
        method: 'POST',
        body: JSON.stringify(body),
      });

      const labels: Record<string, string> = {
        play: '▶ Resumed playback',
        pause: '⏸ Paused',
        stop: '⏹ Stopped',
        next: '⏭ Skipped to next',
        prev: '⏮ Went to previous',
        mute: '🔇 Toggled mute',
        forward: '⏩ Fast forwarded',
        back: '⏪ Rewound',
        volume: `🔊 Volume set to ${value}%`,
      };

      return { content: [{ type: 'text' as const, text: `${labels[action] ?? action} on renderer ${renderer_id}` }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  },
);

// ── Renderer info ──────────────────────────────────────────────────────────────
server.tool(
  'ums_renderer_info',
  'Get detailed technical information about a specific renderer (device type, model, address, UPnP details).',
  {
    renderer_id: z.number().int().describe('Renderer ID from ums_list_renderers'),
  },
  async ({ renderer_id }) => {
    try {
      const data = (await umsFetch('/v1/api/renderers/infos', {
        method: 'POST',
        body: JSON.stringify({ id: renderer_id }),
      })) as {
        title: string;
        isUpnp: boolean;
        details: { key: string; value: string }[];
      };

      const lines = [`${data.title}${data.isUpnp ? ' (UPnP/DLNA)' : ''}\n`];
      for (const d of data.details) {
        lines.push(`  ${d.key}: ${d.value}`);
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
