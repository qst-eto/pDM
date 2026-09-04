function stackRequestId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Both windows use a table-scoped channel, including when window.opener is unavailable.
function createStackModeBridge(role, getTableId, getPeer, receive) {
  let tableId = '';
  let channel = null;
  const seen = new Set();
  function accept(message) {
    if (!message || message.type !== 'dm-stack-mode' || message.role === role ||
        message.tableId !== getTableId() || seen.has(message.id)) return;
    seen.add(message.id);
    if (seen.size > 100) seen.delete(seen.values().next().value);
    receive(message.payload);
  }
  function connect() {
    const nextId = getTableId() || '';
    if (nextId === tableId) return;
    channel?.close();
    channel = null;
    tableId = nextId;
    if (tableId && typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(`dm-stack-mode:${tableId}`);
      channel.onmessage = (event) => accept(event.data);
    }
  }
  window.addEventListener('message', (event) => {
    if (event.origin === window.location.origin && event.source === getPeer()) accept(event.data);
  });
  window.addEventListener('pagehide', () => channel?.close());
  return {
    connect,
    send(payload) {
      connect();
      if (!tableId) return;
      const message = { type: 'dm-stack-mode', id: stackRequestId(), role, tableId, payload };
      channel?.postMessage(message);
      const peer = getPeer();
      if (peer && !peer.closed) peer.postMessage(message, window.location.origin);
    },
  };
}

function createStackModePanel(node, onPosition, onCancel) {
  node.innerHTML = '<div class="stack-mode-copy" role="status" aria-live="polite"><strong>重ねるモード</strong><span data-stack-status></span></div><div class="stack-mode-controls"><button type="button" data-mode-position="above">上に重ねる</button><button type="button" data-mode-position="below">下に重ねる</button><button type="button" data-mode-cancel>キャンセル（Esc）</button></div>';
  node.querySelectorAll('[data-mode-position]').forEach((button) => {
    button.addEventListener('click', () => onPosition(button.dataset.modePosition));
  });
  node.querySelector('[data-mode-cancel]').addEventListener('click', onCancel);
  return {
    update(mode, message = '') {
      node.classList.toggle('hidden', !mode);
      if (!mode) return;
      node.querySelector('[data-stack-status]').textContent = message;
      node.querySelectorAll('[data-mode-position]').forEach((button) => {
        button.setAttribute('aria-pressed', String(button.dataset.modePosition === mode.position));
        button.disabled = Boolean(mode.busy || mode.waiting);
      });
      node.querySelector('[data-mode-cancel]').disabled = Boolean(mode.busy);
    },
  };
}
