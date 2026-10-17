import test from 'node:test';
import assert from 'node:assert/strict';
import { makeHost, call } from './helpers.js';
import { Host } from '../src/host.js';
import { ScriptedAdapter } from '../src/model/scripted-adapter.js';
import { fixedClock } from '../src/core/clock.js';
import { tmpDir, oneStep } from './helpers.js';
import http from 'node:http';
import zlib from 'node:zlib';
import { isNonPublicAddress, pinnedFetch, readPublicPage, readableText, vetPublicUrl } from '../src/tools/web-tool.js';

// Reading a public web page is allowed by default: it has low local impact.
// Public has to mean public, so the network is faked and the address check is real.

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

function page(html, { status = 200, headers = {} } = {}) {
  return {
    status,
    headers: new Headers({ 'content-type': 'text/html; charset=utf-8', ...headers }),
    arrayBuffer: async () => new TextEncoder().encode(html).buffer,
  };
}

test('refuses private, loopback, link-local, and credentialed targets before any request', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.1.1', '169.254.169.254', '100.64.0.1', '::1', 'fe80::1', 'fd00::5', '::ffff:10.0.0.1']) {
    assert.equal(isNonPublicAddress(ip), true, ip);
  }
  assert.equal(isNonPublicAddress('93.184.216.34'), false);
  assert.throws(() => vetPublicUrl('http://127.0.0.1:4173/'), /not a public address/);
  assert.throws(() => vetPublicUrl('http://localhost/'), /not a public host/);
  assert.throws(() => vetPublicUrl('http://metadata.internal/'), /not a public host/);
  assert.throws(() => vetPublicUrl('https://user:pass@example.com/'), /credentials/);
  assert.throws(() => vetPublicUrl('ftp://example.com/'), /only http and https/);
  assert.throws(() => vetPublicUrl('not a url'), /not a valid URL/);
});

test('a public name that resolves to a private address is refused', async () => {
  await assert.rejects(
    readPublicPage('https://evil.example', { lookup: async () => ['10.0.0.7'], fetchImpl: async () => { throw new Error('must not fetch'); } }),
    /resolves to 10\.0\.0\.7/,
  );
});

test('reads a page as text, strips scripts and styles, keeps the title', async () => {
  const html = '<html><head><title>Checkout  patterns</title><style>p{color:red}</style></head><body><h1>Hello</h1><script>alert(1)</script><p>One &amp; two</p><ul><li>a</li><li>b</li></ul></body></html>';
  const result = await readPublicPage('https://example.com/x', { lookup: publicLookup, fetchImpl: async () => page(html) });
  assert.equal(result.ok, true);
  assert.equal(result.title, 'Checkout patterns');
  assert.doesNotMatch(result.text, /alert|color:red/);
  assert.match(result.text, /Hello\nOne & two\na\nb/);
  assert.equal(result.final_url, 'https://example.com/x');
  assert.match(result.note, /untrusted evidence/);
});

test('an empty JavaScript shell is unavailable content, not a successful read', async () => {
  const html = '<html><head><title>Current jobs</title></head><body><div id="app"> </div><script>loadJobs()</script></body></html>';
  const result = await readPublicPage('https://example.com/jobs/123', { lookup: publicLookup, fetchImpl: async () => page(html) });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'empty_content');
  assert.equal(result.status, 200);
  assert.equal(result.url, 'https://example.com/jobs/123');
  assert.equal(result.final_url, 'https://example.com/jobs/123');
  assert.equal(result.title, 'Current jobs');
  assert.equal(result.text, '');
  assert.match(result.message, /JavaScript|browser/i);
  assert.match(result.message, /another public source|could not be read/i);
});

test('an empty login redirect preserves the destination and explains the access limitation', async () => {
  const fetchImpl = async (url) => url === 'https://example.com/jobs'
    ? page('', { status: 302, headers: { location: '/log-in?redirectTo=%2Fjobs' } })
    : page('<html><head><title>Log in</title></head><body><div id="app"></div><script>renderLogin()</script></body></html>');
  const result = await readPublicPage('https://example.com/jobs', { lookup: publicLookup, fetchImpl });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'empty_content');
  assert.equal(result.status, 200);
  assert.equal(result.url, 'https://example.com/jobs');
  assert.equal(result.final_url, 'https://example.com/log-in?redirectTo=%2Fjobs');
  assert.equal(result.redirects, 1);
  assert.equal(result.text, '');
  assert.match(result.message, /login|sign.in/i);
  assert.match(result.message, /another public source|could not be read/i);
});

