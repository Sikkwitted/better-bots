import test from 'node:test';
import assert from 'node:assert/strict';
import { readPublicPage } from '../src/tools/web-tool.js';

const lookup = async () => ['93.184.216.34'];
const page = (html, options = {}) => new Response(html, { headers: { 'content-type': 'text/html', ...options.headers }, status: options.status ?? 200 });

test('board links resolve against the final page and retain useful labels without navigation', async () => {
  const requests = [];
  const result = await readPublicPage('https://board.test/start', {
    lookup,
    fetchImpl: async (url) => {
      requests.push(url);
      if (url.endsWith('/start')) return page('', { status: 302, headers: { location: '/contracts/' } });
      return page(`<title>Contracts</title>
        <a href="../listing/one?mode=full&amp;sort=new">Build a <strong>website</strong> &amp; dashboard</a>
        <a href='/listing/one?mode=full&amp;sort=new#apply'>Duplicate</a>
        <a href=two>Automation contract</a>
        <a href="//other.test/project">Design project</a>`);
    },
  });
  assert.deepEqual(result.links, [
    { url: 'https://board.test/listing/one?mode=full&sort=new', text: 'Build a website & dashboard' },
    { url: 'https://board.test/contracts/two', text: 'Automation contract' },
    { url: 'https://other.test/project', text: 'Design project' },
  ]);
  assert.deepEqual(requests, ['https://board.test/start', 'https://board.test/contracts/']);
});

test('discovery excludes unsafe, malformed and script-only links', async () => {
  const html = `<p>Public listings</p>
    <a href="javascript:alert(1)">Script</a><a href="jav&#x61;script:alert(1)">Encoded script</a>
    <a href="https://user:pass@board.test/private">Credentials</a>
    <a href="http://127.0.0.1/admin">Local</a><a href="http://metadata.internal/">Internal</a>
    <a href="http://10.0.0.2/">Private</a><a href="http://[::1]/">IPv6 local</a>
    <a href="http://[::ffff:10.0.0.2]/">IPv4 mapped private</a><a href="http://[fe90::1]/">IPv6 link-local</a>
    <a href="https://localhost/">Localhost</a><a href="mailto:buyer@board.test">Mail</a>
    <a href="http://[broken/">Broken URL</a><a data-href="/not-a-link">Missing href</a>
    <a href="#top">Same page</a><a href="">Empty</a>
    <script>const template = '<a href="/script-template">Hidden</a>';</script>
    <!-- <a href="/comment">Comment</a> -->
    <a href="/listing/valid">Public contract</a>`;
  const result = await readPublicPage('https://board.test/contracts', { lookup, fetchImpl: async () => page(html) });
  assert.deepEqual(result.links, [{ url: 'https://board.test/listing/valid', text: 'Public contract' }]);
});

test('discovery bounds URL count and labels independently of the text limit', async () => {
  const html = `<p>Listing index</p>${Array.from({ length: 120 }, (_, i) => `<a href="/project/${i}">${'a'.repeat(250)}</a>`).join('')}`;
  const result = await readPublicPage('https://board.test/contracts', { lookup, fetchImpl: async () => page(html), max_chars: 20 });
  assert.equal(result.links.length, 100);
  assert.equal(result.links[0].text.length, 200);
  assert.equal(result.links.at(-1).url, 'https://board.test/project/99');
  assert.equal(result.text.length, 20);
  assert.equal(result.links_truncated, true);
});

