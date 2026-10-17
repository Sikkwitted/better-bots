# Better Bots on Linux Mint and Ubuntu

One installer for **Linux Mint 22.x or Ubuntu 24.04, 64-bit Intel/AMD**. Mint 21.x
and LMDE are not supported. It needs internet access and an administrator
password. It installs Better Bots as a background service and adds **Better Bots**
to the application menu, which opens the app in its own window.

It ships no bots, workflows, credentials or chats. Avatar artwork is a
customization library, not a roster of installed bots.

## Building

From a checkout of this repository:

```sh
python3 tools/build-linux-release.py
```

This writes a self-extracting `better-bots-mint-22-alpha.run`, a `.tar.gz` of the
same files, and checksums to `artifacts/linux-release/`. Each artifact contains a
`BUILD.json` that records the source revision it was built from.

## Installing

Open a terminal in the folder with the installer and run:

```sh
bash better-bots-mint-22-alpha.run
```

Or extract the `.tar.gz`, open its folder in a terminal, and run `bash install.sh`.

The installer checks the computer and package before changing anything, asks for
administrator access, and installs the app, Node.js 22 if needed, and the agent
desktop tools. It adds **Better Bots** to the application menu. The app opens in
its own window, already signed in: the installer saves your login link in
`~/.config/better-bots/console-url`, readable only by you. Closing the window
leaves the service running, so your bots keep working.

If an older Node and Ubuntu's own `npm` package are installed, the installer stops
first: installing Node 22 removes that `npm` and the packages that depend on it.
Re-run with `--replace-node` to accept that.

After installing, open **App settings → AI providers** to connect your own
models, then create a bot. ChatGPT subscription sign-in and `uvx`-based plugins
need the optional Codex and uv command-line tools, which this installer does not
install.

## Memory

Memory works out of the box on the built-in SQLite store: no database server, no
extra service and no extra port. A PostgreSQL or Hindsight you already run is
left alone.

Hindsight is optional. To add it, run the installer with `--with-hindsight` (and
`--hindsight-port PORT` if 8888 is taken). It installs PostgreSQL 16 if needed and
gives Better Bots its own `better-bots-hindsight` account and service and its own
`better_bots_hindsight` database in the existing 16/main cluster. Hindsight needs
a model for memory extraction: during installation, enter an OpenAI-compatible
endpoint, model ID and API key. This is separate from the models your bots use.
A local compatible model server works too; enter `local` as the key if it needs
no authentication. Keys are read without echo and saved in restricted service
files. The installer runs no paid inference.

## Paths

- App: `/opt/better-bots`
- Bots, settings, conversations and SQLite memory: `/var/lib/better-bots`
- With `--with-hindsight`: `/opt/better-bots-hindsight`, `/var/lib/better-bots-hindsight`
  and the PostgreSQL database `better_bots_hindsight`

The console and memory API listen only on this computer.

## Existing installations

This installer is for a new installation. It refuses existing Better Bots paths,
service accounts or services, and does not erase or migrate them. If an
interrupted install leaves them behind, keep them and inspect the failure before
trying again. It does not change your browser policies or disable AppArmor
globally.

## After installing

```sh
systemctl status better-bots --no-pager
journalctl -u better-bots --since today
sudo better-bots-backup
```

With Hindsight, add `better-bots-hindsight` to the `systemctl` and `journalctl`
commands. `better-bots-backup` saves your state and, with Hindsight, its database.
Backups are manual with this installer; no backup or consolidation timers are
installed. An archive alone does not prove recovery: test a restore. Stopping the
services keeps your data:

```sh
sudo systemctl stop better-bots        # and better-bots-hindsight, if installed
```

Local package tests do not prove that a fresh installation, provider inference,
memory retention and recall, or a restore works. To check memory, follow the
[memory contract](../../docs/MEMORY-CONTRACT.md). When reporting a problem, include
the failed step and relevant logs; never share credentials or private conversations.

Compatibility: https://linuxmint.com/rel_wilma.php
