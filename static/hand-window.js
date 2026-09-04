const handState = {
  hand: [],
  selected: new Set(),
  backStyle: 'dummy',
  tableId: new URLSearchParams(window.location.search).get('table') || '',
  table: null,
  stackMode: null,
};
const hand$ = (selector) => document.querySelector(selector);

function handEscape(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));
}

function handCardMarkup(item) {
  const selected = handState.selected.has(item.uid) ? ' selected' : '';
  if (!item.face_up || !item.card) return `<button class="hand-card${selected}" data-uid="${handEscape(item.uid)}"><span class="card-back ${handState.backStyle === 'dummy' ? 'dummy-back' : ''}">DM</span></button>`;
  const image = item.card.image_url
    ? `<img src="${handEscape(item.card.image_url)}" alt="" onerror="this.remove()">`
    : `<span class="card-placeholder">${handEscape((item.card.civiltxt || '◇').slice(0, 1))}</span>`;
  return `<button class="hand-card${selected}" data-uid="${handEscape(item.uid)}"><span class="card-face">${image}</span></button>`;
}

function handSignature(hand) {
  return JSON.stringify((hand || []).map((item) => [
    item.uid,
    Boolean(item.face_up),
    Boolean(item.tapped),
    item.card?.id || null,
    item.card?.image_url || null,
  ]));
}

function updateHand(nextHand) {
  const normalized = Array.isArray(nextHand) ? nextHand : [];
  if (handSignature(normalized) === handSignature(handState.hand)) return false;
  handState.hand = normalized;
  renderHand();
  return true;
}

function renderHand() {
  handState.selected.forEach((uid) => {
    if (!handState.hand.some((item) => item.uid === uid)) handState.selected.delete(uid);
  });
  hand$('#hand-count').textContent = `${handState.hand.length}枚`;
  hand$('#hand-cards').innerHTML = handState.hand.length
    ? handState.hand.map(handCardMarkup).join('')
    : '<p class="empty-state">手札はありません。</p>';
  hand$$('.hand-card').forEach((node) => {
    node.addEventListener('click', (event) => {
      const uid = node.dataset.uid;
      if (event.ctrlKey || event.metaKey) {
        if (handState.selected.has(uid)) handState.selected.delete(uid); else handState.selected.add(uid);
      } else {
        handState.selected.clear();
        handState.selected.add(uid);
      }
      renderHand();
    });
    node.addEventListener('contextmenu', (event) => { event.preventDefault(); showHandMenu(event, node.dataset.uid); });
    node.addEventListener('pointerenter', () => showHandPreview(handState.hand.find((item) => item.uid === node.dataset.uid)));
  });
}

function hand$$(selector) { return Array.from(document.querySelectorAll(selector)); }