test('follows redirects but vets every hop', async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    if (url === 'https://example.com/a') return { status: 302, headers: new Headers({ location: '/b' }), arrayBuffer: async () => new ArrayBuffer(0) };
    return page('<p>landed</p>');
  };
  const result = await readPublicPage('https://example.com/a', { lookup: publicLookup, fetchImpl });
  assert.equal(result.redirects, 1);
  assert.equal(result.final_url, 'https://example.com/b');
  assert.deepEqual(seen, ['https://example.com/a', 'https://example.com/b']);

  await assert.rejects(
    readPublicPage('https://example.com/a', { lookup: publicLookup, fetchImpl: async () => ({ status: 301, headers: new Headers({ location: 'http://169.254.169.254/latest/meta-data' }), arrayBuffer: async () => new ArrayBuffer(0) }) }),
    /not a public address/,
  );
  await assert.rejects(
    readPublicPage('https://example.com/loop', { lookup: publicLookup, fetchImpl: async (url) => ({ status: 302, headers: new Headers({ location: `${url}/again` }), arrayBuffer: async () => new ArrayBuffer(0) }) }),
    /redirects/,
  );
});

test('the request goes to the address that passed the check, not to a second DNS answer', async () => {
  // A rebinding name answers public first and 127.0.0.1 after. Only the first
  // answer is ever asked for, and it is what the request connects to.
  const answers = [[{ address: '93.184.216.34', family: 4 }], [{ address: '127.0.0.1', family: 4 }]];
  let lookups = 0;
  const lookup = async () => answers[lookups++];
  const connected = [];
  const result = await readPublicPage('https://rebind.example/', { lookup, fetchImpl: async (url, init) => { connected.push(init.addresses); return page('<p>public</p>'); } });
  assert.equal(result.ok, true);
  assert.equal(lookups, 1);
  assert.deepEqual(connected, [['93.184.216.34']]);

  // The real transport never resolves the name again: this one does not exist
  // in DNS at all, yet the request lands on the address it was handed.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
    res.end(zlib.gzipSync(`host=${req.headers.host}`));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { port } = server.address();
    const response = await pinnedFetch(`http://rebind.invalid:${port}/`, { addresses: ['127.0.0.1'] });
    let text = '';
    for await (const chunk of response.body) text += chunk;
    assert.equal(response.status, 200);
    assert.equal(text, `host=rebind.invalid:${port}`, 'decoded, with the name kept in Host');
    await assert.rejects(pinnedFetch(`http://rebind.invalid:${port}/`, { addresses: [] }), /no vetted address/);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('caps the text, rejects binaries, and reports non-2xx honestly', async () => {
  const long = `<p>${'word '.repeat(10_000)}</p>`;
  const capped = await readPublicPage('https://example.com/long', { lookup: publicLookup, fetchImpl: async () => page(long), max_chars: 1_000 });
  assert.equal(capped.truncated, true);
  assert.equal(capped.text.length, 1_000);
  await assert.rejects(
    readPublicPage('https://example.com/a.png', { lookup: publicLookup, fetchImpl: async () => page('', { headers: { 'content-type': 'image/png' } }) }),
    /not a readable page/,
  );
  const missing = await readPublicPage('https://example.com/404', { lookup: publicLookup, fetchImpl: async () => page('<p>gone</p>', { status: 404 }) });
  assert.equal(missing.ok, false);
  assert.equal(missing.status, 404);
});

test('plain text and JSON pass through without HTML stripping', async () => {
  const result = await readPublicPage('https://example.com/data.json', { lookup: publicLookup, fetchImpl: async () => page('{"a":1}', { headers: { 'content-type': 'application/json' } }) });
  assert.equal(result.text, '{"a":1}');
  assert.deepEqual(readableText('<title>t</title><p>x</p>'), { title: 't', text: 'x' });
});

test('the tool passes the web.read_public gate without a card and is audited', async () => {
  const dir = tmpDir();
  const adapter = new ScriptedAdapter(oneStep(() => [call('WebReadPublic', { url: 'https://example.com/' })]));
  const host = new Host({ dir, adapter, clock: fixedClock(), web: { lookup: publicLookup, fetchImpl: async () => page('<title>Example</title><p>public page</p>') } });
  host.registry.create({ id: 'agt_a', profile: { name: 'A' } });
  host.userRequest({ agent_id: 'agt_a', text: 'read it' });
  await host.drain();
  const result = host.transcripts.all('agent', 'agt_a').find((e) => e.kind === 'tool_result' && e.name === 'WebReadPublic').result;
  assert.equal(result.ok, true);
  assert.equal(result.title, 'Example');
  const explanation = host.explain(host.scheduler.runHistory().at(-1).id);
  assert.deepEqual(explanation.result.tools, [{ name: 'WebReadPublic', decision: 'allowed', target: 'https://example.com/' }]);
  assert.ok(host.audit.where((e) => e.type === 'tool.executed' && e.name === 'WebReadPublic').length === 1);
});

test('a blocked target is a failed tool call with the reason, never a request', async () => {
  const { host } = makeHost({ script: () => [call('WebReadPublic', { url: 'http://127.0.0.1:4173/api/status' })] });
  host.registry.create({ id: 'agt_a', profile: { name: 'A' } });
  host.userRequest({ agent_id: 'agt_a', text: 'read it' });
  await host.drain();
  const result = host.transcripts.all('agent', 'agt_a').find((e) => e.kind === 'tool_result' && e.name === 'WebReadPublic').result;
  assert.equal(result.ok, false);
  assert.equal(result.error, 'non_public_address');
});
