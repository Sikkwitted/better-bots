# Security

Better Bots can run tools, operate browsers and call external services. Treat
access to its console and state directory as privileged access to the host.

## Reporting a vulnerability

Report privately through GitHub: the repository's **Security → Report a
vulnerability** form (private vulnerability reporting). Include the affected
revision, reproduction steps, expected and actual behavior, and a minimal example
with synthetic data. No response time or supported-release policy has been
established yet.

Never post API keys, access tokens, browser cookies, transcripts, customer data,
database dumps or a working exploit against someone else's deployment in a public
issue. Test only systems you own or have permission to test.

## Threat model

What the host enforces today, and what it does not.

**The console always needs a token.** Without `BETTER_BOTS_TOKEN` the host creates
a random one on first start in `<data dir>/console-token` (mode 600) and reuses it.
Startup prints a login link, `http://127.0.0.1:<port>/#token=…`; the page trades
the fragment for an HttpOnly, SameSite=Strict cookie and removes it from the
address bar. Scripts send `Authorization: Bearer <token>`. Binding beyond
loopback is refused without a token. Anyone who can read the data folder, or the
startup log, can sign in.

**Browser-side protections.** Mutations whose `Origin` is not the console are
refused. A tokenless console (only possible when embedding `createServer`
directly) answers only requests whose `Host` is a loopback name, which defeats
DNS rebinding. Every response sends `X-Frame-Options: DENY` and a
`Content-Security-Policy` with `frame-ancestors 'none'`, so no other site can frame
the console and steer clicks on approval cards, and `script-src 'self'`, so only
the console's own scripts run even if model output ever slipped past rendering.
An operator-chosen `BETTER_BOTS_TOKEN` must be at least 32 characters.

**Sign-in metadata is only as trusted as its server.** An MCP server's OAuth
metadata decides which URLs the host fetches and which page your browser opens.
For a public server those must be public `https` URLs; this machine, its network
and other schemes are refused, and redirects are not followed.

**Agent shell commands run in an OS sandbox, or not at all.** On Linux,
bubblewrap gives each command its own namespaces, a read-only workspace, one
writable agent directory and no network. On macOS, Seatbelt allows writes only in
the agent's directory, denies the network to shell commands, and denies reads of
your home folder, `/private/var/folders`, `/private/tmp` (`/tmp`) and `/Volumes`
except the workspace itself; it also denies the clipboard (pasteboard) services.
It does not hide the rest of the filesystem a normal user can read (system
folders, `/Users/Shared`, other readable locations), other system services, or
the fact that commands run as your user. Sandbox commands run without asking on
both systems unless you choose Ask for the bots' workspace. Without either
sandbox, shell execution fails closed.

**Bots are autonomous by default.** Every action runs without asking: reading and
changing host files and running host commands outside the sandbox, clicks and
typing in a bot's own browser and desktop (a bot signed in to a site acts there
as you), calls to connected tools nobody has reviewed (`external.unclassified`),
and paying, credential changes, publishing, sending and deleting. The installer
says so and installs only after you type `yes` (`BETTER_BOTS_ACCEPT_AUTONOMY=yes`
answers for an unattended install), and the console says so again the first time
it opens. Each action belongs to a zone with a standing mode (Always, Ask, Never)
under an administrator ceiling: choose Ask or Never for a zone to review or block
its actions, or have an administrator lower the ceiling.

**Shared memory is untrusted.** Every bot sees user and project memory. A fact a
bot writes there is kept as a note (log tier), recalled when relevant, never as a
standing profile fact; only your corrections from the console's memory panel
become standing shared facts. The prompt labels each shared line with who wrote
it and tells the model these are notes, not instructions. Page text, tool output
and peer messages remain untrusted input to every model.

**Integrations run code.** Adding a custom MCP server with a command starts that
program on the host, as the host's user, on every connect. The API requires the
request to repeat the command (`confirm_command`), and the console asks you on
screen first. Hosted (URL) integrations receive whatever arguments their tools are
called with.

**Memory engine.** Memory is SQLite built into Node, in the data folder, by
default. Hindsight is optional (`HINDSIGHT_URL`); neither it nor PostgreSQL is
required.

## Known limitations

**A bot's own desktop is not network-isolated (Linux).** Apps on a bot's desktop,
its browser and file manager, run with the host's network, including loopback.
Each desktop's display and viewer accept local connections without a password.
A bot that gets a program of its own running there, for example a script opened
from the file manager, can reach services on the host's loopback, including other
bots' desktops. Shell commands are not affected: they run in the sandbox with no
network. Until desktops get their own network namespace, give bots a desktop only
on a machine where that is acceptable, set the external zone to Ask if you want
to review what they do there, and keep other sensitive services off that host.

## Deployment boundaries

- Keep the console on loopback and use an SSH tunnel. Publish it only behind TLS,
  with a `BETTER_BOTS_TOKEN` of at least 32 characters.
- Run the service as its dedicated user. Keep credentials and state outside the
  source checkout with restrictive permissions.
- Review permissions and integration trust. Every zone starts at `Always`;
  `Ask` requires the applicable approval and `Never` blocks the action.
- Back up the data folder (and the Hindsight database, if you use one), verify
  isolated restores, and keep backups private.

See the [memory contract](docs/MEMORY-CONTRACT.md) for verification requirements.