function sendHandCommand(body) {
  if (handState.stackMode) {
    hand$('.hand-help').textContent = '本体画面で重ねる操作を完了するか、キャンセルしてください。';
    return;
  }
  if (!handState.tableId) {
    if (window.opener && !window.opener.closed) window.opener.postMessage({ type: 'dm-hand-command', body }, window.location.origin);
    hand$('#hand-menu').classList.add('hidden');
    return;
  }
  fetch(`/api/tables/${encodeURIComponent(handState.tableId)}/commands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (response) => {
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    if (data.table) handState.table = data.table;
    if (data.table?.players?.[0]?.zones?.hand) updateHand(data.table.players[0].zones.hand);
  }).catch((error) => {
    hand$('.hand-help').textContent = `操作に失敗しました: ${error.message}`;
  });
  hand$('#hand-menu').classList.add('hidden');
}

function showHandPreview(item) {
  const node = hand$('#hand-viewer-content');
  if (!item || !item.face_up || !item.card) {
    node.innerHTML = '<span class="card-back viewer-back">DM</span>';
    return;
  }
  const image = item.card.image_url
    ? `<img src="${handEscape(item.card.image_url)}" alt="" onerror="this.remove()">`
    : `<span class="card-placeholder">${handEscape((item.card.civiltxt || '◇').slice(0, 1))}</span>`;
  node.innerHTML = `<div class="viewer-art">${image}</div><p class="viewer-ability">${handEscape(item.card.abilitytxt || '')}</p>`;
}

async function refreshHandFromTable() {
  if (!handState.tableId) return;
  try {
    const response = await fetch(`/api/tables/${encodeURIComponent(handState.tableId)}`, { cache: 'no-store' });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    handState.table = data.table || null;
    const nextHand = data.table?.players?.[0]?.zones?.hand || [];
    updateHand(nextHand);
  } catch (error) {
    hand$('.hand-help').textContent = `テーブルとの接続を待っています…`;
  }
}

function positionHandMenu(menu, event) {
  menu.classList.remove('hidden');
  const margin = 8;
  const menuWidth = menu.offsetWidth || 210;
  const menuHeight = menu.offsetHeight || 300;
  menu.style.left = `${Math.max(margin, Math.min(event.clientX, window.innerWidth - menuWidth - margin))}px`;
  menu.style.top = `${Math.max(margin, Math.min(event.clientY, window.innerHeight - menuHeight - margin))}px`;
}

function updateHandStackUI(message = '') {
  const mode = handState.stackMode;
  const description = mode?.waiting ? '本体画面の応答を待っています…' : mode?.busy ? 'カードを重ねています…' :
    `${mode?.cardIds.length || 0}枚を対象の${mode?.position === 'below' ? '下' : '上'}へ。本体画面の緑枠のカードを左クリックしてください。`;
  handStackPanel.update(mode, message || description);
}

function beginHandStackMode() {
  if (handState.stackMode) return;
  const cardIds = Array.from(handState.selected);
  if (!handState.tableId || !cardIds.length) {
    hand$('.hand-help').textContent = '対戦を開始し、重ねる手札を選択してください。';
    return;
  }
  const requestId = stackRequestId();
  handState.stackMode = { requestId, cardIds, position: 'above', waiting: true, busy: false };
  hand$('#hand-menu').classList.add('hidden');
  updateHandStackUI();
  handStackBridge.send({ type: 'start', requestId, cardIds });
  window.setTimeout(() => {
    if (handState.stackMode?.requestId !== requestId || !handState.stackMode.waiting) return;
    cancelHandStackMode();
    hand$('.hand-help').textContent = '本体画面から応答がありません。本体で同じ対戦を開いてから、もう一度操作してください。';
  }, 5000);
}

function cancelHandStackMode() {
  const mode = handState.stackMode;
  if (!mode || mode.busy) return;
  handStackBridge.send({ type: 'cancel', requestId: mode.requestId });
  handState.stackMode = null;
  updateHandStackUI();
}

function receiveFieldStackMode(message) {
  const mode = handState.stackMode;
  if (!mode || message?.type !== 'status' || message.requestId !== mode.requestId) return;
  if (!message.active) {
    handState.stackMode = null;
    hand$('.hand-help').textContent = message.message || '重ねるモードを解除しました。';
    refreshHandFromTable();
  } else {
    mode.waiting = false;
    mode.position = message.position;
    mode.busy = Boolean(message.busy);
  }
  updateHandStackUI(message.message);
}

const handStackPanel = createStackModePanel(hand$('#hand-stack-mode'), (position) => {
  const mode = handState.stackMode;
  if (mode && !mode.waiting && !mode.busy) handStackBridge.send({ type: 'position', requestId: mode.requestId, position });
}, cancelHandStackMode);
const handStackBridge = createStackModeBridge('hand', () => handState.tableId, () => window.opener, receiveFieldStackMode);

function showHandMenu(event, uid) {
  if (handState.stackMode) return;
  if (!handState.selected.has(uid)) {
    handState.selected.clear();
    handState.selected.add(uid);
    renderHand();
  }
  const menu = hand$('#hand-menu');
  menu.innerHTML = `<button data-hand-stack>カードを重ねる ▶</button><button data-zone="mana">マナへ</button><button data-zone="graveyard">墓地へ</button><button data-zone="battle">バトルゾーンへ</button><button data-zone="shields">シールドゾーンへ</button><button data-zone="shields" data-position="face_up">表向きでシールドゾーンへ</button>${specialZoneMenuMarkup("hand-special-zones")}<button data-zone="deck" data-position="top">山札の一番上へ</button><button data-zone="deck" data-position="bottom">山札の一番下へ</button><div class="menu-separator"></div><button data-command="tap" data-value="true">タップする</button><button data-command="tap" data-value="false">アンタップする</button><button data-command="flip" data-value="false">裏向きにする</button>`;
  positionHandMenu(menu, event);
  bindSpecialZoneMenu(menu, () => positionHandMenu(menu, event));
  menu.querySelector('[data-hand-stack]').addEventListener('click', (clickEvent) => {
    clickEvent.stopPropagation();
    beginHandStackMode();
  });
  menu.querySelectorAll('[data-zone]').forEach((button) => button.addEventListener('click', () => sendHandCommand({ command: 'move', card_ids: Array.from(handState.selected), zone: button.dataset.zone, position: button.dataset.position || 'append', target_player: 0 })));
  menu.querySelectorAll('[data-command]').forEach((button) => button.addEventListener('click', () => sendHandCommand({ command: button.dataset.command, card_ids: Array.from(handState.selected), value: button.dataset.value === 'true' })));
}

window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin || event.source !== window.opener || event.data?.type !== 'dm-hand-state') return;
  if (event.data.tableId) handState.tableId = String(event.data.tableId);
  if (event.data.table) handState.table = event.data.table;
  const backStyleChanged = handState.backStyle !== (event.data.backStyle === 'pattern' ? 'pattern' : 'dummy');
  handState.backStyle = event.data.backStyle === 'pattern' ? 'pattern' : 'dummy';
  if (backStyleChanged) renderHand(); else updateHand(event.data.hand);
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('#hand-menu, .hand-card')) hand$('#hand-menu').classList.add('hidden');
});
hand$('#hand-menu').addEventListener('click', (event) => event.stopPropagation());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    hand$('#hand-menu').classList.add('hidden');
    cancelHandStackMode();
  }
});

if (window.opener && !window.opener.closed) window.opener.postMessage({ type: 'dm-hand-window-ready' }, window.location.origin);

refreshHandFromTable();
window.setInterval(refreshHandFromTable, 1000);
