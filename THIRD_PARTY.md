# Third-party components

This inventory does not replace the licenses distributed by each component.
Keep their license and notice files when redistributing them. Better Bots' own
code, original documentation, and bot artwork are licensed under Apache-2.0;
see [LICENSE](LICENSE) and [NOTICE](NOTICE).

## Node packages

Direct dependencies, as pinned in `package-lock.json`:

| Component | Version | Declared license | Source |
|---|---|---|---|
| noVNC | 1.7.0 | MPL-2.0 | https://github.com/novnc/noVNC |
| ws | 8.21.3 | MIT | https://github.com/websockets/ws |
| Anthropic TypeScript SDK (optional) | 0.72.1 | MIT | https://github.com/anthropics/anthropic-sdk-typescript |

`npm ci` installs these dependencies separately. Review all transitive package
notices too if publishing a bundle that includes `node_modules` or bundled code.

## Optional and system components

Memory runs on SQLite built into Node by default. The deployment scripts can
also install system packages separately: bubblewrap, desktop and PDF tools, and,
only when you choose the optional Hindsight memory engine, Hindsight 0.9.2,
FlashRank 0.2.10, embedding and ranking model files, PostgreSQL and pgvector. A
container, appliance or prebuilt distribution that includes those components
needs its own complete license and notice inventory, including model weights.
The project's license does not replace their licenses.

## Bot artwork

The avatar artwork in `web/avatars/` and `tools/avatars/` is original work for
this project, licensed under the project license. It was created with
AI image-generation assistance. The scripts that build `web/avatars/` from the
source renders are in `tools/avatars/`.
