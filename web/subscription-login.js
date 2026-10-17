const node = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text) e.textContent = text; return e; };

export function mountSubscriptionLogin({ root, provider, api, onConnected }) {
  let disposed = false, timer, state = provider.login ?? { state: 'idle' }, last = '';
  const box = node('div', 'subscription-login'); root.append(box);
  async function apply(next) {
    if (disposed) return;
    state = next; render();
    clearTimeout(timer);
    if (next.state === 'connected') { await onConnected(); return; }
    if (['starting', 'waiting'].includes(next.state)) {
      timer = setTimeout(poll, 2000);
    }
  }
  async function poll() {
    try { await apply(await api('GET', '/api/providers/codex/login')); }
    catch { await apply({ state: 'failed', message: 'Could not check sign-in. Reopen AI providers to check your connection or try again.' }); }
  }
  async function start() {
    clearTimeout(timer);
    state = { state: 'starting' }; render();
    try { await apply(await api('POST', '/api/providers/codex/login', {})); }
    catch { await apply({ state: 'failed', message: 'Could not reach the sign-in service. Please try again.' }); }
  }
  function render() {
    const key = JSON.stringify(state); if (last === key) return; last = key;
    box.replaceChildren();
    const active = ['starting', 'waiting'].includes(state.state);
    const message = node('p', 'hint'); message.setAttribute('role', 'status');
    message.textContent = state.state === 'idle'
      ? (provider.needs_reconnect ? 'Your previous sign-in is no longer valid. Reconnect your ChatGPT subscription.'
        : provider.configured ? `ChatGPT${provider.account?.plan ? ` ${provider.account.plan}` : ''} is linked. Reconnect to renew sign-in or use another account.`
        : 'Use your ChatGPT subscription. Sign in with OpenAI in your browser; no API key or terminal is needed.')
      : state.state === 'starting' ? 'Preparing secure sign-in…'
      : state.state === 'waiting' ? (state.message ?? 'Open OpenAI and approve the connection using your usual sign-in method. This page updates automatically.')
      : state.message ?? 'Sign-in ended. Try again.';
    box.append(message);
    if (state.state === 'waiting' && state.verification_url) {
      const link = node('a', 'primary subscription-open', 'Open OpenAI sign-in');
      link.href = state.verification_url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      box.append(link);
      const help = node('p', 'hint', 'If Better Bots does not connect after OpenAI sends you to localhost, copy the complete localhost address from that tab and paste it below. The address contains a short-lived sign-in code; paste it only into this Better Bots session.');
      const form = node('form', 'subscription-callback');
      const label = node('label', null, 'Callback URL from browser');
      const input = node('input'); input.type = 'url'; input.required = true; input.autocomplete = 'off'; input.spellcheck = false;
      input.setAttribute('aria-label', 'Callback URL from browser');
      input.placeholder = 'http://localhost:1455/auth/callback?...';
      label.append(input);
      const submit = node('button', 'primary', 'Complete sign-in'); submit.type = 'submit';
      const feedback = node('p', 'hint'); feedback.setAttribute('role', 'status');
      form.onsubmit = async event => {
        event.preventDefault();
        submit.disabled = true;
        feedback.textContent = 'Completing sign-in…';
        try {
          const result = await api('POST', '/api/providers/codex/login/callback', { id: state.id, callback_url: input.value.trim() });
          input.value = '';
          await apply(result);
          if (result.state === 'waiting') feedback.textContent = 'Callback received. Waiting for OpenAI to finish sign-in…';
        } catch (error) {
          input.value = '';
          feedback.textContent = error.message || 'Could not complete sign-in. Check the sign-in status and try again.';
        } finally { submit.disabled = false; }
      };
      form.append(label, submit, feedback);
      box.append(help, form);
    }
    const actions = node('div', 'provider-form');
    if (!active && state.state !== 'connected') {
      const button = node('button', 'primary', provider.configured || provider.needs_reconnect ? 'Reconnect ChatGPT' : 'Connect ChatGPT'); button.type = 'button'; button.onclick = start; actions.append(button);
    }
    if (active) {
      const cancel = node('button', 'ghost', 'Cancel sign-in'); cancel.type = 'button';
      cancel.onclick = async () => { cancel.disabled = true; clearTimeout(timer); try { await apply(await api('DELETE', '/api/providers/codex/login', { id: state.id })); } catch { cancel.disabled = false; } };
      actions.append(cancel);
    }
    box.append(actions);
    const note = node('p', 'hint subscription-help', 'You can cancel and try again without removing your previous connection.');
    box.append(note);
  }
  // A completed old attempt is not a new completion event on every render.
  if (state.state === 'connected') state = { state: 'idle' };
  render();
  if (['starting', 'waiting'].includes(state.state)) timer = setTimeout(poll, 2000);
  return { dispose() { disposed = true; clearTimeout(timer); } };
}
