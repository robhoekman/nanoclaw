/**
 * Enphase MCP Server for NanoClaw
 * Exposes Enphase solar/battery API as tools for the container agent.
 *
 * Tools:
 *   enphase_summary          — live production, energy today, battery info
 *   enphase_production_history — daily kWh for last N days
 *   enphase_telemetry        — 5-min interval production curve for today
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';

const TOKENS_FILE = '/home/node/.enphase-mcp/tokens.json';

interface EnphaseTokens {
  clientId: string;
  clientSecret: string;
  apiKey: string;
  systemId: string;
  accessToken: string;
  refreshToken: string;
}

function loadTokens(): EnphaseTokens {
  return JSON.parse(fs.readFileSync(TOKENS_FILE, 'utf-8'));
}

function saveTokens(tokens: EnphaseTokens): void {
  fs.writeFileSync(TOKENS_FILE, JSON.stringify(tokens, null, 2));
}

let tokens = loadTokens();

const CLIENT_ID = tokens.clientId;
const CLIENT_SECRET = tokens.clientSecret;
const API_KEY = tokens.apiKey;
const SYSTEM_ID = tokens.systemId;
let accessToken = tokens.accessToken;
const refreshToken = tokens.refreshToken;

const BASE = `https://api.enphaseenergy.com/api/v4/systems/${SYSTEM_ID}`;

async function refreshAccessToken(): Promise<void> {
  const basic = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://api.enphaseenergy.com/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  const data = (await res.json()) as { access_token?: string; error?: string };
  if (!res.ok || !data.access_token) {
    throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  }
  accessToken = data.access_token;
  tokens = { ...tokens, accessToken };
  saveTokens(tokens);
}

async function apiFetch(path: string): Promise<unknown> {
  const url = `${BASE}${path}${path.includes('?') ? '&' : '?'}key=${API_KEY}`;
  let res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  // Retry once after token refresh on 401
  if (res.status === 401) {
    await refreshAccessToken();
    res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Enphase API ${res.status}: ${text}`);
  }
  return res.json();
}

function wToKw(w: number): string {
  return (w / 1000).toFixed(2) + ' kW';
}

function whToKwh(wh: number): string {
  return (wh / 1000).toFixed(2) + ' kWh';
}

function formatTimestamp(unixSecs: number): string {
  return new Date(unixSecs * 1000).toLocaleString('nl-NL', {
    timeZone: 'Europe/Amsterdam',
    dateStyle: 'short',
    timeStyle: 'short',
  });
}

const server = new McpServer({ name: 'enphase', version: '1.0.0' });

server.tool(
  'enphase_summary',
  'Get a live summary of the Enphase solar system: current production power, energy produced today, lifetime energy, battery capacity, and system status.',
  {},
  async () => {
    try {
      const data = (await apiFetch('/summary')) as {
        current_power: number;
        energy_today: number;
        energy_lifetime: number;
        status: string;
        modules: number;
        size_w: number;
        last_report_at: number;
        summary_date: string;
        battery_capacity_wh: number;
        battery_charge_w: number;
        battery_discharge_w: number;
      };

      const lines = [
        `📅 Date: ${data.summary_date}`,
        `⚡ Current production: ${wToKw(data.current_power)}`,
        `☀️  Energy today: ${whToKwh(data.energy_today)}`,
        `📊 Lifetime energy: ${whToKwh(data.energy_lifetime)}`,
        `🔋 Battery capacity: ${whToKwh(data.battery_capacity_wh)}`,
        `   Max charge rate: ${wToKw(data.battery_charge_w)}`,
        `   Max discharge rate: ${wToKw(data.battery_discharge_w)}`,
        `🏠 System: ${data.modules} panels, ${wToKw(data.size_w)} installed`,
        `📡 Status: ${data.status}`,
        `🕐 Last report: ${formatTimestamp(data.last_report_at)}`,
      ];

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'enphase_production_history',
  'Get daily solar production history for the last N days (default 7, max 365).',
  {
    days: z
      .number()
      .int()
      .min(1)
      .max(365)
      .optional()
      .describe('Number of past days to return (default 7)'),
  },
  async ({ days = 7 }) => {
    try {
      const data = (await apiFetch('/energy_lifetime')) as {
        start_date: string;
        production: number[];
      };

      const startDate = new Date(data.start_date);
      const production = data.production;
      const total = production.length;
      const slice = production.slice(Math.max(0, total - days));

      const lines = [`Solar production — last ${slice.length} days:`];
      slice.forEach((wh, i) => {
        const d = new Date(startDate);
        d.setDate(d.getDate() + (total - slice.length + i));
        const label = d.toLocaleDateString('nl-NL', { weekday: 'short', month: 'short', day: 'numeric' });
        lines.push(`  ${label}: ${whToKwh(wh)}`);
      });

      const totalKwh = (slice.reduce((a, b) => a + b, 0) / 1000).toFixed(2);
      lines.push(`\nTotal: ${totalKwh} kWh`);

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'enphase_telemetry',
  "Get today's 5-minute interval production data showing the solar output curve throughout the day.",
  {},
  async () => {
    try {
      const data = (await apiFetch('/telemetry/production_micro')) as {
        intervals: { end_at: number; powr: number; enwh: number }[];
        granularity: string;
      };

      const intervals = data.intervals.filter((i) => i.powr > 0 || i.enwh > 0);

      if (intervals.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No production data yet for today (panels may not be generating yet).' }],
        };
      }

      const peak = intervals.reduce((a, b) => (b.powr > a.powr ? b : a));
      const totalWh = intervals.reduce((sum, i) => sum + i.enwh, 0);

      const lines = [
        `Today's production curve (${intervals.length} intervals):`,
        `Peak: ${wToKw(peak.powr)} at ${formatTimestamp(peak.end_at)}`,
        `Total so far: ${whToKwh(totalWh)}`,
        '',
        'Hourly breakdown:',
      ];

      // Group into hours
      const hourly = new Map<number, number>();
      for (const interval of intervals) {
        const hour = new Date(interval.end_at * 1000).getHours();
        hourly.set(hour, (hourly.get(hour) ?? 0) + interval.enwh);
      }
      for (const [hour, wh] of [...hourly.entries()].sort((a, b) => a[0] - b[0])) {
        const bar = '█'.repeat(Math.round(wh / 200)).padEnd(15);
        lines.push(`  ${String(hour).padStart(2, '0')}:00  ${bar} ${whToKwh(wh)}`);
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'enphase_battery',
  'Get current battery status for the two Encharge home batteries: state of charge (%), current charge/discharge activity, energy charged and discharged today, and total capacity.',
  {},
  async () => {
    try {
      const [batteryData, summaryData] = await Promise.all([
        apiFetch('/telemetry/battery') as Promise<{
          total_devices: number;
          intervals: {
            end_at: number;
            charge: { enwh: number; devices_reporting: number };
            discharge: { enwh: number; devices_reporting: number };
            soc: { percent: number; devices_reporting: number };
          }[];
        }>,
        apiFetch('/summary') as Promise<{
          battery_capacity_wh: number;
          battery_charge_w: number;
          battery_discharge_w: number;
        }>,
      ]);

      const intervals = batteryData.intervals;
      const latest = intervals[intervals.length - 1];

      // Determine current activity from last interval
      const isCharging = latest.charge.enwh > latest.discharge.enwh;
      const isDischarging = latest.discharge.enwh > latest.charge.enwh;
      const activity = isCharging ? '⬆️  Charging' : isDischarging ? '⬇️  Discharging' : '⏸️  Idle';

      // Today's totals
      const totalCharged = intervals.reduce((sum, i) => sum + i.charge.enwh, 0);
      const totalDischarged = intervals.reduce((sum, i) => sum + i.discharge.enwh, 0);

      // SoC range today
      const socValues = intervals.map((i) => i.soc.percent);
      const socMin = Math.min(...socValues);
      const socMax = Math.max(...socValues);

      const capacityPerBattery = summaryData.battery_capacity_wh / batteryData.total_devices;
      const energyAvailable = (summaryData.battery_capacity_wh * latest.soc.percent) / 100;

      const lines = [
        `🔋 Battery Status (${batteryData.total_devices} Encharge units)`,
        ``,
        `State of charge: ${latest.soc.percent}%  ${activity}`,
        `Energy available: ${whToKwh(energyAvailable)} / ${whToKwh(summaryData.battery_capacity_wh)} total`,
        `Per unit: ~${whToKwh(capacityPerBattery)} capacity each`,
        ``,
        `Today's activity:`,
        `  Charged:     ${whToKwh(totalCharged)}`,
        `  Discharged:  ${whToKwh(totalDischarged)}`,
        `  Net:         ${whToKwh(totalCharged - totalDischarged)}`,
        ``,
        `SoC range today: ${socMin}% → ${socMax}%`,
        `Max charge rate:    ${wToKw(summaryData.battery_charge_w)}`,
        `Max discharge rate: ${wToKw(summaryData.battery_discharge_w)}`,
        `Last report: ${formatTimestamp(latest.end_at)}`,
      ];

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
