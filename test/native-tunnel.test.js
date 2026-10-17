import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// Native checks are optional: the ordinary suite only requires Node.
const nativeSkip = process.platform !== 'darwin'
  ? 'macOS native checks'
  : spawnSync('/usr/bin/swift', ['--version'], { encoding: 'utf8', timeout: 10_000 }).status === 0
    ? false
    : 'Swift toolchain unavailable';

test('native connection borrows verified SSH tunnels without owning or stopping them', { skip: nativeSkip }, async () => {
  const source = await readFile(new URL('../tools/BetterBots.swift', import.meta.url), 'utf8');
  const connect = source.slice(source.indexOf('    func connect() {'), source.indexOf('    enum Probe'));
  const stop = source.slice(source.indexOf('    func stopTunnel() {'), source.indexOf('    // MARK: host dialog'));
  const directory = await mkdtemp(path.join(tmpdir(), 'better-bots-native-tunnel-'));
  try {
    const harness = `
import Foundation
struct Config { var url: String; var ssh: String?; var token: String? = nil }
final class TestWindow { var title = "" }
final class TestWebView { var loaded: URL?; func load(_ request: URLRequest) { loaded = request.url } }
final class TestProcess: Process, @unchecked Sendable {
    var stops = 0
    var exited = false
    override var terminationHandler: (@Sendable (Process) -> Void)? { get { nil } set {} }
    override var processIdentifier: Int32 { 999 }
    override var isRunning: Bool { !exited }
    override func terminate() { stops += 1 }
}
final class Connection {
    enum Probe { case console, stranger(String), silent }
    var config = Config(url: "http://127.0.0.1:4173", ssh: "user@example.com")
    var window = TestWindow()
    var webView = TestWebView()
    var tunnel: Process?
    var stoppingTunnel: Process?
    var lingeringOwned: TestProcess?
    var borrowedTunnelPID: Int32?
    var connectionAttempt = UUID()
    var tunnelError: String?
    var occupant: String? = "ssh (pid 123)"
    var borrowable: Int32? = 123
    var response = Probe.console
    var starts = 0
    var failure: String?
    var deferProbe = false
    var pending: [() -> Void] = []
    func listeners(on port: Int, ignoring: Int32? = nil) -> String? {
        if let old = lingeringOwned, !old.exited { return "ssh (pid 999)" }
        return occupant
    }
    func existingTunnelPID(url: URL, target: String, port: Int) -> Int32? { borrowable }
    func startTunnel(target: String, localPort: Int, remotePort: Int) { starts += 1; tunnel = TestProcess() }
    func waitUntilReachable(_ url: URL, attempts: Int, _ done: @escaping (Probe) -> Void) {
        if deferProbe { pending.append { done(self.response) } } else { done(response) }
    }
    func fail(_ message: String, detail: String) { failure = message }
${connect}
${stop}
}
var failures: [String] = []
func check(_ value: Bool, _ label: String) {
    if !value { failures.append(label); print("FAIL: \\(label)") }
}
let borrowed = Connection()
borrowed.connect()
check(borrowed.webView.loaded?.absoluteString == "http://127.0.0.1:4173", "a verified existing tunnel loads the console")
check(borrowed.borrowedTunnelPID == 123 && borrowed.tunnel == nil && borrowed.starts == 0, "borrowed tunnel never becomes an owned process")
let signedIn = Connection(); signedIn.config.token = "abc_-1"; signedIn.connect()
check(signedIn.webView.loaded?.absoluteString == "http://127.0.0.1:4173#token=abc_-1", "a saved token opens the console as its login link")
borrowed.stopTunnel()
check(borrowed.borrowedTunnelPID == nil && borrowed.tunnel == nil, "disconnect forgets borrowed ownership without terminating a process")

let stranger = Connection(); stranger.response = .stranger("other server"); stranger.connect()
check(stranger.webView.loaded == nil && stranger.failure != nil && stranger.starts == 0, "missing host identity is refused")
let silent = Connection(); silent.response = .silent; silent.connect()
check(silent.webView.loaded == nil && silent.failure != nil && silent.starts == 0, "an unresponsive borrowed tunnel is refused")
let unrelated = Connection(); unrelated.borrowable = nil; unrelated.connect()
check(unrelated.webView.loaded == nil && unrelated.failure != nil && unrelated.starts == 0, "an unrelated port owner is refused")
let replaced = Connection(); replaced.deferProbe = true; replaced.connect(); replaced.borrowable = 456; replaced.pending[0]()
check(replaced.webView.loaded == nil && replaced.failure != nil, "a listener replaced during the HEAD probe is refused")
let stale = Connection(); stale.deferProbe = true; stale.connect(); stale.connect(); stale.pending[0]()
check(stale.webView.loaded == nil, "a superseded connection attempt cannot load an old response")
stale.pending[1]()
check(stale.webView.loaded != nil, "the latest verified connection attempt still loads")

let free = Connection(); free.occupant = nil; free.connect()
check(free.starts == 1 && free.webView.loaded != nil && free.borrowedTunnelPID == nil, "a free port still starts the app's own tunnel")
let owned = free.tunnel as! TestProcess
free.stopTunnel()
check(owned.stops == 1 && free.tunnel == nil, "disconnect stops the app-owned process exactly once")
free.stopTunnel()
check(owned.stops == 1, "repeated cleanup never terminates a process twice")

let reconnect = Connection(); reconnect.occupant = nil; reconnect.connect()
let old = reconnect.tunnel as! TestProcess
reconnect.lingeringOwned = old; reconnect.borrowable = 999; reconnect.connect()
check(reconnect.borrowedTunnelPID == nil, "a dying owned tunnel is never borrowed")
DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) { old.exited = true }
let until = Date().addingTimeInterval(1)
while reconnect.starts < 2 && Date() < until { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
check(reconnect.starts == 2 && reconnect.tunnel !== old && old.stops == 1, "reconnect starts a replacement only after its previous tunnel exits")
var exited: Bool?
reconnect.waitForTunnelExit(TestProcess(), attempts: 1) { exited = $0 }
let deadline = Date().addingTimeInterval(1)
while exited == nil && Date() < deadline { RunLoop.main.run(until: Date().addingTimeInterval(0.01)) }
check(exited == false, "a process that never exits reaches a bounded timeout")

if !failures.isEmpty { exit(1) }
print("Native tunnel connection and ownership checks passed")
`;
    const filename = path.join(directory, 'main.swift');
    await writeFile(filename, harness);
    const result = spawnSync('/usr/bin/swift', [filename], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('native reuse verifies exact SSH forwarding arguments and a single listener', { skip: nativeSkip }, async () => {
  const source = await readFile(new URL('../tools/BetterBots.swift', import.meta.url), 'utf8');
  const identity = source.slice(source.indexOf('// MARK: SSH tunnel identity'), source.indexOf('// MARK: application'));
  const existing = source.slice(source.indexOf('    func existingTunnelPID('), source.indexOf('    // MARK: tunnel'));
  const directory = await mkdtemp(path.join(tmpdir(), 'better-bots-native-identity-'));
  try {
    const harness = `
import Foundation
import Darwin
${identity}
var failures: [String] = []
func check(_ value: Bool, _ label: String) {
    if !value { failures.append(label); print("FAIL: \\(label)") }
}
let url = URL(string: "http://127.0.0.1:4173")!
let target = "user@example.com"
let normal = ["ssh", "-o", "ServerAliveInterval=30", "-o", "ExitOnForwardFailure=yes", "-N", "-L", "4173:127.0.0.1:4173", "-L", "5900:127.0.0.1:5900", target]
check(matchesSSHTunnel(normal, url: url, target: target, port: 4173), "a hand-made ssh -L forwarding is reusable")
check(matchesSSHTunnel(["/usr/bin/ssh", "-oBatchMode=yes", "-N", "-L127.0.0.1:4173:127.0.0.1:4173", target], url: url, target: target, port: 4173), "explicit loopback forwarding is reusable")
check(!matchesSSHTunnel(normal, url: URL(string: "http://example.net:4173")!, target: target, port: 4173), "non-loopback URLs cannot borrow local tunnels")
check(!matchesSSHTunnel(normal, url: url, target: "other@example.com", port: 4173), "a different SSH destination is refused")
check(!matchesSSHTunnel(["ssh", "-N", "-L", "4173:127.0.0.1:9999", target], url: url, target: target, port: 4173), "the remote forwarding port must match")
check(!matchesSSHTunnel(["ssh", "-N", "-L", "4173:other.example:4173", target], url: url, target: target, port: 4173), "the remote forwarding host must be loopback")
check(!matchesSSHTunnel(["ssh", "-N", "-L", "4173:other.example:4173", "-L", "4173:127.0.0.1:4173", target], url: url, target: target, port: 4173), "conflicting forwards cannot hide a different destination on the same local port")
check(!matchesSSHTunnel(["ssh", "-N", "-o", "ProxyCommand=echo -L 4173:127.0.0.1:4173", target], url: url, target: target, port: 4173), "option text cannot masquerade as a forwarding argument")
check(!matchesSSHTunnel(["ssh", "-N", "-L", "4173:127.0.0.1:4173", "other@example.com", target], url: url, target: target, port: 4173), "a remote command cannot masquerade as the destination")
check(!matchesSSHTunnel(["ssh", "-N", "-L"], url: url, target: target, port: 4173), "truncated options are refused")
check(!matchesSSHTunnel(["python", "-N", "-L", "4173:127.0.0.1:4173", target], url: url, target: target, port: 4173), "only SSH process arguments are accepted")
let parsed = parseListeners("p123\\ncssh\\np123\\ncssh\\np456\\ncPython\\n")
check(parsed == [PortListener(pid: 123, command: "ssh"), PortListener(pid: 456, command: "Python")], "listener parsing deduplicates sockets without losing other owners")
check(processArguments(getpid())?.isEmpty == false, "kernel argv reader returns real arguments")
final class Candidates {
    var rows = [PortListener(pid: 123, command: "ssh")]
    var argv: [String]? = normal
    func listeningProcesses(on port: Int) -> [PortListener] { rows }
    func processArguments(_ pid: Int32) -> [String]? { argv }
${existing}
}
let candidate = Candidates()
check(candidate.existingTunnelPID(url: url, target: target, port: 4173) == 123, "one matching SSH owner is borrowable")
candidate.rows.append(PortListener(pid: 456, command: "ssh"))
check(candidate.existingTunnelPID(url: url, target: target, port: 4173) == nil, "different IPv4 and IPv6 owners cannot be borrowed")
candidate.rows = [PortListener(pid: 123, command: "ssh")]; candidate.argv = nil
check(candidate.existingTunnelPID(url: url, target: target, port: 4173) == nil, "unreadable process arguments fail closed")
if !failures.isEmpty { exit(1) }
print("Native SSH tunnel identity checks passed")
`;
    const filename = path.join(directory, 'main.swift');
    await writeFile(filename, harness);
    const result = spawnSync('/usr/bin/swift', [filename], { encoding: 'utf8', timeout: 60_000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
