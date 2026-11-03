#!/usr/bin/env node
// Stdio MCP server launched by `claude` per run (TECH §8). Forwards tools/call to the local tool server.
// argv: node mcp-shim.js --sb-job=<id>   (positional marker used by sweepByMarker, TECH §5.7)
'use strict';
const http = require('node:http');
const readline = require('node:readline');

const RPC = new URL(process.env.SB_RPC_URL || 'http://127.0.0.1:0/rpc');
const TOKEN = process.env.SB_RUN_TOKEN || '';

function request(method, path, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : '';
    const req = http.request({ host: '127.0.0.1', port: RPC.port, path, method, timeout: 30000,
      headers: { Authorization: `Bearer ${TOKEN}`, 'X-SB-Parent-Pid': String(process.ppid), 'Content-Type': 'application/json',
                 'Content-Length': Buffer.byteLength(data), Host: `127.0.0.1:${RPC.port}` } }, (res) => {
      let buf = ''; res.on('data', (c) => (buf += c));
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve({ ok: false, error: 'bad_response', hint: buf.slice(0, 200) }); } });
    });
    req.on('error', (e) => resolve({ ok: false, error: 'tool_server_unreachable', hint: String(e.message) }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout', hint: 'tool server timed out' }); });
    req.end(data);
  });
}
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

let toolsCache = null;
async function tools() {
  if (!toolsCache) { const r = await request('GET', '/tools'); toolsCache = r.ok ? r.tools : []; }
  return toolsCache;
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (id === undefined) return;                       // notifications
  try {
    if (method === 'initialize') {
      send({ jsonrpc: '2.0', id, result: { protocolVersion: (params && params.protocolVersion) || '2025-06-18',
        capabilities: { tools: {} }, serverInfo: { name: 'slackboard', version: '0.1.0' } } });
    } else if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: await tools() } });
    } else if (method === 'tools/call') {
      const r = await request('POST', '/rpc', { tool: params.name, input: params.arguments || {} });
      send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(r) }], isError: !r.ok } });
    } else if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
    } else {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
    }
  } catch (e) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: String(e && e.message) } });
  }
});
rl.on('close', () => process.exit(0));
