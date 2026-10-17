#!/usr/bin/env bash
#
# better-bots — one entry point for the Better Bots agent host.
#
#   ./better-bots.sh setup          install, test, and report whether agents can think
#   ./better-bots.sh doctor         readiness check, spends nothing
#   ./better-bots.sh smoke          ONE bounded call on the host default route (may cost money)
#   ./better-bots.sh create Ada researcher
#   ./better-bots.sh ask Ada "find the best checkout pattern"
#   ./better-bots.sh send Ada Bo "Goal: ..." --priority=supersede
#   ./better-bots.sh room "ship or not?" Ada Bo
#   ./better-bots.sh status | audit | explain <run_id> | recover
#
# Agents persist in $BETTER_BOTS_DIR (default ./.data), so every command sees the same
# registry, inboxes, memory, and audit log.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

export BETTER_BOTS_DIR="${BETTER_BOTS_DIR:-$ROOT/.data}"

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
dim()  { printf '\033[2m%s\033[0m\n' "$1"; }
die()  { printf '\033[31merror:\033[0m %s\n' "$1" >&2; exit 1; }

command -v node >/dev/null 2>&1 || die "node is not installed (need Node 22.13+)"

cmd="${1:-help}"
[ $# -gt 0 ] && shift

case "$cmd" in

  setup)
    bold "1/3  Installing"
    npm install --silent
    bold "2/3  Running the test suite"
    npm test --silent 2>&1 | grep -E '^# (tests|pass|fail)' || die "tests failed — run 'npm test' to see why"
    bold "3/3  Readiness"
    if node src/cli.js doctor; then
      echo
      dim "Next:  ./better-bots.sh create Ada researcher"
      dim "       ./better-bots.sh ask Ada \"what should we build first?\""
    else
      echo
      dim "The host is installed and correct, but agents cannot think yet."
      dim "Fix the warnings above, then re-run: ./better-bots.sh doctor"
      exit 1
    fi
    ;;

  smoke)
    bold "Live check"
    echo "This makes ONE real model request using the host default route; it may cost money."
    printf 'Continue? [y/N] '
    read -r reply
    case "$reply" in
      [yY]*) ;;
      *) echo "cancelled — nothing was sent."; exit 0 ;;
    esac
    # Same selection/catalog as callers, but no Host tools or follow-up turns.
    # Hard bounds override interactive settings only in this subprocess.
    BETTER_BOTS_MAX_TOKENS=2048 BETTER_BOTS_EFFORT=low BETTER_BOTS_CODEX_EFFORT=low \
      BETTER_BOTS_TIMEOUT_MS=120000 BETTER_BOTS_LOCAL_TIMEOUT_MS=120000 node --input-type=module -e '
      import { buildAdapter } from "./src/model/build-adapter.js";

      // A transport timeout may end at response headers; bound the whole process.
      const deadline = setTimeout(() => {
        console.error("FAIL: Smoke timed out after 120 seconds.");
        process.exit(1);
      }, 120_000);
      // Discovery may refresh credentials with POST. Only start the inference
      // allowance after routing selects a model, before its adapter starts.
      const send = globalThis.fetch;
      let selected = null;
      let posted = false;
      globalThis.fetch = (input, init) => {
        if (selected && (init?.method ?? input?.method ?? "GET").toUpperCase() === "POST") {
          if (posted) throw new Error("Smoke will not retry an inference request.");
          posted = true;
        }
        return send(input, init);
      };
      try {
        const adapter = buildAdapter();
        if (adapter.provider === "scripted") throw new Error("Model provider not configured; scripted replies cannot verify the live path.");
        let text = "";
        let completed = false;
        for await (const event of adapter.stream([
          { role: "user", content: "Reply with one short sentence confirming you are reachable." },
        ], [], {})) {
          if (event.type === "model_selected") {
            selected = event;
            // The subscription adapter does not support an output-token cap.
            // Refuse before its stream starts; never substitute a paid API.
            if (event.provider === "codex") throw new Error("Bounded smoke unavailable for codex: no output-token cap; no inference request sent.");
          }
          if (event.type === "text") text += event.text;
          if (event.type === "tool_call") throw new Error("Unexpected tool call; smoke will not run tools or send another request.");
          if (event.type === "done") completed = ["end_turn", "stop"].includes(event.stop_reason);
        }
        if (!selected || !completed || !text.trim()) throw new Error("No complete text reply from the selected model.");
        console.log(`\nprovider:  ${selected.provider}`);
        console.log(`model:  ${selected.model}`);
        console.log(`reply:  ${text}`);
        console.log(`usage:  ${JSON.stringify(adapter.reportUsage())}`);
        console.log("\nLive path verified for this provider/model.");
      } catch (error) {
        console.error(`FAIL: ${error.message}`);
        process.exitCode = 1;
      } finally {
        clearTimeout(deadline);
      }
    '
    ;;

  gui|serve|web)
    port="${BETTER_BOTS_PORT:-4173}"
    # The console always asks for a token. The host keeps its own in the data
    # folder unless BETTER_BOTS_TOKEN is set; the link below signs this browser in.
    token_file="$BETTER_BOTS_DIR/console-token"
    if [ -n "${BETTER_BOTS_TOKEN:-}" ]; then
      bold "better-bots console  http://127.0.0.1:$port  (sign in with BETTER_BOTS_TOKEN)"
    elif [ -r "$token_file" ]; then
      bold "better-bots console  http://127.0.0.1:$port/#token=$(cat "$token_file")"
    else
      bold "better-bots console  http://127.0.0.1:$port  (first start: the login link is printed below)"
    fi
    if ! node src/cli.js doctor >/dev/null 2>&1; then
      dim "No model provider — replies will be a scripted stand-in. ./better-bots.sh doctor explains."
    fi
    BETTER_BOTS_PORT="$port" exec node src/server.js
    ;;

  test)  npm test ;;
  demo)  npm run demo ;;

  reset)
    printf 'Delete every agent, transcript, memory, and audit record in %s? [y/N] ' "$BETTER_BOTS_DIR"
    read -r reply
    case "$reply" in
      [yY]*) rm -rf "$BETTER_BOTS_DIR"; echo "cleared $BETTER_BOTS_DIR" ;;
      *) echo "kept." ;;
    esac
    ;;

  help|-h|--help)
    bold "$(node -e "import('./src/core/version.js').then(m=>console.log(m.BANNER))" 2>/dev/null || echo "Better Bots")"
    echo
    echo "  gui                      start the chat console and print its login link"
    echo "  setup                    install, test, and check readiness"
    echo "  smoke                    one bounded call on the host default route (may cost money)"
    echo "  test | demo | reset"
    echo
    node src/cli.js help | tail -n +2
    echo
    dim "store: $BETTER_BOTS_DIR"
    ;;

  # Everything else is an operator command against the live store.
  *) node src/cli.js "$cmd" "$@" ;;

esac
