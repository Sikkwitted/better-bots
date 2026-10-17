// Better Bots for Mac: a native window around the console.
//
// The console is the web UI served by the host (src/server.js). This shell owns
// nothing of it — no state, no API calls of its own — it only gives that page a
// window of its own, a Dock icon, a menu bar, and, when the host is on another
// machine, the SSH tunnel to reach it. Everything the user sees is still the
// host's page, so the host can change without this file knowing.
//
// Configuration is one JSON file in ~/Library/Application Support/Better Bots:
//   { "url": "http://127.0.0.1:4173", "ssh": "user@host", "token": "..." }
// `ssh` is optional. When present the app opens `ssh -N -L <port>:127.0.0.1:<port>
// user@host` before loading the page and closes its own tunnel on quit. A matching
// existing tunnel can be borrowed after verifying the host; it is never stopped.
// A loopback-only server is reached through that tunnel. Login is the
// host's own token gate; WebKit keeps the resulting cookie in this app's store.
// `token` is optional: when present the page is opened as the host's login link
// (#token=...), so the gate never shows. The file is kept readable by you only.
//
// Built by tools/make-app.sh with swiftc — no Xcode project, no dependencies.

import Cocoa
import WebKit
import UserNotifications
import Darwin

struct Config: Codable {
    var url: String
    var ssh: String?
    var token: String? = nil
}

let supportDir = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
    .appendingPathComponent("Better Bots", isDirectory: true)
let configFile = supportDir.appendingPathComponent("config.json")

func loadConfig() -> Config? {
    guard let data = try? Data(contentsOf: configFile) else { return nil }
    return try? JSONDecoder().decode(Config.self, from: data)
}

func saveConfig(_ config: Config) {
    try? FileManager.default.createDirectory(at: supportDir, withIntermediateDirectories: true)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
    if let data = try? encoder.encode(config) {
        try? data.write(to: configFile)
        // It can hold the console token.
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: configFile.path)
    }
}

// MARK: SSH tunnel identity

struct PortListener: Equatable {
    let pid: Int32
    let command: String
}

func parseListeners(_ text: String) -> [PortListener] {
    var pid: Int32?
    var found: [PortListener] = []
    for line in text.split(separator: "\n") {
        if line.hasPrefix("p") { pid = Int32(line.dropFirst()) }
        else if line.hasPrefix("c"), let pid = pid, !found.contains(where: { $0.pid == pid }) {
            found.append(PortListener(pid: pid, command: String(line.dropFirst())))
        }
    }
    return found
}

/// Read NUL-separated argv directly: splitting `ps` output can mistake quoted
/// option values for the SSH destination or a forwarding argument.
func processArguments(_ pid: Int32) -> [String]? {
    var mib: [Int32] = [CTL_KERN, KERN_PROCARGS2, pid]
    var size = 0
    guard sysctl(&mib, 3, nil, &size, nil, 0) == 0, size > MemoryLayout<Int32>.size else { return nil }
    var bytes = [UInt8](repeating: 0, count: size)
    guard sysctl(&mib, 3, &bytes, &size, nil, 0) == 0 else { return nil }
    let count = bytes.withUnsafeBytes { $0.loadUnaligned(as: Int32.self) }
    guard count > 0 else { return nil }
    var offset = MemoryLayout<Int32>.size
    while offset < size && bytes[offset] != 0 { offset += 1 } // executable path
    while offset < size && bytes[offset] == 0 { offset += 1 } // alignment padding
    var arguments: [String] = []
    for _ in 0..<count {
        let start = offset
        while offset < size && bytes[offset] != 0 { offset += 1 }
        guard offset < size, let argument = String(bytes: bytes[start..<offset], encoding: .utf8) else { return nil }
        arguments.append(argument)
        offset += 1
    }
    return arguments
}

