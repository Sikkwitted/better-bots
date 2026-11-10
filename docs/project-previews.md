# Dependency downloads and static previews

This is a supported static frontend workflow. It does not provide arbitrary
long-running backend servers, general npm dependency resolution, or unrestricted
shell networking.

1. Obtain the exact tarball URL and publisher SHA-512 integrity for an npm package.
2. Call `FetchDependency` with `url`, `integrity`, and an agent-relative output
   `path`. The download runs without asking unless the external zone is set to Ask
   (approval for this exact download) or Never (blocked).
3. Decode the saved base64 inside `SandboxRunCommand`, for example
   `base64 -d < dependency.b64 > dependency.tgz`. Extract and use the package
   inside the agent working directory. No scripts execute during the download.
4. Build the frontend using the sandbox's existing toolchain. Use `set -eu` in
   multi-command build scripts so an earlier failure cannot be hidden.
5. Call `StartPreview` with the build `directory` and an explicit list of static
   `files` including `index.html`.
6. Share the returned URL with the reviewer. Local browsers use `url`; the Docker
   desktop backend on Mac uses `docker_url`. Screen actions follow the external zone's permission.
7. After changing the build, start a new snapshot and review it. Stop old previews
   with `StopPreview` or the chat header's Stop preview control.

Downloads accept only HTTPS npm registry tarballs, reject redirects, verify
integrity before committing bytes, cap size at 8 MiB, and use the existing safe
file transaction worker. Downloads do not enable network access inside the shell.

Previews serve immutable snapshots of declared HTML, JavaScript, CSS, SVG, JSON,
and text files. Binary assets and backend APIs are unsupported. At most four
previews run concurrently, each with at most 100 files and 8 MiB total content.
Symlink and traversal reads fail through the file transaction boundary. A preview
cannot proxy arbitrary localhost services; its CSP restricts subresources,
connections, and forms to its own origin. Ports bind only to host loopback.

The HTTP listener belongs to the host process, so it survives individual agent
turns but cannot become an orphaned child server. Its record tracks originating
run, host PID, file revisions, URL, status, and up to twenty recent requests.
Cancellation of the originating run or automation closes the listener. Host
shutdown closes listeners; restart marks former previews stopped without resuming.
The user can list and stop previews through `/api/previews` and
`POST /api/previews/stop` with `preview_id`.

Verification:

```sh
node --test test/project-preview.test.js
node test/project-preview-live.mjs
```

The live probe downloads pinned htmx 2.0.4, builds in the real sandbox, opens the
preview on an independent Docker reviewer surface, fixes the fixture, reopens the
new snapshot, and cleans up. `BB_PREVIEW_HOLD=1` pauses for actual browser
interaction; SIGUSR1 advances the fixture. SIGTERM during a pause cleans up.
`BB_PREVIEW_LOCAL_ONLY=1` omits Docker and explicitly does **not** prove the
independent Better Bots desktop portion.
