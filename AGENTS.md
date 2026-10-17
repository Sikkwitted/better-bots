# Better Bots: instructions for coding and review agents

These requirements apply to every agent and model working on this repository,
and to people using one.

**Memory runs on SQLite built into Node by default. Hindsight is optional** and is
used only when `HINDSIGHT_URL` is set. Users must never be required to install
Hindsight or PostgreSQL. Local memory files are the durable source records; the
engine can be rebuilt from them.

- Read [the memory contract](docs/MEMORY-CONTRACT.md) before touching memory,
  retention, host startup, service users, filesystem permissions, migration,
  health or backups.
- Hindsight must stay optional. On a host configured for Hindsight, do not
  disable it, remove its configuration, or mark its failed jobs resolved just to
  make checks pass.
- Standing knowledge changes only through verified consolidation (see the contract).
- Before claiming a change is done, run all three and report the results:
  `npm test`, `npm run test:browser`, and `npm run demo`.
- Passing tests, a successful chat, an active service, or an `ok` health response
  alone do not prove memory works. Verify retention and recall with the evidence
  the contract specifies, or report them as unverified.
- Keep changes focused. Preserve unrelated edits, and say plainly what was verified
  locally and what was not.
