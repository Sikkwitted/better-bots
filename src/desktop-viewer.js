import net from 'node:net';
import { WebSocketServer, WebSocket } from 'ws';

// The desktop stays on the host's loopback interface. Only authenticated console
// connections can reach it; clients supply an agent id, never a target address.
export function attachDesktopViewer(server, { host, authorized, token }) {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  server.on('upgrade', async (req, socket, head) => {
    // Node stops listening for socket errors once 'upgrade' fires; a reset here would otherwise crash the host.
    socket.on('error', () => socket.destroy());
    let window, controller;
    const reject = (status = '403 Forbidden') => { socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`); };
    try {
      const url = new URL(req.url, 'http://localhost');
      if (url.pathname !== '/api/desktop/stream') return reject('404 Not Found');
      if (!authorized(req, token) || !req.headers.origin || new URL(req.headers.origin).host !== req.headers.host) return reject();
      const agentId = url.searchParams.get('agent_id');
      window = host.computer.assignments().find(w => w.agent_id === agentId);
      if (!window) return reject('404 Not Found');
      host.computer.viewers.set(agentId, (host.computer.viewers.get(agentId) ?? 0) + 1);
      let watching = true;
      const unwatch = () => {
        if (!watching) return;
        watching = false;
        const count = (host.computer.viewers.get(agentId) ?? 1) - 1;
        if (count > 0) host.computer.viewers.set(agentId, count); else host.computer.viewers.delete(agentId);
      };
      socket.once('close', unwatch);
      const ready = await host.computer.readyWindow(agentId);
      if (!ready.live || !host.computer.verifyOwner(agentId, window.window_index, window.owner_token)) return reject('409 Conflict');
      const target = new URL(ready.vnc_url);
      if (target.hostname !== '127.0.0.1' || !['vnc:', 'http:'].includes(target.protocol) || !target.port) return reject();
      if (url.searchParams.get('control') === '1') {
        controller = Symbol(agentId);
        await host.computer.serial(window.window_index, () => {
          if (!host.computer.verifyOwner(agentId, window.window_index, window.owner_token) || host.computer.userControllers.has(agentId)) throw new Error('Desktop already controlled');
          host.computer.userControllers.set(agentId, controller);
        });
      }
      const release = () => {
        if (controller && host.computer.userControllers.get(agentId) === controller) {
          host.computer.userControllers.delete(agentId);
          host.audit.record('computer.user_control_ended', {agent_id: agentId});
        }
      };
      if (socket.destroyed) { release(); return; }
      sockets.handleUpgrade(req, socket, head, ws => {
        if (controller) host.audit.record('computer.user_control_started', {agent_id: agentId});
        const upstream = target.protocol === 'vnc:' ? net.connect({host:'127.0.0.1', port:Number(target.port)}) : new WebSocket(`ws://127.0.0.1:${target.port}/websockify`);
        const tcp = target.protocol === 'vnc:';
        let closed = false;
        const close = () => { if (closed) return; closed = true; clearInterval(timer); tcp ? upstream.destroy() : upstream.terminate(); ws.terminate(); release(); };
        // Reassignment/release cannot leave a viewer attached to another bot's screen.
        let alive = true;
        const timer = setInterval(() => {
          if (!host.computer.verifyOwner(agentId, window.window_index, window.owner_token) || !alive) return close();
          alive = false; ws.ping();
        }, 5000);
        timer.unref();
        ws.on('pong', () => { alive = true; });
        upstream.on(tcp ? 'data' : 'message', data => {
          if (!host.computer.verifyOwner(agentId, window.window_index, window.owner_token) || ws.bufferedAmount > 8 * 1024 * 1024) return close();
          if (ws.readyState === WebSocket.OPEN) ws.send(data, {binary:true});
        });
        ws.on('message', data => {
          if (!host.computer.verifyOwner(agentId, window.window_index, window.owner_token)) return close();
          if (tcp) upstream.write(data); else if (upstream.readyState === WebSocket.OPEN) upstream.send(data);
        });
        ws.on('close', close); ws.on('error', close); upstream.on('error', close); upstream.on('close', close);
      });
    } catch {
      if (controller && window && host.computer.userControllers.get(window.agent_id) === controller) host.computer.userControllers.delete(window.agent_id);
      reject('409 Conflict');
    }
  });
  server.on('close', () => { for (const client of sockets.clients) client.terminate(); sockets.close(); });
}
