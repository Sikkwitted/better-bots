export function createDesktopViewer({root, status, screen, enlarge, control, retry, dialog, openDesktop}) {
  let selected = null, assignment = null, rfb = null, generation = 0, controlling = false, connected = false;
  let opening = null;
  const home = root.parentElement;
  function disconnect() { generation++; rfb?.disconnect(); rfb = null; connected = false; controlling = false; control.textContent = 'Take over'; control.disabled = true; }
  async function connect(takeover = false) {
    disconnect();
    if (!assignment) return;
    const version = generation;
    status.textContent = 'Connecting to desktop…'; retry.hidden = false; retry.disabled = true; retry.textContent = 'Connecting…';
    try {
      const {default:RFB} = await import('/vendor/novnc/core/rfb.js');
      if (version !== generation) return;
      const url = new URL('/api/desktop/stream', location.href);
      url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('agent_id', selected); if (takeover) url.searchParams.set('control', '1');
      const client = new RFB(screen, url.toString()); rfb = client;
      client.viewOnly = !takeover; client.scaleViewport = true;
      client.addEventListener('connect', () => {
        if (version !== generation) return;
        connected = true; controlling = takeover; control.disabled = false;
        retry.disabled = false; retry.textContent = 'Reconnect';
        control.textContent = takeover ? 'Return control' : 'Take over';
        status.textContent = takeover ? 'You’re in control · bot desktop actions are paused.' : 'Live · watching only';
        if (takeover) client.focus();
      });
      client.addEventListener('disconnect', () => {
        if (version !== generation) return;
        connected = false; controlling = false; control.disabled = true;
        retry.disabled = false; retry.textContent = 'Reconnect';
        control.textContent = 'Take over'; status.textContent = 'Desktop disconnected. Reconnect to continue watching.'; retry.hidden = false;
      });
    } catch (error) { if (version === generation) { status.textContent = `Desktop unavailable: ${error.message}`; retry.hidden = false; retry.disabled = false; retry.textContent = 'Reconnect'; } }
  }
  enlarge.onclick = () => { dialog.append(root); dialog.showModal(); enlarge.hidden = true; };
  dialog.querySelector('button').onclick = () => dialog.close();
  dialog.addEventListener('close', () => { home.prepend(root); enlarge.hidden = false; if (controlling) connect(false); });
  control.onclick = () => { if (!connected) return; if (!controlling && !dialog.open) enlarge.click(); connect(!controlling); };
  retry.onclick = () => { if (selected && !retry.disabled) open(selected); };
  // Opening asks the host for a screen. With more bots than screens, the host
  // parks the longest-idle desktop that is not running, watched or controlled.
  async function open(agentId) {
    disconnect(); const version = generation; opening = agentId;
    retry.disabled = true; retry.textContent = 'Connecting…';
    status.textContent = 'Opening desktop…';
    try {
      const {window} = await openDesktop(agentId);
      if (version !== generation || selected !== agentId) return;
      assignment = {...window, key:`${agentId}:${window.window_index}:${window.owner_token ?? ''}`};
      enlarge.disabled = false;
      await connect(false);
    } catch (error) {
      if (version === generation && selected === agentId) {
        status.textContent = `Desktop unavailable: ${error.message}`;
        retry.disabled = false; retry.textContent = 'Try again';
      }
    } finally { if (opening === agentId) opening = null; }
  }
  // Wait briefly before opening on selection so skimming the roster does not
  // start (and park) a screen for every bot passed on the way.
  const AUTO_OPEN_DELAY_MS = 800;
  let autoTimer = null;
  return {
    update(agent) {
      if (opening && opening === agent?.id) return;
      const next = agent?.window;
      const key = next ? `${agent.id}:${next.window_index}:${next.owner_token ?? ''}` : null;
      if (selected === agent?.id && assignment?.key === key) return;
      if (!next && selected === (agent?.id ?? null) && !assignment) return;
      const changed = selected !== (agent?.id ?? null);
      clearTimeout(autoTimer); autoTimer = null;
      disconnect(); opening = null; selected = agent?.id ?? null; assignment = next ? {...next, key} : null;
      root.querySelector('h2').textContent = agent ? `${agent.name}’s desktop` : 'Bot desktop';
      enlarge.disabled = !next; retry.hidden = !agent; retry.disabled = !agent; retry.textContent = next ? 'Reconnect' : 'Open desktop';
      if (!next) {
        screen.replaceChildren();
        if (!agent) { status.textContent = 'Select a bot to watch its desktop.'; return; }
        status.textContent = changed ? 'Opening desktop…' : 'Desktop is not open. Click Open desktop to start it.';
        if (changed) {
          const agentId = agent.id, version = generation;
          autoTimer = setTimeout(() => { autoTimer = null; if (selected === agentId && version === generation && !assignment && !opening) open(agentId); }, AUTO_OPEN_DELAY_MS);
        }
        return;
      }
      connect(false);
    }
  };
}
