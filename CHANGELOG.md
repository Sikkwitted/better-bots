# Changelog

All notable changes to Better Bots are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html). Until 1.0, minor
releases may change behaviour and stored data formats.

## [0.1.0] - Unreleased

The first public preview: a self-hosted harness for running several persistent
bots on your own machine, from a web console or the `better-bots` CLI.
Requires Node 22.13 or newer.

### Added

- **Bots and desks.** Persistent bots with their own profile, chat, model and
  workflows, each working at a desk that can be paused, with a durable
  run queue that survives restarts and recovers interrupted work without
  replaying it blindly.
- **Rooms.** Bounded meetings between bots with hard limits on members, rounds
  and messages. Each room chooses where its outcome is remembered: by its
  members only (the default), in the room alone (members' desks never recall
  it), in shared project memory, or nowhere. When a bot posted the request, the
  room's outcome comes back to that bot as a message.
- **Solo verifier rooms.** A one-member room gives a fresh-context second
  opinion: one round and one model call per request.
- **Scoped memory.** Agent, user and project scopes with budgeted recall,
  stored in local files and indexed in SQLite built into Node. Hindsight is an
  optional engine (`HINDSIGHT_URL`); nothing else needs installing. Standing
  knowledge changes only through cited, separately verified consolidation.
- **Permissions and audit trail.** Consequential actions ask for approval
  (allow once, deny, always, never), and every run, decision and memory write is
  recorded in an audit log the console and `better-bots explain` can show.
- **Sandboxed shell.** Shell commands run inside a process boundary that keeps
  host tools out of the data folder.
- **Desktops on Linux.** Bots can be given their own virtual desktop to see and
  operate, viewable from the console.
- **Scheduled routines.** Cron, interval and one-shot automations run in their
  own lane on the host.
- **MCP plugins.** Connect Model Context Protocol servers (local commands or
  HTTP, including sign-in flows); each tool is classified and reviewed before
  bots may use it.
- **Multiple providers.** Anthropic, OpenAI, OpenRouter, DeepSeek, Z.ai, local
  Ollama, a ChatGPT subscription, or any OpenAI-compatible endpoint you add.

### Security

- The console sends a script-restricting Content-Security-Policy, `nosniff` and
  `no-referrer`, and refuses an operator-chosen token under 32 characters.
- OAuth metadata from a public MCP server may only name public `https` URLs;
  redirects are not followed.
- Credential files are created private (0600), and a new data folder 0700.
- `LocalReadFile` reads only regular files up to 10 MB, from the descriptor it
  checked; folder imports refuse instruction files linked outside the folder.
- The nightly backup writes into the data folder as the service user, the
  sudoers rule is passwordless only for read-only CLI commands, package installs
  never run install scripts as root, and the service unit adds further systemd
  hardening. See [SECURITY.md](SECURITY.md) for the threat model and known
  limitations.

[0.1.0]: https://github.com/Sikkwitted/better-bots/releases/tag/v0.1.0
