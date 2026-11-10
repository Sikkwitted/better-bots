# Real desktops on macOS

Requires the installed Docker Desktop daemon. Build the project's image:

```sh
docker build -t better-bots-desktop:1 deploy/desktop
BETTER_BOTS_DESKTOP=docker npm run gui
```

The Docker backend is explicit and fails with a useful error if its image or daemon
is unavailable. It never silently substitutes a fake successful screen. The
default remains the existing platform selection; Linux Xvfb remains supported.

Each assigned surface runs a real X display, Firefox, and noVNC inside a separate
container in Docker's VM. The host workspace is read-only. Host state, home,
credentials, and the Docker socket are not mounted. Writable browser state is
ephemeral; container resources are bounded. Each surface has its own Docker
network; viewing ports bind only to host loopback. Docker Desktop remains trusted
host infrastructure. These are virtual Linux desktops on Mac, not macOS desktops.

OpenScreen returns the viewing URL. The chat header exposes View / take over once
the agent has opened a surface. User input through noVNC reaches that same surface.
Agent actions still require their ownership token and follow the external zone's permission.

Release destroys the browser session and its network. A later owner receives a
new token and clean session. After host restart, opening an assigned surface resets
its orphaned container instead of adopting old browser processes. Shutdown removes
only resources labelled for that host state directory, including orphan networks.
It never stops containers belonging to other applications.

Run the real acceptance probe explicitly:

```sh
node test/docker-desktop-live.mjs
```

`BB_DESKTOP_HOLD=1` holds after independent browser input for manual takeover
verification. Send SIGTERM to that probe to continue release/restart checks and
cleanup. The probe uses two temporary containers and removes them in `finally`.