/// Accept the ordinary key-only forwarding shape used by this app and a hand-made `ssh -N -L`.
/// Unknown options fail closed rather than guessing where they send the tunnel.
func matchesSSHTunnel(_ arguments: [String], url: URL, target: String, port: Int) -> Bool {
    guard ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
          ["127.0.0.1", "localhost", "::1", "[::1]"].contains(url.host?.lowercased() ?? ""),
          url.user == nil, url.password == nil,
          let executable = arguments.first, URL(fileURLWithPath: executable).lastPathComponent == "ssh" else { return false }
    let forwards = ["\(port):127.0.0.1:\(port)", "127.0.0.1:\(port):127.0.0.1:\(port)",
                    "localhost:\(port):127.0.0.1:\(port)", "[::1]:\(port):127.0.0.1:\(port)"]
    let safeOptions = ["batchmode", "serveraliveinterval", "serveralivecountmax", "exitonforwardfailure"]
    var index = 1
    var hasForward = false
    var noCommand = false
    func acceptForward(_ value: String) -> Bool {
        if forwards.contains(value) { hasForward = true; return true }
        let parts = value.split(separator: ":")
        let localPort = parts.count == 3 ? Int(parts[0]) : (parts.count == 4 ? Int(parts[1]) : nil)
        // Additional monitor forwards are fine. Another destination competing
        // for this console port is ambiguous even when the same SSH PID owns it.
        return localPort != nil && localPort != port
    }
    while index < arguments.count {
        let argument = arguments[index]
        if argument == "-N" { noCommand = true }
        else if ["-n", "-f", "-T", "-4", "-6", "-v", "-vv", "-vvv"].contains(argument) { }
        else if argument == "-L" || argument == "-o" {
            index += 1
            guard index < arguments.count else { return false }
            let value = arguments[index]
            if argument == "-L" { if !acceptForward(value) { return false } }
            else if !safeOptions.contains(value.split(separator: "=", maxSplits: 1).first?.lowercased() ?? "") { return false }
        } else if argument.hasPrefix("-L") {
            if !acceptForward(String(argument.dropFirst(2))) { return false }
        } else if argument.hasPrefix("-o") {
            let name = argument.dropFirst(2).split(separator: "=", maxSplits: 1).first?.lowercased() ?? ""
            if !safeOptions.contains(name) { return false }
        } else {
            return index == arguments.count - 1 && argument == target && noCommand && hasForward
        }
        index += 1
    }
    return false
}

