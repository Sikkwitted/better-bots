# Contributing to Better Bots

Thanks for helping. Better Bots is preview software, so expect things to move.
Read [AGENTS.md](AGENTS.md) before changing behavior, and follow the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Local development

Use Node 22.13 or later. From a fresh checkout:

```sh
npm ci
npm test
npx playwright install chromium
npm run test:browser
npm run demo
```

None of these need provider credentials. Browser checks run against isolated
local fixture hosts. Linux sandbox tests need bubblewrap with permission to create
user namespaces; on Ubuntu, `deploy/bootstrap.sh` installs a per-program AppArmor
profile for this, and CI does the same. A test skipped on macOS is not evidence of
Linux isolation.

To open a development console, run `npm run gui` and open the login link it
prints. State lives in `.data/`. Never use real credentials or a real state
directory for tests.

## Changes and verification

Keep changes focused. Add a regression test when fixing behavior, especially
permissions, scope boundaries, durable writes, cancellation or recovery.

Before asking for review, run all three:

```sh
npm test
npm run test:browser
npm run demo
```

In the pull request, say what changed, why, which checks you ran, and what remains
unverified. The [pull request template](.github/PULL_REQUEST_TEMPLATE.md) asks for
this.

## Memory changes

Changes that touch memory, retention, health, service permissions or backups must
follow the [memory contract](docs/MEMORY-CONTRACT.md). Memory runs on SQLite by
default and Hindsight is optional; keep it that way. Passing unit tests do not
prove memory works on a real host, so report any acceptance step you could not run.
`tools/memory-eval.mjs` makes paid extraction calls against a configured Hindsight
service; it is not a unit test and CI does not run it.

## AI-assisted contributions

Contributions written with AI assistance are welcome. You are responsible for the
change: read it, understand it, run the checks above, and be ready to explain it in
review. Do not submit code you have not verified.

## Privacy and security

Keep credentials, transcripts, screenshots, state, database dumps and private
deployment details out of contributions. Report vulnerabilities privately through
the process in [SECURITY.md](SECURITY.md), not in a public issue.

## License

By contributing, you agree that your contribution is licensed under Apache-2.0;
see [LICENSE](LICENSE), [NOTICE](NOTICE), and [THIRD_PARTY.md](THIRD_PARTY.md).
