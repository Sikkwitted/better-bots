// Integrations the console offers by name. Shared by the browser (the panel)
// and the server (the presets), like web/models.js — no DOM here.
//
// Each is a vendor's own hosted MCP server. `url` is fixed when the vendor has
// one endpoint; when every user gets their own URL (Composio) the person may
// paste it. `sign_in` means the person signs in with the vendor in their browser
// (OAuth with dynamic client registration; nothing to copy). `secret` says which
// header carries a key instead. Any other MCP server connects through the
// custom form with the same fields.
//
// Sign-in presets are vendors whose MCP server publishes OAuth metadata and
// accepts dynamic client registration. Vendors that only admit pre-approved
// partners are left out.

const signIn = (label, url, note) => ({ label, transport: 'http', url, sign_in: true, trust: 'annotations', note });

export const INTEGRATIONS = {
  github: {
    label: 'GitHub',
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    secret: { header: 'Authorization', prefix: 'Bearer ', label: 'GitHub personal access token', where: 'github.com → Settings → Developer settings → Personal access tokens' },
    trust: 'annotations',
    note: 'Repositories, issues, pull requests and code search.',
  },
  notion: signIn('Notion', 'https://mcp.notion.com/mcp', 'Search, read and write pages and databases.'),
  linear: signIn('Linear', 'https://mcp.linear.app/mcp', 'Issues, projects and comments.'),
  atlassian: signIn('Jira and Confluence', 'https://mcp.atlassian.com/v1/mcp', 'Atlassian issues and pages.'),
  airtable: signIn('Airtable', 'https://mcp.airtable.com/mcp', 'Bases, tables and records.'),
  monday: signIn('monday.com', 'https://mcp.monday.com/mcp', 'Boards, items and updates.'),
  intercom: signIn('Intercom', 'https://mcp.intercom.com/mcp', 'Customer conversations and contacts.'),
  granola: signIn('Granola', 'https://mcp.granola.ai/mcp', 'Your meeting notes.'),
  canva: signIn('Canva', 'https://mcp.canva.com/mcp', 'Find, create and export designs.'),
  stripe: signIn('Stripe', 'https://mcp.stripe.com', 'Customers, payments and invoices. Charges and refunds ask first.'),
  paypal: signIn('PayPal', 'https://mcp.paypal.com/mcp', 'Invoices, orders and transactions. Payments ask first.'),
  square: signIn('Square', 'https://mcp.squareup.com/mcp', 'Orders, catalog, customers and payments. Payments ask first.'),
  sentry: signIn('Sentry', 'https://mcp.sentry.dev/mcp', 'Errors, issues and releases.'),
  vercel: signIn('Vercel', 'https://mcp.vercel.com', 'Projects, deployments and logs.'),
  netlify: signIn('Netlify', 'https://netlify-mcp.netlify.app/mcp', 'Sites, deploys and settings.'),
  supabase: signIn('Supabase', 'https://mcp.supabase.com/mcp', 'Projects, databases and SQL.'),
  neon: signIn('Neon', 'https://mcp.neon.tech/mcp', 'Postgres projects, branches and SQL.'),
  webflow: signIn('Webflow', 'https://mcp.webflow.com/mcp', 'Sites, pages and CMS content.'),
  wix: signIn('Wix', 'https://mcp.wix.com/mcp', 'Sites, stores and bookings.'),
  huggingface: signIn('Hugging Face', 'https://huggingface.co/mcp', 'Models, datasets, papers and Spaces. Works without signing in; sign in for your own account.'),
  context7: signIn('Context7', 'https://mcp.context7.com/mcp', 'Current documentation for code libraries. Works without signing in.'),
  zapier: signIn('Zapier', 'https://mcp.zapier.com/api/mcp/mcp', 'Thousands of apps through the actions you enable in Zapier. Actions ask.'),
  composio: {
    label: 'Composio (hundreds of apps)',
    transport: 'http',
    url: 'https://connect.composio.dev/mcp',
    url_editable: true,
    url_hint: 'Composio Connect signs you in with a browser. Or paste a per-server URL like https://backend.composio.dev/v3/mcp/<server>?user_id=<you> with your API key',
    sign_in: true,
    secret: { header: 'x-api-key', prefix: '', label: 'Composio API key (only for a backend.composio.dev URL)', optional: true },
    trust: 'annotations',
    note: 'Gmail, Google Calendar, Slack, and whatever else you connect in Composio. Actions ask.',
  },
};

export const INTEGRATION_IDS = Object.keys(INTEGRATIONS);

/**
 * A preset plus what the person typed -> the spec IntegrationService takes.
 * `key` fills the secret header; `url` overrides or supplies the endpoint.
 */
export function specFromPreset(id, { key = '', url = '', name = id } = {}) {
  const preset = INTEGRATIONS[id];
  if (!preset) return null;
  const spec = { name, trust: preset.trust };
  if (preset.transport === 'stdio') {
    return { ...spec, command: preset.command, args: preset.args };
  }
  const endpoint = (url || preset.url || '').trim();
  const headers = {};
  if (key.trim() && preset.secret) headers[preset.secret.header] = `${preset.secret.prefix ?? ''}${key.trim()}`;
  return { ...spec, url: endpoint, headers };
}
