/**
 * LM Studio MCP Server for NanoClaw
 * Exposes LM Studio's OpenAI-compatible API as tools for the container agent.
 *
 * Tools:
 *   lmstudio_list_models  — list models currently loaded in LM Studio
 *   lmstudio_chat         — send a chat completion request to a local model
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const DEFAULT_HOST = 'http://host.docker.internal:1234';
const lmstudioHost = (process.env.LMSTUDIO_HOST || DEFAULT_HOST).replace(/\/$/, '');

async function lmFetch(path: string, options?: RequestInit): Promise<Response> {
  const url = `${lmstudioHost}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options?.headers ?? {}) },
  });
  return res;
}

const server = new McpServer({
  name: 'lmstudio',
  version: '1.0.0',
});

server.tool(
  'lmstudio_list_models',
  'List models currently loaded in LM Studio. Returns model IDs you can pass to lmstudio_chat.',
  {},
  async () => {
    let res: Response;
    try {
      res = await lmFetch('/v1/models');
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to connect to LM Studio at ${lmstudioHost}. Make sure LM Studio is running with the local server enabled (port 1234 by default).`,
          },
        ],
      };
    }

    if (!res.ok) {
      return {
        content: [{ type: 'text' as const, text: `LM Studio returned ${res.status}: ${await res.text()}` }],
      };
    }

    const data = (await res.json()) as { data: { id: string }[] };
    const models = data.data ?? [];

    if (models.length === 0) {
      return {
        content: [{ type: 'text' as const, text: 'No models are currently loaded in LM Studio. Load a model in the LM Studio app first.' }],
      };
    }

    const list = models.map((m) => `- ${m.id}`).join('\n');
    return { content: [{ type: 'text' as const, text: `Loaded models:\n${list}` }] };
  },
);

server.tool(
  'lmstudio_chat',
  'Send a chat completion request to a locally running LM Studio model. Use lmstudio_list_models first to see available model IDs.',
  {
    model: z.string().describe('Model ID to use (from lmstudio_list_models)'),
    prompt: z.string().describe('The user message to send to the model'),
    system: z
      .string()
      .optional()
      .describe('Optional system prompt to set the model\'s behavior or persona'),
    max_tokens: z
      .number()
      .int()
      .min(1)
      .max(32768)
      .optional()
      .describe('Maximum tokens to generate (default: 1024)'),
    temperature: z
      .number()
      .min(0)
      .max(2)
      .optional()
      .describe('Sampling temperature (default: 0.7). Lower = more focused, higher = more creative'),
  },
  async ({ model, prompt, system, max_tokens, temperature }) => {
    const messages: { role: string; content: string }[] = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: prompt });

    const body = {
      model,
      messages,
      max_tokens: max_tokens ?? 1024,
      temperature: temperature ?? 0.7,
      stream: false,
    };

    let res: Response;
    try {
      res = await lmFetch('/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify(body),
      });
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to connect to LM Studio at ${lmstudioHost}. Make sure LM Studio is running with the local server enabled.`,
          },
        ],
      };
    }

    if (!res.ok) {
      const errText = await res.text();
      return {
        content: [{ type: 'text' as const, text: `LM Studio error ${res.status}: ${errText}` }],
      };
    }

    const data = (await res.json()) as {
      choices: { message: { content: string } }[];
      usage?: { prompt_tokens: number; completion_tokens: number };
    };

    const reply = data.choices?.[0]?.message?.content ?? '(no response)';
    const usage = data.usage
      ? ` [${data.usage.prompt_tokens} in / ${data.usage.completion_tokens} out tokens]`
      : '';

    return { content: [{ type: 'text' as const, text: `${reply}${usage}` }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
