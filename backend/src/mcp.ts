#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { BRAND } from './config.js';
import { quote } from './placement.js';
import { rescue } from './rescue.js';
import { scanUrl } from './scanner.js';

const server = new McpServer({ name: BRAND.toLowerCase(), version: '0.1.0' });

const text = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] });

server.registerTool(
  'scan_url',
  {
    description: 'Run a passive security check on a live web app. Returns a grade, plain-language findings and a prompt that fixes them.',
    inputSchema: { url: z.string().describe('Address of the live app') },
  },
  async ({ url }) => text(await scanUrl(url, { allowPrivate: true })),
);

server.registerTool(
  'quote_cloud',
  {
    description: 'Compare cloud providers for an app and return three options (Budget, Balanced, Premium) with monthly cost in euros.',
    inputSchema: {
      monthly_budget: z.number().default(20).describe('Monthly limit in euros'),
      monthly_users: z.number().default(2000),
      needs_database: z.boolean().default(false),
      eu_only: z.boolean().default(false).describe('Only European companies'),
    },
  },
  async ({ monthly_budget, monthly_users, needs_database, eu_only }) =>
    text(quote({ monthlyBudget: monthly_budget, monthlyUsers: monthly_users, needsDatabase: needs_database, euOnly: eu_only, egressTb: 0.2, storageGb: 10 })),
);

server.registerTool(
  'rescue_project',
  {
    description: 'Check a project folder or public GitHub repo for security problems, detect its stack, and generate a deploy kit (Dockerfile, compose, Caddy, hardened cloud-init, backups, runbook). Returns the files without writing them.',
    inputSchema: {
      source: z.string().describe('Absolute folder path or GitHub address'),
      monthly_budget: z.number().default(20),
      eu_only: z.boolean().default(false),
    },
  },
  async ({ source, monthly_budget, eu_only }) => {
    const { analysis, quote: placement, kit, deployable } = await rescue(
      { source, monthlyBudget: monthly_budget, euOnly: eu_only },
      { local: !/github\.com/.test(source) },
    );
    return text({ analysis, quote: placement, deployable, kit });
  },
);

await server.connect(new StdioServerTransport());
