// A tiny MCP server over stdio for the suite: newline-delimited JSON-RPC, two
// tools, and a stderr log line to prove the client ignores noise. It is what
// `uvx --from some-mcp-server some-mcp` looks like from the pipe.
import readline from 'node:readline';

const TOOLS = [
  {
    name: 'quote',
    description: 'Latest price for a symbol.',
    inputSchema: { type: 'object', properties: { symbol: { type: 'string' }, bars: { type: 'integer' } }, required: ['symbol'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'place.order',
    description: 'Place an order.',
    inputSchema: { type: 'object', properties: { symbol: { type: 'string' }, qty: { type: 'number' } }, required: ['symbol', 'qty'] },
  },
];

process.stderr.write('fake-mcp: starting\n');
const rl = readline.createInterface({ input: process.stdin });
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
const fail = (id, code, message) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } })}\n`);

rl.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.method === 'initialize') {
    return reply(msg.id, { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '0.0.1' } });
  }
  if (msg.method === 'notifications/initialized') return;
  if (msg.method === 'tools/list') {
    // Two pages, to prove the cursor is followed.
    if (!msg.params?.cursor) return reply(msg.id, { tools: [TOOLS[0]], nextCursor: 'p2' });
    return reply(msg.id, { tools: [TOOLS[1]] });
  }
  if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params;
    if (name === 'quote') return reply(msg.id, { content: [{ type: 'text', text: `${args.symbol}: 101.5` }], structuredContent: { symbol: args.symbol, price: 101.5 } });
    if (name === 'place.order') return reply(msg.id, { content: [{ type: 'text', text: `ordered ${args.qty} ${args.symbol}` }] });
    if (name === 'boom') return reply(msg.id, { content: [{ type: 'text', text: 'upstream failed' }], isError: true });
    return fail(msg.id, -32602, `unknown tool ${name}`);
  }
  if (msg.id !== undefined) fail(msg.id, -32601, `method not found: ${msg.method}`);
});
rl.on('close', () => process.exit(0));
