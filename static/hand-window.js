const handState = {
  hand: [],
  selected: new Set(),
  backStyle: 'dummy',
  tableId: new URLSearchParams(window.location.search).get('table') || '',
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
    const nextHand = data.table?.players?.[0]?.zones?.hand || [];
    updateHand(nextHand);
  } catch (error) {
    hand$('.hand-help').textContent = `テーブルとの接続を待っています…`;
  }
}

function showHandMenu(event, uid) {
  if (!handState.selected.has(uid)) {
    handState.selected.clear();
    handState.selected.add(uid);
    renderHand();
  }
  const menu = hand$('#hand-menu');
  menu.innerHTML = `<button data-zone="mana">マナへ</button><button data-zone="graveyard">墓地へ</button><button data-zone="battle">バトルゾーンへ</button><button data-zone="shields">シールドゾーンへ</button><button data-zone="shields" data-position="face_up">表向きでシールドゾーンへ</button><button data-zone="deck" data-position="top">山札の一番上へ</button><button data-zone="deck" data-position="bottom">山札の一番下へ</button><div class="menu-separator"></div><button data-command="tap" data-value="true">タップする</button><button data-command="tap" data-value="false">アンタップする</button><button data-command="flip" data-value="false">裏向きにする</button>`;
  menu.classList.remove('hidden');
  menu.style.left = `${Math.min(event.clientX, window.innerWidth - 220)}px`;
  menu.style.top = `${Math.min(event.clientY, window.innerHeight - 300)}px`;
  menu.querySelectorAll('[data-zone]').forEach((button) => button.addEventListener('click', () => sendHandCommand({ command: 'move', card_ids: Array.from(handState.selected), zone: button.dataset.zone, position: button.dataset.position || 'append', target_player: 0 })));
  menu.querySelectorAll('[data-command]').forEach((button) => button.addEventListener('click', () => sendHandCommand({ command: button.dataset.command, card_ids: Array.from(handState.selected), value: button.dataset.value === 'true' })));
}

window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin || event.source !== window.opener || event.data?.type !== 'dm-hand-state') return;
  if (event.data.tableId) handState.tableId = String(event.data.tableId);
  const backStyleChanged = handState.backStyle !== (event.data.backStyle === 'pattern' ? 'pattern' : 'dummy');
  handState.backStyle = event.data.backStyle === 'pattern' ? 'pattern' : 'dummy';
  if (backStyleChanged) renderHand(); else updateHand(event.data.hand);
});

document.addEventListener('click', (event) => {
  if (!event.target.closest('#hand-menu, .hand-card')) hand$('#hand-menu').classList.add('hidden');
});

if (window.opener && !window.opener.closed) window.opener.postMessage({ type: 'dm-hand-window-ready' }, window.location.origin);

refreshHandFromTable();
window.setInterval(refreshHandFromTable, 1000);
