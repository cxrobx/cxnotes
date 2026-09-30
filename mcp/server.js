#!/usr/bin/env node
'use strict';

/**
 * cxnotes-calendar — standalone MCP server (stdio, CommonJS).
 *
 * Lets a background process / Claude routine PREPARE meetings ahead of time:
 * it reuses the bundled EventKit calendar-helper and stages templated meetings
 * into the filesystem handoff (shared/paths.js → <appSupport>/handoff/prepared).
 * The Electron app reads + claims them when the matching call starts. There is
 * NO live-control bridge — the MCP server never drives a recording; it only
 * reads calendars and stages files (invariant: handoff store is the only
 * cross-process channel).
 *
 * stdio only — no daemon, no ports. stdout carries the JSON-RPC protocol, so
 * ALL logging goes to stderr.
 */

const path = require('path');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js');

const { createCalendarSource } = require('./calendarFactory');
const { createHandlers } = require('./handlers');
const { PreparedMeetingStore } = require('../services/preparedMeetingStore');

async function main() {
  const repoRoot = path.resolve(__dirname, '..');

  // The calendar source may be unavailable (helper not built). We still start
  // the server: calendar tools then report the build fix, while the prepared-
  // store tools (list/cancel) keep working.
  let source = null;
  let sourceError = null;
  let helperPath = null;
  try {
    ({ source, helperPath } = createCalendarSource({ repoRoot }));
  } catch (err) {
    sourceError = err;
    console.error(`[cxnotes-calendar] calendar-helper unavailable: ${err.message}`);
  }

  const preparedStore = new PreparedMeetingStore();
  const handlers = createHandlers({ source, preparedStore, sourceError });

  const server = new Server(
    { name: 'cxnotes-calendar', version: '1.0.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: handlers.tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const result = await handlers.call(name, args || {});
    return {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      isError: Boolean(result && result.error),
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  console.error(
    `[cxnotes-calendar] MCP server running (stdio).` +
      (helperPath ? ` helper: ${helperPath}` : ' helper: <missing>')
  );
}

main().catch((err) => {
  console.error('[cxnotes-calendar] fatal:', err);
  process.exit(1);
});
