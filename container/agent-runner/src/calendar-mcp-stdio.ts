/**
 * Google Calendar MCP Server for NanoClaw
 * Reads credentials from /home/node/.calendar-mcp/credentials.json
 *
 * Tools:
 *   calendar_list_events  — list upcoming events across all calendars
 *   calendar_create_event — create a new event
 *   calendar_search_events — search events by text query
 *   calendar_free_busy    — check free/busy slots for a time range
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';

const CREDS_FILE = '/home/node/.calendar-mcp/credentials.json';

interface CalendarCreds {
  access_token: string;
  refresh_token: string;
  client_id: string;
  client_secret: string;
  expiry_date?: number;
}

function loadCreds(): CalendarCreds {
  return JSON.parse(fs.readFileSync(CREDS_FILE, 'utf-8'));
}

function saveCreds(creds: CalendarCreds): void {
  fs.writeFileSync(CREDS_FILE, JSON.stringify(creds, null, 2));
}

let creds = loadCreds();

async function refreshIfNeeded(): Promise<void> {
  const expiresAt = creds.expiry_date ?? 0;
  if (Date.now() < expiresAt - 60_000) return;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: creds.refresh_token,
      client_id: creds.client_id,
      client_secret: creds.client_secret,
    }),
  });
  const data = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!res.ok || !data.access_token) throw new Error(`Token refresh failed: ${JSON.stringify(data)}`);
  creds.access_token = data.access_token;
  creds.expiry_date = Date.now() + (data.expires_in ?? 3600) * 1000;
  saveCreds(creds);
}

async function calFetch(path: string, options?: RequestInit): Promise<unknown> {
  await refreshIfNeeded();
  const url = `https://www.googleapis.com/calendar/v3${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${creds.access_token}`,
      'Content-Type': 'application/json',
      ...(options?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Calendar API ${res.status}: ${err}`);
  }
  return res.json();
}

function formatEvent(e: {
  summary?: string;
  start?: { dateTime?: string; date?: string };
  end?: { dateTime?: string; date?: string };
  location?: string;
  description?: string;
  htmlLink?: string;
  id?: string;
  organizer?: { displayName?: string; email?: string };
}): string {
  const title = e.summary ?? '(No title)';
  const start = e.start?.dateTime ?? e.start?.date ?? '';
  const end = e.end?.dateTime ?? e.end?.date ?? '';
  const allDay = !e.start?.dateTime;

  const startDate = start ? new Date(start) : null;
  const endDate = end ? new Date(end) : null;

  const formatDt = (d: Date, allDayEvent: boolean) =>
    allDayEvent
      ? d.toLocaleDateString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short' })
      : d.toLocaleString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' });

  const timeStr = startDate
    ? allDay
      ? formatDt(startDate, true)
      : `${formatDt(startDate, false)} → ${endDate ? endDate.toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' }) : ''}`
    : '';

  const parts = [`📅 ${title}`, `   ${timeStr}`];
  if (e.location) parts.push(`   📍 ${e.location}`);
  if (e.description) parts.push(`   📝 ${e.description.slice(0, 100)}${e.description.length > 100 ? '…' : ''}`);
  return parts.join('\n');
}

const server = new McpServer({ name: 'calendar', version: '1.0.0' });

// ── List upcoming events ──────────────────────────────────────────────────────
server.tool(
  'calendar_list_events',
  'List upcoming events from Google Calendar. Shows events across all calendars by default.',
  {
    days: z.number().int().min(1).max(90).optional().describe('Number of days ahead to look (default 7)'),
    calendar_id: z.string().optional().describe('Specific calendar ID to query (default: primary). Use "all" for all calendars.'),
    max_results: z.number().int().min(1).max(50).optional().describe('Max number of events to return (default 20)'),
  },
  async ({ days = 7, calendar_id = 'all', max_results = 20 }) => {
    try {
      const now = new Date().toISOString();
      const until = new Date(Date.now() + days * 86400_000).toISOString();
      const params = new URLSearchParams({
        timeMin: now,
        timeMax: until,
        maxResults: String(max_results),
        singleEvents: 'true',
        orderBy: 'startTime',
      });

      let events: object[] = [];

      if (calendar_id === 'all') {
        const listData = (await calFetch('/users/me/calendarList')) as { items: { id: string; summary: string }[] };
        const calIds = listData.items.map((c) => c.id);
        const results = await Promise.allSettled(
          calIds.map((id) => calFetch(`/calendars/${encodeURIComponent(id)}/events?${params}`)),
        );
        for (const r of results) {
          if (r.status === 'fulfilled') {
            const d = r.value as { items?: object[] };
            events.push(...(d.items ?? []));
          }
        }
        // Sort by start time
        events.sort((a: any, b: any) => {
          const aStart = a.start?.dateTime ?? a.start?.date ?? '';
          const bStart = b.start?.dateTime ?? b.start?.date ?? '';
          return aStart.localeCompare(bStart);
        });
        events = events.slice(0, max_results);
      } else {
        const d = (await calFetch(`/calendars/${encodeURIComponent(calendar_id)}/events?${params}`)) as { items?: object[] };
        events = d.items ?? [];
      }

      if (events.length === 0) {
        return { content: [{ type: 'text' as const, text: `No events in the next ${days} days.` }] };
      }

      const lines = [`Upcoming events (next ${days} days):\n`, ...events.map((e) => formatEvent(e as any))];
      return { content: [{ type: 'text' as const, text: lines.join('\n\n') }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  },
);

// ── Search events ─────────────────────────────────────────────────────────────
server.tool(
  'calendar_search_events',
  'Search for events by text query across all calendars.',
  {
    query: z.string().describe('Search query (matches title, description, location)'),
    days_back: z.number().int().min(0).max(365).optional().describe('How many days back to search (default 30)'),
    days_ahead: z.number().int().min(0).max(365).optional().describe('How many days ahead to search (default 30)'),
  },
  async ({ query, days_back = 30, days_ahead = 30 }) => {
    try {
      const timeMin = new Date(Date.now() - days_back * 86400_000).toISOString();
      const timeMax = new Date(Date.now() + days_ahead * 86400_000).toISOString();
      const params = new URLSearchParams({ q: query, timeMin, timeMax, singleEvents: 'true', orderBy: 'startTime', maxResults: '20' });

      const listData = (await calFetch('/users/me/calendarList')) as { items: { id: string }[] };
      const results = await Promise.allSettled(
        listData.items.map((c) => calFetch(`/calendars/${encodeURIComponent(c.id)}/events?${params}`)),
      );

      let events: object[] = [];
      for (const r of results) {
        if (r.status === 'fulfilled') {
          const d = r.value as { items?: object[] };
          events.push(...(d.items ?? []));
        }
      }
      events.sort((a: any, b: any) => (a.start?.dateTime ?? a.start?.date ?? '').localeCompare(b.start?.dateTime ?? b.start?.date ?? ''));

      if (events.length === 0) {
        return { content: [{ type: 'text' as const, text: `No events found matching "${query}".` }] };
      }

      const lines = [`Found ${events.length} event(s) matching "${query}":\n`, ...events.map((e) => formatEvent(e as any))];
      return { content: [{ type: 'text' as const, text: lines.join('\n\n') }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  },
);

// ── Create event ──────────────────────────────────────────────────────────────
server.tool(
  'calendar_create_event',
  'Create a new event in Google Calendar.',
  {
    title: z.string().describe('Event title'),
    start: z.string().describe('Start time in ISO 8601 format (e.g. "2026-04-10T14:00:00+02:00") or date only for all-day events (e.g. "2026-04-10")'),
    end: z.string().describe('End time in ISO 8601 format or date only for all-day events'),
    description: z.string().optional().describe('Event description or notes'),
    location: z.string().optional().describe('Event location'),
    calendar_id: z.string().optional().describe('Calendar ID to add the event to (default: primary)'),
    attendees: z.array(z.string()).optional().describe('List of attendee email addresses'),
  },
  async ({ title, start, end, description, location, calendar_id = 'primary', attendees }) => {
    try {
      const allDay = !start.includes('T');
      const event: Record<string, unknown> = {
        summary: title,
        start: allDay ? { date: start } : { dateTime: start, timeZone: 'Europe/Amsterdam' },
        end: allDay ? { date: end } : { dateTime: end, timeZone: 'Europe/Amsterdam' },
      };
      if (description) event.description = description;
      if (location) event.location = location;
      if (attendees?.length) event.attendees = attendees.map((email) => ({ email }));

      const created = (await calFetch(`/calendars/${encodeURIComponent(calendar_id)}/events`, {
        method: 'POST',
        body: JSON.stringify(event),
      })) as { htmlLink?: string; id?: string };

      return {
        content: [{
          type: 'text' as const,
          text: `✓ Event created: "${title}"\n${formatEvent({ ...event, ...created } as any)}\n\nLink: ${created.htmlLink ?? '(no link)'}`,
        }],
      };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  },
);

// ── Free/busy ─────────────────────────────────────────────────────────────────
server.tool(
  'calendar_free_busy',
  'Check free/busy availability for a time range. Useful for finding open slots.',
  {
    start: z.string().describe('Start of range in ISO 8601 format (e.g. "2026-04-10T08:00:00+02:00")'),
    end: z.string().describe('End of range in ISO 8601 format (e.g. "2026-04-10T18:00:00+02:00")'),
  },
  async ({ start, end }) => {
    try {
      const listData = (await calFetch('/users/me/calendarList')) as { items: { id: string; summary: string }[] };
      const body = {
        timeMin: start,
        timeMax: end,
        items: listData.items.map((c) => ({ id: c.id })),
      };

      const data = (await calFetch('/freeBusy', { method: 'POST', body: JSON.stringify(body) })) as {
        calendars: Record<string, { busy: { start: string; end: string }[] }>;
      };

      const allBusy: { start: string; end: string; calendar: string }[] = [];
      for (const [calId, info] of Object.entries(data.calendars)) {
        const calName = listData.items.find((c) => c.id === calId)?.summary ?? calId;
        for (const slot of info.busy) {
          allBusy.push({ ...slot, calendar: calName });
        }
      }

      allBusy.sort((a, b) => a.start.localeCompare(b.start));

      if (allBusy.length === 0) {
        return { content: [{ type: 'text' as const, text: `✓ You're free the entire requested period.` }] };
      }

      const fmt = (iso: string) =>
        new Date(iso).toLocaleString('nl-NL', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' });

      const lines = [`Busy slots:\n`, ...allBusy.map((s) => `  🔴 ${fmt(s.start)} → ${fmt(s.end)}  (${s.calendar})`)];
      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    } catch (err) {
      return { content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }] };
    }
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
