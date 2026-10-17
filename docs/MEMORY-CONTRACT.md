# Better Bots memory contract

This is the authoritative memory contract for implementation, review, deployment
and completion decisions. Users must never need to install, run or administer
Hindsight or PostgreSQL to get working memory.

## Required architecture

Memory works out of the box on **SQLite built into Node** (`node:sqlite`, Node 22.13+).
**Hindsight is optional**: it is used only when `HINDSIGHT_URL` names one.
`BETTER_BOTS_MEMORY_ENGINE=sqlite|hindsight|local` overrides the choice.

| Layer | Responsibility |
|---|---|
| Local transcripts, scoped fact shards and retention journal | Durable source records, scope enforcement, recovery evidence. The engine can always be rebuilt from them (`tools/replay-memory.mjs`). |
| `MemoryService` and `MemoryRetention` | Budgeted agent/user/project memory, durable write tracking, safe retries and reconciliation. At most `MAX_IN_FLIGHT` (2) async extraction jobs are outstanding at once. |
| `SqliteEngine` (default) | Full-text ranked recall (BM25, Porter stemming), per-bank isolation, secret redaction. No model call per retained passage. File: `<data>/memory/memory.sqlite`. |
| `HindsightEngine` (optional) | Hindsight bank configuration, extraction, semantic retrieval. Needs its own PostgreSQL. |
| `MemoryConsolidation` (both engines) | Verified standing knowledge, see below. |
| Turn compaction (`src/context-compaction.js`) | At 70% of the context window, older steps of a running turn are summarised; the latest two steps stay verbatim. |

A host running on SQLite is **fully supported, not degraded**. A host configured
for Hindsight whose Hindsight is unreachable is degraded until it recovers or is
switched to SQLite. Local word-overlap ranking (`local`) remains a fallback for
engine outages and for Node builds without `node:sqlite`.

Each retention job records the engine it was queued for. With no engine (`local`)
a save is complete once written locally (`local_saved`; room outcomes also become a
local fact so they stay recallable). After an engine change, unsent jobs queued for
the previous engine are `held`, not sent: startup logs one line, and
`better-bots memory release-held` sends them to the engine configured now
(`tools/replay-memory.mjs` rebuilds a new engine from the files). Finished jobs
older than 30 days are pruned from `memory/retention.json` at startup.

## Verified memory changes

Standing knowledge (the "what you know" block in every prompt) changes only
through `MemoryConsolidation`, never directly from a model's output:

1. Every proposed statement cites evidence labels from the saved facts and
   retained exchanges it was shown. An uncited statement, or a citation to a
   label that was not shown, rejects the whole proposal.
2. A second, separate model call sees each statement beside the exact text of
   the evidence it cites and judges whether it is supported. Unsupported
   statements are dropped; if none survive, nothing changes.
3. If the evidence changed while the run was checking, the result is discarded
   and the bank is retried later.
4. The previous verified knowledge stays in force until a replacement passes.

Verified knowledge takes precedence over Hindsight's own unverified mental
models. Runs happen at most daily per bank, only for banks with new evidence,
one bank at a time (`better-bots consolidate` forces a run). Direct saves the
user or an agent chooses on purpose (`Remember`, Memory panel corrections) are
stored as written and are not model-verified.

Relevant code: `src/services/memory-service.js`, `memory-retention.js`,
`memory-engine.js`, `sqlite-engine.js`, `memory-consolidation.js`,
`src/context-compaction.js`; wiring in `src/server.js` and `src/cli.js`.

## What agents must not infer

These rules apply to whichever engine is configured. Where they name Hindsight
or PostgreSQL, they apply only to hosts configured for Hindsight.

- Hindsight must stay optional. Do not make it, or PostgreSQL, a requirement.
- A passing unit suite may use fake engines or local-only storage. It does not
  prove the configured engine works on a real host.
- `systemctl is-active` can catch a service between failed restarts. Check its
  actual endpoint, restart behavior and, for Hindsight, database readiness.
- Chat can succeed using local fallback while the configured engine is unavailable.
- A queued or asynchronous retention acknowledgement is not a completed write.
- An `ok` host health response or a successful backup exit code is not
  sufficient evidence by itself.

Do not remove a host's configured Hindsight settings, silently switch a Hindsight
host to another engine, abandon failed jobs, suppress errors, or loosen
scope/isolation to claim completion. Do not replay uncertain writes blindly.
Diagnose the failure and preserve evidence.

## Memory acceptance

Before saying memory is healthy, or that a change affecting memory has passed on
a real host, record evidence for the following.

Every host:

1. The configured engine opens. For SQLite, the data folder's
   `memory/memory.sqlite` opens and the host reports `engine: 'sqlite'`.
2. A bounded, authorized test exchange or a suitable recent real exchange
   reaches a durable `succeeded` retention job. For asynchronous writes, inspect
   the operation's completed outcome, not just its acceptance.
3. A subsequent scoped recall retrieves the expected retained content through the
   configured engine. Local fallback or a fact still in the current chat is not
   proof. Preserve agent/user/project scope boundaries.
4. Inspect unfinished retention jobs, their ages, attempts and errors. Account for
   old failures separately from the fresh probe. A successful new write does not
   resolve earlier uncertain jobs.
5. Health reporting surfaces a persistent memory failure between retry attempts.
   A quiet recent audit window must not erase an ongoing outage.
6. Backups cover the local Better Bots state and distinguish partial from
   complete success. For recovery-readiness claims, verify a restore in
   isolation; the existence of an archive is not a restore test.

Additionally, when Hindsight is configured:

- Its endpoint is reachable, the PostgreSQL cluster accepts connections, and
  Hindsight is stable rather than repeatedly restarting.
- The retention job in step 2 has provider confirmation of extraction, and the
  recall in step 3 comes from Hindsight.
- Backups include the Hindsight database as well as local state.

Use existing read-only evidence first. If a write probe, service restart or restore
is outside the task's authorization, report the missing verification explicitly
and continue authorized work.

## Deployment and permission changes

Changes to service accounts, groups, directory permissions, migrations and backup
paths can break the memory store, or PostgreSQL when Hindsight is configured,
even when the Better Bots web service still runs. Inspect the actual owners and
service configuration before changing them; never apply blanket ownership changes
across `/var/lib`. After an authorized change affecting these dependencies, verify
them as well as Better Bots.

Reference deployment paths (verify before using): `/opt/better-bots` and
`/var/lib/better-bots`. With Hindsight, also `/opt/hindsight`, `/var/lib/hindsight`
and PostgreSQL's data directory; its services include `hindsight` and a versioned
PostgreSQL cluster. The generic `postgresql.service` wrapper alone is not database
readiness.