test('HTTP rate limits preserve Retry-After and do not retry or expose challenge links', async () => {
  let requests = 0;
  const result = await readPublicPage('https://board.test/contracts', {
    lookup,
    fetchImpl: async () => {
      requests += 1;
      return page('<title>Too many requests</title><p>Try later</p><a href="/upgrade">Upgrade</a>', { status: 429, headers: { 'Retry-After': '90' } });
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'rate_limited');
  assert.equal(result.status, 429);
  assert.equal(result.retry_after_ms, 90000);
  assert.equal(requests, 1);
  assert.deepEqual(result.links, []);
});

test('rate-limit HTTP-date Retry-After remains usable and invalid values are ignored', async () => {
  for (const [value, expected] of [
    ['Fri, 11 Sep 2026 13:02:00 GMT', 120000],
    ['not-a-date', undefined],
    ['-1', undefined],
  ]) {
    const result = await readPublicPage('https://board.test/contracts', {
      lookup,
      fetchImpl: async () => page('<p>Try later</p>', { status: 429, headers: { Date: 'Fri, 11 Sep 2026 13:00:00 GMT', 'Retry-After': value } }),
    });
    assert.equal(result.retry_after_ms, expected);
    assert.equal(result.error, 'rate_limited');
  }
});

test('HTTP 200 challenge pages are failed reads when title and challenge structure agree', async () => {
  for (const html of [
    '<title>Just a moment...</title><p>Checking your browser</p><script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1"></script>',
    '<title>Verify you are human</title><form id="challenge-form"><div class="h-captcha"></div></form>',
  ]) {
    const result = await readPublicPage('https://board.test/contracts', { lookup, fetchImpl: async () => page(html) });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'captcha');
    assert.equal(result.status, 200);
    assert.match(result.message, /challenge|CAPTCHA/i);
    assert.deepEqual(result.links, []);
  }
});

test('HTTP 200 login forms report required sign-in instead of readable listings', async () => {
  const result = await readPublicPage('https://board.test/contracts', {
    lookup,
    fetchImpl: async () => page('<title>Log in | Contract Board</title><form action="/session"><label>Email<input type="email"></label><label>Password<input type="password"></label><button>Log in</button></form>'),
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'login_required');
  assert.equal(result.status, 200);
  assert.match(result.message, /sign.in|log.in/i);
});

test('normal articles and board pages mentioning challenges remain readable', async () => {
  for (const html of [
    '<title>How CAPTCHA works</title><article>Verify you are human. CAPTCHA improves security.</article>',
    '<title>Contracts</title><p>Log in to apply, or browse public listings.</p><form><input type="password"></form><a href="/project/one">Public project</a>',
    '<title>Just a moment...</title><article>This essay describes browser challenges.</article>',
    '<title>Log in</title><article>A UX analysis of login forms.</article>',
  ]) {
    const result = await readPublicPage('https://board.test/contracts', { lookup, fetchImpl: async () => page(html) });
    assert.equal(result.ok, true);
    assert.equal(result.error, undefined);
  }
});

test('original JobPosting JSON-LD preserves contract terms without executing scripts or mixing related jobs', async () => {
  const url = 'https://board.test/jobs/current';
  const matching = {
    '@type': 'JobPosting', '@id': url, url, title: 'Website project',
    description: '<p>Build a <strong>website</strong>.</p><script>globalThis.webEvidenceExecuted = true</script>',
    employmentType: 'CONTRACTOR', jobLocationType: 'TELECOMMUTE',
    applicantLocationRequirements: { '@type': 'Country', name: ['United States', 'Canada'] },
    hiringOrganization: { '@type': 'Organization', name: 'Example Buyer' },
    baseSalary: { '@type': 'MonetaryAmount', currency: 'USD', value: { '@type': 'QuantitativeValue', minValue: 3000, maxValue: 5000, unitText: 'PROJECT' } },
    datePosted: '2026-09-10', validThrough: '2026-10-10', directApply: true,
    unrelatedToken: 'must not be exposed',
  };
  // Escaping the slash mirrors safe JSON embedded in an HTML script element.
  const json = JSON.stringify({ '@graph': [{ '@type': 'JobPosting', url: 'https://board.test/jobs/related', title: 'Wrong job' }, matching] }).replaceAll('</', '<\\/');
  const result = await readPublicPage(url, { lookup, fetchImpl: async () => page(`<p>Website project</p><script>globalThis.webEvidenceExecuted = true</script><script type="application/ld+json">${json}</script>`) });
  assert.equal(globalThis.webEvidenceExecuted, undefined);
  assert.equal(result.structured_data.job_postings.length, 1);
  const [job] = result.structured_data.job_postings;
  assert.equal(job.title, 'Website project');
  assert.match(job.description, /^Build a website\s*\.$/);
  assert.doesNotMatch(job.description, /<|globalThis|script/);
  assert.equal(job.employmentType, 'CONTRACTOR');
  assert.equal(job.jobLocationType, 'TELECOMMUTE');
  assert.deepEqual(job.applicantLocationRequirements.name, ['United States', 'Canada']);
  assert.equal(job.baseSalary.value.minValue, 3000);
  assert.equal(job.validThrough, '2026-10-10');
  assert.equal(job.unrelatedToken, undefined);
});

test('malformed JSON-LD is ignored and long structured descriptions are bounded', async () => {
  const result = await readPublicPage('https://board.test/jobs/current', {
    lookup,
    fetchImpl: async () => page(`<p>Public page</p><script type="application/ld+json">not JSON</script>
      <script type="application/ld+json">${JSON.stringify({ '@type': 'JobPosting', title: 'Current role', description: 'x'.repeat(50000) })}</script>`),
  });
  assert.equal(result.ok, true);
  assert.equal(result.structured_data.job_postings.length, 1);
  assert.ok(result.structured_data.job_postings[0].description.length <= 12000);
  assert.equal(result.structured_data.truncated, true);
});

test('query-key job identities cannot import another listing salary', async () => {
  const graph = { '@graph': [
    { '@type': 'JobPosting', url: 'https://board.test/viewjob?jk=current&lang=en', title: 'Current job', baseSalary: { currency: 'USD', value: 3000 } },
    { '@type': 'JobPosting', url: 'https://board.test/viewjob?jk=related&lang=en', title: 'Related job', baseSalary: { currency: 'USD', value: 90000 } },
  ] };
  const result = await readPublicPage('https://board.test/viewjob?lang=en&jk=current', {
    lookup, fetchImpl: async () => page(`<p>Current job</p><script type="application/ld+json">${JSON.stringify(graph)}</script>`),
  });
  assert.equal(result.structured_data.job_postings.length, 1);
  assert.equal(result.structured_data.job_postings[0].title, 'Current job');
  assert.equal(result.structured_data.job_postings[0].baseSalary.value, 3000);
});

test('other page JSON is not surfaced as structured data', async () => {
  const html = '<p>Listing</p><script id="page-state" type="application/json">{"job":{"title":"Hidden","session":"not-for-output"}}</script>';
  const result = await readPublicPage('https://board.test/listing/one', { lookup, fetchImpl: async () => page(html) });
  assert.deepEqual(result.structured_data, { job_postings: [], truncated: false });
  assert.doesNotMatch(JSON.stringify(result), /not-for-output/);
});