// MARK: application

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate,
                         WKScriptMessageHandler, UNUserNotificationCenterDelegate {
    var window: NSWindow!
    var webView: WKWebView!
    var config: Config!
    // Only a Process created here is owned. A borrowed PID is identity data.
    var tunnel: Process?
    var stoppingTunnel: Process?
    var borrowedTunnelPID: Int32?
    var connectionAttempt = UUID()

    // MARK: launch

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()
        UNUserNotificationCenter.current().delegate = self
        // WebKit takes key equivalents before the menu bar does and does not always
        // hand them back, so ⌘R never reached the Reload item. Catch it first.
        NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self = self, event.modifierFlags.contains(.command),
                  event.charactersIgnoringModifiers?.lowercased() == "r" else { return event }
            self.reload(hard: event.modifierFlags.contains(.shift))
            return nil
        }
        guard let saved = loadConfig() ?? askForHost(Config(url: "http://127.0.0.1:4173", ssh: nil)) else {
            NSApp.terminate(nil); return
        }
        config = saved
        connect()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) { stopTunnel() }

    // MARK: window

    func buildWindow() {
        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1280, height: 820),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered, defer: false)
        window.title = "Better Bots"
        window.minSize = NSSize(width: 720, height: 480)
        window.setFrameAutosaveName("BetterBotsMain")   // remembers size and place
        window.delegate = self
        window.backgroundColor = NSColor(calibratedWhite: 0.07, alpha: 1)

        let prefs = WKWebViewConfiguration()
        prefs.websiteDataStore = .default()               // persistent: the login cookie survives relaunch
        prefs.userContentController.add(self, name: "betterBots")   // notifications + Dock badge, see below
        webView = WKWebView(frame: window.contentView!.bounds, configuration: prefs)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.customUserAgent = (webView.value(forKey: "userAgent") as? String ?? "") + " BetterBots/1.0"
        // Match the page's own dark chrome while it loads instead of flashing white.
        webView.setValue(false, forKey: "drawsBackground")
        window.contentView!.addSubview(webView)
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: notifications
    //
    // WKWebView has no web Notification API, so the page (web/app.js,
    // announceAttention) hands this shell what to announce: a bot finished, needs
    // an approval, or is stuck. The shell posts it and keeps the Dock badge at the
    // number of things waiting on the person. Nothing else crosses this bridge.

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "betterBots", let body = message.body as? [String: Any],
              let type = body["type"] as? String else { return }
        if type == "badge" {
            let count = (body["count"] as? NSNumber)?.intValue ?? 0
            NSApp.dockTile.badgeLabel = count > 0 ? String(count) : nil
        } else if type == "notify", let title = body["title"] as? String {
            let content = UNMutableNotificationContent()
            content.title = title
            content.body = body["body"] as? String ?? ""
            content.sound = .default
            if let agent = body["agent_id"] as? String { content.userInfo = ["agent_id": agent] }
            let key = body["key"] as? String ?? UUID().uuidString
            let center = UNUserNotificationCenter.current()
            center.requestAuthorization(options: [.alert, .sound]) { granted, _ in
                guard granted else { return }
                center.add(UNNotificationRequest(identifier: key, content: content, trigger: nil))
            }
        }
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                withCompletionHandler done: @escaping () -> Void) {
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        if let agent = response.notification.request.content.userInfo["agent_id"] as? String,
           let json = try? JSONSerialization.data(withJSONObject: [agent]),
           let arg = String(data: json, encoding: .utf8) {
            webView.evaluateJavaScript("window.betterBotsOpenAgent?.(...\(arg))")
        }
        done()
    }

    // MARK: connect

    func connect() {
        stopTunnel()
        let attempt = UUID()
        connectionAttempt = attempt
        if let previous = stoppingTunnel {
            // terminate() is asynchronous: its sockets can still be listening.
            // Keep ownership until exit so a reconnect cannot borrow that PID.
            waitForTunnelExit(previous, attempts: 40) { [self] exited in
                guard connectionAttempt == attempt else { return }
                if exited {
                    if stoppingTunnel === previous { stoppingTunnel = nil }
                    connect()
                } else {
                    fail("The previous tunnel is still closing.", detail: "Try again after it exits. The app has not opened or borrowed another tunnel.")
                }
            }
            return
        }
        guard let url = URL(string: config.url), let host = url.host else {
            fail("The host address is not a URL.", detail: config.url); return
        }
        let port = url.port ?? (url.scheme == "https" ? 443 : 80)
        let ssh = config.ssh?.trimmingCharacters(in: .whitespaces) ?? ""
        if !ssh.isEmpty {
            // A matching SSH listener may be borrowed. Other occupants still
            // prevent startup, including IPv4/IPv6 ports owned by different PIDs.
            if let squatter = listeners(on: port) {
                guard let pid = existingTunnelPID(url: url, target: ssh, port: port) else {
                    fail("Port \(port) is already in use on this Mac.",
                         detail: "\(squatter) is listening on it, but it is not a matching SSH tunnel to the configured host.\n\nQuit it, or change the host settings (⌘,).")
                    return
                }
                borrowedTunnelPID = pid
            } else {
                startTunnel(target: ssh, localPort: port, remotePort: port)
            }
        }
        window.title = "Better Bots — \(host)"
        waitUntilReachable(url, attempts: 24) { [self] probe in
            guard connectionAttempt == attempt else { return }
            switch probe {
            case .console:
                if let pid = borrowedTunnelPID, existingTunnelPID(url: url, target: ssh, port: port) != pid {
                    fail("The existing tunnel changed while connecting.", detail: "Try again to verify the host before loading the console.")
                    return
                }
                // The login link form: the page trades the fragment for its cookie.
                var page = url
                if let token = config.token, !token.isEmpty, var parts = URLComponents(url: url, resolvingAgainstBaseURL: false) {
                    parts.fragment = "token=\(token)"
                    page = parts.url ?? url
                }
                // Never the cached copy: a wrong page shown once must not come back.
                webView.load(URLRequest(url: page, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 30))
            case .stranger(let who):
                let local = listeners(on: port, ignoring: tunnel?.processIdentifier).map { " (\($0))" } ?? ""
                fail("Something else is answering at \(config.url).",
                     detail: "\(who)\(local) responded, but it is not a Better Bots host. Check what is bound to port \(port).")
            case .silent:
                fail("Could not reach the host.", detail: tunnelError ?? config.url)
            }
        }
    }

    func waitForTunnelExit(_ process: Process, attempts: Int, _ done: @escaping (Bool) -> Void) {
        if !process.isRunning { done(true) }
        else if attempts <= 0 { done(false) }
        else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                self.waitForTunnelExit(process, attempts: attempts - 1, done)
            }
        }
    }

    enum Probe { case console, stranger(String), silent }

    /// Poll until the host answers. The tunnel takes a moment to come up, and a
    /// server that is restarting answers nothing for a second or two. An answer
    /// without the host's identity header is not "up": it is the wrong server,
    /// and polling further would only load it.
    func waitUntilReachable(_ url: URL, attempts: Int, _ done: @escaping (Probe) -> Void) {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: 1.5)
        request.httpMethod = "HEAD"
        URLSession.shared.dataTask(with: request) { _, response, _ in
            let probe: Probe
            if let http = response as? HTTPURLResponse {
                if http.value(forHTTPHeaderField: "X-Better-Bots") != nil { probe = .console }
                else { probe = .stranger(http.value(forHTTPHeaderField: "Server") ?? "An unidentified server") }
            } else { probe = .silent }
            DispatchQueue.main.async {
                if case .silent = probe, attempts > 1 {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.waitUntilReachable(url, attempts: attempts - 1, done) }
                } else { done(probe) }
            }
        }.resume()
    }

    /// Names of processes listening on a local TCP port, "Python (pid 5218)",
    /// or nil when the port is free. `ignoring` leaves out our own tunnel.
    func listeners(on port: Int, ignoring: Int32? = nil) -> String? {
        let found = listeningProcesses(on: port).filter { $0.pid != ignoring }
        return found.isEmpty ? nil : found.map { "\($0.command) (pid \($0.pid))" }.joined(separator: ", ")
    }

    func listeningProcesses(on port: Int) -> [PortListener] {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/sbin/lsof")
        p.arguments = ["-nP", "-iTCP:\(port)", "-sTCP:LISTEN", "-Fpc"]
        let out = Pipe(); p.standardOutput = out; p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return [] }
        p.waitUntilExit()
        let text = String(data: out.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        return parseListeners(text)
    }

    func existingTunnelPID(url: URL, target: String, port: Int) -> Int32? {
        let found = listeningProcesses(on: port)
        guard found.count == 1, let listener = found.first, listener.command == "ssh",
              let arguments = processArguments(listener.pid),
              matchesSSHTunnel(arguments, url: url, target: target, port: port) else { return nil }
        return listener.pid
    }

    // MARK: tunnel

    var tunnelError: String?

    func startTunnel(target: String, localPort: Int, remotePort: Int) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/ssh")
        // BatchMode: keys only, never a hidden password prompt. ExitOnForwardFailure:
        // a port already in use is an error we can show, not a silent no-op.
        p.arguments = ["-o", "BatchMode=yes", "-o", "ServerAliveInterval=30", "-o", "ExitOnForwardFailure=yes",
                       "-N", "-L", "\(localPort):127.0.0.1:\(remotePort)", target]
        let err = Pipe()
        p.standardError = err
        p.standardOutput = FileHandle.nullDevice
        tunnelError = nil
        p.terminationHandler = { [weak self] proc in
            let text = String(data: err.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
            DispatchQueue.main.async {
                guard let self = self, self.tunnel === proc else { return }
                self.tunnel = nil
                self.tunnelError = text.trimmingCharacters(in: .whitespacesAndNewlines)
                if self.tunnelError?.isEmpty ?? true { self.tunnelError = "ssh to \(target) exited (\(proc.terminationStatus))" }
            }
        }
        do { try p.run(); tunnel = p } catch { tunnelError = "could not start ssh: \(error.localizedDescription)" }
    }

    func stopTunnel() {
        borrowedTunnelPID = nil
        guard let p = tunnel else { return }
        tunnel = nil
        stoppingTunnel = p
        p.terminationHandler = nil
        p.terminate()
    }

    // MARK: host dialog

    /// One sheet with two fields. Returns nil when cancelled.
    func askForHost(_ current: Config) -> Config? {
        let alert = NSAlert()
        alert.messageText = "Where is your Better Bots host?"
        alert.informativeText = "The address the console is served from. If the host is on a server bound to localhost, give the SSH login too and this app opens the tunnel for you."
        alert.addButton(withTitle: "Connect")
        alert.addButton(withTitle: "Cancel")

        let form = NSView(frame: NSRect(x: 0, y: 0, width: 360, height: 66))
        let urlLabel = NSTextField(labelWithString: "Host URL")
        urlLabel.frame = NSRect(x: 0, y: 40, width: 90, height: 20)
        let urlField = NSTextField(string: current.url)
        urlField.frame = NSRect(x: 96, y: 38, width: 264, height: 24)
        urlField.placeholderString = "http://127.0.0.1:4173"
        let sshLabel = NSTextField(labelWithString: "SSH (optional)")
        sshLabel.frame = NSRect(x: 0, y: 6, width: 96, height: 20)
        let sshField = NSTextField(string: current.ssh ?? "")
        sshField.frame = NSRect(x: 96, y: 4, width: 264, height: 24)
        sshField.placeholderString = "user@server"
        form.addSubview(urlLabel); form.addSubview(urlField); form.addSubview(sshLabel); form.addSubview(sshField)
        alert.accessoryView = form
        alert.window.initialFirstResponder = urlField

        guard alert.runModal() == .alertFirstButtonReturn else { return nil }
        var url = urlField.stringValue.trimmingCharacters(in: .whitespaces)
        if !url.contains("://") { url = "http://" + url }
        while url.hasSuffix("/") { url.removeLast() }
        let ssh = sshField.stringValue.trimmingCharacters(in: .whitespaces)
        // A saved token belongs to the host it came from.
        let sameHost = url == current.url && ssh == (current.ssh ?? "")
        let config = Config(url: url, ssh: ssh.isEmpty ? nil : ssh, token: sameHost ? current.token : nil)
        saveConfig(config)
        return config
    }

    @objc func changeHost(_ sender: Any?) {
        guard let next = askForHost(config) else { return }
        config = next
        connect()
    }

    @objc func reload(_ sender: Any?) { reload(hard: false) }
    @objc func reloadHard(_ sender: Any?) { reload(hard: true) }

    /// ⌘R reloads; ⌘⇧R reloads from origin, skipping every cache.
    func reload(hard: Bool) {
        if webView.url == nil { connect() }
        else if hard { webView.reloadFromOrigin() }
        else { webView.reload() }
    }

    func fail(_ message: String, detail: String) {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = message
        alert.informativeText = detail
        alert.addButton(withTitle: "Try Again")
        alert.addButton(withTitle: "Change Host…")
        alert.addButton(withTitle: "Quit")
        switch alert.runModal() {
        case .alertFirstButtonReturn: connect()
        case .alertSecondButtonReturn: changeHost(nil)
        default: NSApp.terminate(nil)
        }
    }

    // MARK: web view delegates

    /// window.open (plugin sign-in, screenshots) goes to the default browser. An
    /// OAuth flow that ends at the host's callback still works there: that route
    /// is exempt from the cookie check because the redirect comes from another site.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { openOutside(url) }
        return nil
    }

    /// Links off the host open outside; the window stays on the console.
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.navigationType == .linkActivated,
           let url = navigationAction.request.url,
           url.host != URL(string: config.url)?.host {
            openOutside(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    /// Only web and mail links leave the app. A sign-in URL comes from a remote
    /// server's metadata, and a file: or custom-scheme URL would make macOS open
    /// a local file or another app instead of a web page.
    private func openOutside(_ url: URL) {
        guard ["http", "https", "mailto"].contains(url.scheme?.lowercased() ?? "") else { return }
        NSWorkspace.shared.open(url)
    }

    /// alert / confirm / prompt. Without these WebKit answers every confirm() with
    /// "no", so a button like Remove would silently do nothing.
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert(); alert.messageText = message; alert.addButton(withTitle: "OK")
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert(); alert.messageText = message
        alert.addButton(withTitle: "OK"); alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = NSAlert(); alert.messageText = prompt
        alert.addButton(withTitle: "OK"); alert.addButton(withTitle: "Cancel")
        let field = NSTextField(string: defaultText ?? ""); field.frame = NSRect(x: 0, y: 0, width: 300, height: 24)
        alert.accessoryView = field; alert.window.initialFirstResponder = field
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn ? field.stringValue : nil) }
    }

    /// A file input needs an explicit native chooser when the console runs in
    /// WKWebView. Return nil on cancellation so WebKit leaves the input alone.
    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.beginSheetModal(for: window) { response in
            completionHandler(response == .OK ? panel.urls : nil)
        }
    }

    /// WebKit runs the page in its own process and kills it under memory pressure;
    /// without this the window just goes blank and stays that way.
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fail("The console stopped responding.", detail: error.localizedDescription)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        fail("Could not load the console.", detail: error.localizedDescription)
    }

    // MARK: menu

    /// Edit is not decoration: without it ⌘C/⌘V/⌘A do nothing inside the page.
    func buildMenu() {
        let main = NSMenu()

        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Better Bots", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Change Host…", action: #selector(changeHost(_:)), keyEquivalent: ",")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Hide Better Bots", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "Quit Better Bots", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        let appItem = NSMenuItem(); appItem.submenu = appMenu; main.addItem(appItem)

        let edit = NSMenu(title: "Edit")
        edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        edit.addItem(.separator())
        edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        let editItem = NSMenuItem(); editItem.submenu = edit; main.addItem(editItem)

        let view = NSMenu(title: "View")
        view.addItem(withTitle: "Reload", action: #selector(reload(_:)), keyEquivalent: "r")
        view.addItem(withTitle: "Reload Ignoring Cache", action: #selector(reloadHard(_:)), keyEquivalent: "R")
        view.addItem(withTitle: "Enter Full Screen", action: #selector(NSWindow.toggleFullScreen(_:)), keyEquivalent: "f")
            .keyEquivalentModifierMask = [.command, .control]
        let viewItem = NSMenuItem(); viewItem.submenu = view; main.addItem(viewItem)

        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(withTitle: "Minimize", action: #selector(NSWindow.performMiniaturize(_:)), keyEquivalent: "m")
        windowMenu.addItem(withTitle: "Zoom", action: #selector(NSWindow.performZoom(_:)), keyEquivalent: "")
        windowMenu.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
        let windowItem = NSMenuItem(); windowItem.submenu = windowMenu; main.addItem(windowItem)
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
