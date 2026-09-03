const state = {
  cards: [],
  cardCache: new Map(),
  deck: [],
  table: null,
  selected: new Set(),
  inspectorSelected: new Set(),
  inspectorTargetPlayer: 0,
  hiddenZones: new Set(),
  autoHiddenZones: new Set(),
  expandedZones: new Set(),
  mode: 'normal',
  handWindow: null,
  displaySettings: {
    cardScale: 1.1,
    cardHeightPercent: 100,
    battleCardWidth: 0.56,
    labelPosition: 'corner',
    backStyle: 'dummy',
    selfBattleSize: 250,
    opponentBattleSize: 220,
    selfLowerSize: 180,
    opponentLowerSize: 125,
  },
};

const SPECIAL_ZONES = ['extra', 'gachi', 'abyss'];
const EXPANDABLE_ZONES = new Set(['mana', 'graveyard', 'extra', 'abyss']);
const INSPECTABLE_ZONES = new Set(['mana', 'graveyard', 'extra', 'gachi', 'abyss']);
const AUTO_INSPECT_ZONES = new Set(['graveyard', 'extra', 'gachi', 'abyss']);
const ZONE_VIEW_LABELS = {
  mana: 'マナゾーン',
  graveyard: '墓地',
  extra: '超次元',
  gachi: 'ガチャレンジ',
  abyss: '深淵',
};
const SPECIAL_ZONE_KEYWORDS = {
  extra: ['超次元', 'サイキック', 'ドラグハート'],
  gachi: ['ガチャレンジ', 'ＧＲ', 'GRクリーチャー'],
  abyss: ['深淵', 'アビス'],
};

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => Array.from(document.querySelectorAll(selector));

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  }[char]));
}

const CIVILITIES = [
  ['light', ['光', 'light']],
  ['water', ['水', 'water']],
  ['dark', ['闇', 'dark']],
  ['fire', ['火', 'fire']],
  ['nature', ['自然', 'nature']],
  ['zero', ['ゼロ', 'zero']],
];

function cardCivilities(card) {
  const source = [
    card?.mana_civils,
    card?.civiltxt,
    card?.civil_top,
    card?.civil_bottom,
    card?.civiltxt_top,
    card?.civiltxt_bottom,
  ].filter(Boolean).join(' ').toLowerCase();
  const civils = CIVILITIES.filter(([, names]) => names.some((name) => source.includes(name))).map(([civil]) => civil);
  const colored = civils.length > 1 ? civils.filter((civil) => civil !== 'zero') : civils;
  return (colored.length ? colored : ['zero']).slice(0, 5);
}

function civilClass(civil) {
  return `civil-${cardCivilities({ civiltxt: civil })[0]}`;
}

function manaOrbMarkup(item) {
  const visualItem = stackVisualItem(item);
  const civils = cardCivilities(visualItem.card);
  const colors = {
    light: '#edc861',
    water: '#58aceb',
    dark: '#8851b2',
    fire: '#ed604c',
    nature: '#6dbb62',
    zero: '#a1abb7',
  };
  const variables = civils.map((civil, index) => `--mana-color-${index + 1}:${colors[civil]}`).join(';');
  return `<span class="mana-orb multi-${civils.length} ${civils.map((civil) => `civil-${civil}`).join(' ')} ${visualItem.tapped ? 'mana-used' : ''}" style="${variables}" data-uid="${item.uid}" data-player="${item.player ?? ''}" data-zone="mana"></span>`;
}

function cardArt(card, back = false) {
  if (back) return '<div class="card-back" aria-label="裏向きのカード"></div>';
  const image = card && card.image_url
    ? `<img class="card-image" loading="lazy" src="${escapeHtml(card.image_url)}" alt="" onerror="this.remove()">`
    : '';
  return `<div class="card-art ${civilClass(card && card.civiltxt)}">${image}<span class="cost">${escapeHtml(card && card.costtxt || '—')}</span><span class="art-mark">${escapeHtml((card && card.civiltxt || '◇').slice(0, 1))}</span></div>`;
}

function cardName(card) { return escapeHtml(card && card.cardname || '裏向きのカード'); }

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function notice(message = '') {
  const node = $('#notice');
  node.textContent = message;
  node.classList.toggle('visible', Boolean(message));
  if (message) window.setTimeout(() => node.classList.remove('visible'), 4500);
}

async function loadMeta() {
  try {
    const meta = await api('/api/meta');
    $('#db-status').classList.add('ready');
    $('#meta-text').textContent = `カード ${meta.card_count.toLocaleString()} 枚 / 40枚デッキ`;
  } catch (error) { notice(`DBの読み込みに失敗しました: ${error.message}`); }
}

async function loadCards() {
  const params = new URLSearchParams({ q: $('#search').value, civil: $('#civil-filter').value, limit: '80' });
  try {
    const data = await api(`/api/cards?${params.toString()}`);
    state.cards = data.cards;
    state.cards.forEach((card) => state.cardCache.set(card.id, card));
    $('#result-count').textContent = `${state.cards.length}件`;
    renderLibrary();
  } catch (error) { notice(`カード検索に失敗しました: ${error.message}`); }
}

function renderLibrary() {
  const node = $('#library');
  if (!state.cards.length) { node.innerHTML = '<p class="empty-state">該当するカードがありません。</p>'; return; }
  node.innerHTML = state.cards.map((card) => `<button class="library-card" data-add-card="${card.id}">${cardArt(card)}<span class="card-name">${cardName(card)}</span><span class="card-meta">${escapeHtml(card.civiltxt || '文明不明')} / ${escapeHtml(card.typetxt || '')}</span></button>`).join('');
  $$('#library [data-add-card]').forEach((button) => button.addEventListener('click', () => addToDeck(Number(button.dataset.addCard))));
}

function addToDeck(cardId) {
  if (state.deck.length >= 40) { notice('デッキは40枚までです。'); return; }
  state.deck.push(cardId);
  renderDeck();
}

function renderDeck() {
  $('#deck-count').textContent = `${state.deck.length} / 40`;
  const node = $('#deck-list');
  if (!state.deck.length) { node.className = 'deck-list empty-state'; node.textContent = 'カードライブラリからカードを追加してください。'; return; }
  node.className = 'deck-list';
  node.innerHTML = state.deck.map((id, index) => {
    const card = state.cardCache.get(id) || { cardname: '読み込み中' };
    return `<span class="deck-chip"><span>${index + 1}. ${cardName(card)}</span><button data-remove-deck="${index}" aria-label="削除">×</button></span>`;
  }).join('');
  $$('#deck-list [data-remove-deck]').forEach((button) => button.addEventListener('click', () => { state.deck.splice(Number(button.dataset.removeDeck), 1); renderDeck(); }));
}

async function resolveDeckEntries(entries, deckName = '') {
  if (!Array.isArray(entries)) throw new Error('カード一覧が見つかりません。');
  const candidateIds = entries.map((entry) => (entry && typeof entry === 'object' ? entry.id : entry))
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0)
    .slice(0, 40);
  if (!candidateIds.length) throw new Error('有効なカードIDがありません。');

  const resolved = await Promise.all(candidateIds.map(async (id) => {
    if (state.cardCache.has(id)) return { id, card: state.cardCache.get(id) };
    try {
      const card = await api(`/api/cards/${id}`);
      state.cardCache.set(id, card);
      return { id, card };
    } catch (error) {
      return null;
    }
  }));
  const validCards = resolved.filter(Boolean);
  if (!validCards.length) throw new Error('DBに存在するカードがありません。');
  state.deck = validCards.map(({ id }) => id);
  renderDeck();
  const skipped = candidateIds.length - validCards.length;
  const prefix = deckName ? `${deckName}を` : '';
  notice(skipped ? `${prefix}${validCards.length}枚読み込みました（${skipped}枚はDBにありません）。` : `${prefix}${validCards.length}枚のデッキを読み込みました。`);
}

async function saveDeckToServer() {
  if (!state.deck.length) { notice('保存するカードがありません。'); return; }
  const fallbackName = `デッキ ${new Date().toLocaleString('ja-JP', { hour12: false })}`;
  const name = window.prompt('保存するデッキ名を入力してください。', fallbackName);
  if (name === null) return;
  try {
    const data = await api('/api/decks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), cards: state.deck }),
    });
    notice(`「${data.deck.name}」をサーバーに保存しました。`);
    loadSavedDecks();
  } catch (error) {
    notice(`デッキの保存に失敗しました: ${error.message}`);
  }
}

async function loadSavedDeck(deckId) {
  try {
    const data = await api(`/api/decks/${encodeURIComponent(deckId)}`);
    await resolveDeckEntries(data.deck.cards, `「${data.deck.name}」を`);
  } catch (error) {
    notice(`デッキの読み込みに失敗しました: ${error.message}`);
  }
}

async function loadSavedDecks() {
  const node = $('#saved-deck-list');
  node.innerHTML = '<p class="empty-state">保存デッキを読み込み中…</p>';
  try {
    const data = await api('/api/decks');
    if (!data.decks.length) {
      node.innerHTML = '<p class="empty-state">保存されたデッキはありません。</p>';
      return;
    }
    node.innerHTML = data.decks.map((deck) => `<button class="saved-deck-item" data-saved-deck="${escapeHtml(deck.id)}"><span><strong>${escapeHtml(deck.name)}</strong><small>${deck.card_count}枚${deck.saved_at ? ` / ${escapeHtml(new Date(deck.saved_at).toLocaleString('ja-JP'))}` : ''}</small></span><span class="saved-deck-open">開く</span></button>`).join('');
    node.querySelectorAll('[data-saved-deck]').forEach((button) => button.addEventListener('click', () => loadSavedDeck(button.dataset.savedDeck)));
  } catch (error) {
    node.innerHTML = `<p class="empty-state">保存デッキの取得に失敗しました: ${escapeHtml(error.message)}</p>`;
  }
}

function openHandWindow() {
  if (state.handWindow && !state.handWindow.closed) {
    state.handWindow.focus();
    return;
  }
  const handUrl = state.table ? `/hand.html?table=${encodeURIComponent(state.table.id)}` : '/hand.html';
  state.handWindow = window.open(
    handUrl,
    'dm-table-forge-hand',
    'popup=yes,resizable=yes,scrollbars=yes,width=1050,height=680',
  );
  if (!state.handWindow) notice('手札ウィンドウを開けませんでした。ブラウザのポップアップを許可してください。');
}

function closeHandWindow() {
  if (state.handWindow && !state.handWindow.closed) state.handWindow.close();
  state.handWindow = null;
}

function syncHandWindow() {
  if (state.mode !== 'remote' || !state.table || !state.handWindow || state.handWindow.closed) return;
  state.handWindow.postMessage({
    type: 'dm-hand-state',
    tableId: state.table.id,
    hand: state.table.players[0].zones.hand || [],
    backStyle: state.displaySettings.backStyle,
  }, window.location.origin);
}

function setHandWindowTable() {
  if (state.mode !== 'remote' || !state.table || !state.handWindow || state.handWindow.closed) return;
  state.handWindow.location.href = `/hand.html?table=${encodeURIComponent(state.table.id)}`;
  state.handWindow.focus();
}

async function startTable() {
  state.mode = $('#play-mode').value === 'remote' ? 'remote' : 'normal';
  if (state.mode === 'remote') openHandWindow(); else closeHandWindow();
  try {
    const data = await api('/api/tables', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ player_name: 'プレイヤー', deck: state.deck }) });
    state.table = data.table;
    state.selected.clear();
    state.hiddenZones.clear();
    state.autoHiddenZones.clear();
    state.expandedZones.clear();
    $('#setup-screen').classList.add('hidden');
    $('#game-screen').classList.remove('hidden');
    $('#game-screen').classList.toggle('remote-mode', state.mode === 'remote');
    $('#hand-window-toggle').classList.toggle('hidden', state.mode !== 'remote');
    setHandWindowTable();
    renderTable();
    fitGameField();
  } catch (error) {
    closeHandWindow();
    notice(`テーブル作成に失敗しました: ${error.message}`);
  }
}

function itemMarkup(item, options = {}) {
  const visualItem = stackVisualItem(item);
  const card = options.hideCard ? null : visualItem.card;
  const selected = state.selected.has(item.uid) ? 'selected' : '';
  const tapped = visualItem.tapped ? 'tapped' : '';
  const className = options.compact ? 'table-card compact' : 'table-card';
  const count = stackCount(item);
  const badge = count ? `<span class="stack-badge">${count}枚重ね</span>` : '';
  return `<div class="${className} ${selected} ${tapped}" draggable="true" data-uid="${item.uid}" data-player="${options.player}" data-zone="${options.zone}" data-visible-card="${card ? 'true' : 'false'}">${card ? cardArt(card) : cardArt(null, true)}${badge}</div>`;
}

function zoneKey(playerIndex, zone) {
  return `${playerIndex}:${zone}`;
}

function isZoneHidden(zone) {
  return state.hiddenZones.has(zone) || state.autoHiddenZones.has(zone);
}

function cardMatchesSpecialZone(card, zone) {
  if (!card) return false;
  const text = ['cardname', 'typetxt', 'racetxt', 'packname'].map((key) => card[key] || '').join(' ');
  return SPECIAL_ZONE_KEYWORDS[zone].some((keyword) => text.includes(keyword));
}

function syncSpecialZoneVisibility() {
  if (!state.table) return;
  SPECIAL_ZONES.forEach((zone) => {
    const hasDeckCard = state.deck.some((id) => cardMatchesSpecialZone(state.cardCache.get(id), zone));
    const hasTableCard = state.table.players.some((player) => (player.zones[zone] || []).length > 0);
    if (hasDeckCard || hasTableCard) state.autoHiddenZones.delete(zone);
    else state.autoHiddenZones.add(zone);
  });
  $$('[data-zone-toggle]').forEach((input) => { input.checked = !isZoneHidden(input.dataset.zoneToggle); });
}

function updateSpecialZoneLayout() {
  $$('.special-zones-above').forEach((group) => {
    group.classList.toggle('all-hidden', !group.querySelector('.zone:not(.zone-hidden)'));
  });
}

function isZoneExpanded(playerIndex, zone) {
  return state.expandedZones.has(zoneKey(playerIndex, zone));
}

function zoneItems(playerIndex, zone) {
  const player = state.table.players[playerIndex];
  return zone === 'shields' ? (player.shields || []) : (player.zones[zone] || []);
}

function findTableItem(playerIndex, zone, uid) {
  return zoneItems(playerIndex, zone).find((item) => item.uid === uid);
}

function stackParts(item) {
  const stack = item?.stack;
  return {
    below: Array.isArray(stack?.below) ? stack.below : [],
    above: Array.isArray(stack?.above) ? stack.above : [],
  };
}

function stackCount(item) {
  const stack = stackParts(item);
  return [...stack.below, ...stack.above].reduce((count, child) => count + 1 + stackCount(child), 0);
}

function stackVisualItem(item) {
  const stack = stackParts(item);
  return stack.above.length ? stackVisualItem(stack.above[stack.above.length - 1]) : item;
}

function stackDetailItems(item) {
  const stack = stackParts(item);
  const flatten = (items) => items.flatMap((child) => [...flatten(stackParts(child).below), child, ...flatten(stackParts(child).above)]);
  return [...flatten(stack.below), item, ...flatten(stack.above)];
}

function compactStackMarkup(items, playerIndex, zone) {
  if (!items.length) return '<span class="muted">空</span>';
  const topItem = zone === 'deck' && !items[0].face_up ? { ...items[0], card: null } : items[0];
  const itemCount = items.reduce((count, item) => count + 1 + stackCount(item), 0);
  return `<span class="stack-slot">${itemMarkup(topItem, { player: playerIndex, zone, compact: true })}<span class="stack-count">${itemCount}</span></span>`;
}

function renderZone(playerIndex, zone) {
  const zoneNode = $(`.zone[data-player="${playerIndex}"][data-zone="${zone}"]`);
  if (!zoneNode) return;
  const content = zoneNode.querySelector('[data-content]');
  const items = zoneItems(playerIndex, zone);
  const itemCount = items.reduce((count, item) => count + 1 + stackCount(item), 0);
  zoneNode.querySelector('[data-count]')?.replaceChildren(document.createTextNode(String(itemCount)));
  if (isZoneHidden(zone)) { zoneNode.classList.add('zone-hidden'); zoneNode.classList.remove('expanded-zone'); content.innerHTML = '<span class="muted">非表示</span>'; return; }
  zoneNode.classList.remove('zone-hidden');
  zoneNode.classList.toggle('expanded-zone', isZoneExpanded(playerIndex, zone));
  if (zone === 'shields') {
    content.innerHTML = items.map((item) => itemMarkup(item, { player: playerIndex, zone, compact: true, hideCard: !item.face_up })).join('') || '<span class="muted">なし</span>';
    return;
  }
  if (zone === 'deck' || zone === 'gachi') {
    content.innerHTML = compactStackMarkup(items, playerIndex, zone);
    return;
  }
  if (zone === 'mana' && !isZoneExpanded(playerIndex, zone)) {
    const orbs = items.map((item) => manaOrbMarkup({ ...item, player: playerIndex })).join('');
    content.innerHTML = orbs || '<span class="muted">空</span>';
    return;
  }
  if (!isZoneExpanded(playerIndex, zone) && zone !== 'battle' && zone !== 'hand') {
    const last = items[items.length - 1];
    content.innerHTML = last ? itemMarkup(last, { player: playerIndex, zone, compact: true }) : '<span class="muted">空</span>';
    return;
  }
  const compact = zone !== 'battle' && !(zone === 'hand' && playerIndex === 0);
  content.innerHTML = items.map((item) => itemMarkup(item, { player: playerIndex, zone, compact })).join('') || '<span class="muted">空</span>';
}

function renderShields(playerIndex) { renderZone(playerIndex, 'shields'); }

function tableStateChanged(nextTable) {
  return JSON.stringify(state.table) !== JSON.stringify(nextTable);
}

function renderTable() {
  const table = state.table;
  if (!table) return;
  syncSpecialZoneVisibility();
  $('#table-id').textContent = `ROOM ${table.id}`;
  $('#turn-badge').textContent = table.active_player === 0 ? 'YOUR TURN' : 'OPPONENT TURN';
  $('#opponent-name').textContent = table.players[1].name;
  const selfCounts = table.players[0].counts;
  const opponentCounts = table.players[1].counts;
  $('#opponent-counts').textContent = `手札 ${opponentCounts.hand} / 山札 ${opponentCounts.deck} / シールド ${table.players[1].shield_count}`;
  $('[data-count="self-battle"]').textContent = String(selfCounts.battle);
  $('[data-count="opponent-battle"]').textContent = String(opponentCounts.battle);
  [0, 1].forEach((playerIndex) => ['deck', 'hand', 'mana', 'graveyard', 'battle', 'extra', 'gachi', 'abyss'].forEach((zone) => renderZone(playerIndex, zone)));
  [0, 1].forEach(renderShields);
  updateSpecialZoneLayout();
  $('#selection-count').textContent = `${state.selected.size}枚選択中`;
  $('#field-message').textContent = table.active_player === 0 ? '右クリックで操作 / ドラッグで移動 / クリックでゾーン展開 / ホイールでタップ' : '相手の操作を待っています';
  $('#log-strip').textContent = table.log.length ? table.log[table.log.length - 1] : '';
  bindCardEvents();
  renderLog();
  fitZoneCards();
  syncHandWindow();
}

function renderLog() { $('#battle-log'); }

function selectCard(uid, additive = false) {
  state.expandedZones.clear();
  if (!additive) state.selected.clear();
  if (state.selected.has(uid) && additive) state.selected.delete(uid); else state.selected.add(uid);
  renderTable();
}

function hidePreview() {
  const node = $('#viewer-content');
  node.innerHTML = '<span class="muted">カードにカーソルを合わせると、ここに拡大表示します</span>';
}

function showPreview(card) {
  const node = $('#viewer-content');
  if (!card) { hidePreview(); return; }
  node.innerHTML = `${cardArt(card)}<div class="preview-text">${escapeHtml(card.abilitytxt || '')}</div>`;
}

function positionContextMenu(node, x, y) {
  node.classList.remove('hidden');
  const margin = 8;
  const menuWidth = node.offsetWidth || 210;
  const menuHeight = node.offsetHeight || 430;
  node.style.left = `${Math.max(margin, Math.min(x, window.innerWidth - menuWidth - margin))}px`;
  node.style.top = `${Math.max(margin, Math.min(y, window.innerHeight - menuHeight - margin))}px`;
}

function selectedStackSources(playerIndex, zone) {
  if (!state.table) return [];
  const items = zoneItems(playerIndex, zone);
  const selected = items.filter((item) => state.selected.has(item.uid));
  const selectedIds = Array.from(state.selected);
  return selected.length === selectedIds.length ? selected : [];
}

function showStackDetailsMenu(node, playerIndex, zone, x, y) {
  const sources = selectedStackSources(playerIndex, zone);
  if (!sources.length) {
    notice('同じゾーンのカードだけを選択して重ねてください。');
    node.classList.add('hidden');
    return;
  }
  const targets = zoneItems(playerIndex, zone).filter((item) => !state.selected.has(item.uid));
  if (!targets.length) {
    notice('重ねる対象のカードがありません。');
    node.classList.add('hidden');
    return;
  }
  const targetOptions = targets.map((item) => {
    const visual = stackVisualItem(item);
    return `<option value="${escapeHtml(item.uid)}">${cardName(visual.card)}${stackCount(item) ? `（${stackCount(item)}枚重ね）` : ''}</option>`;
  }).join('');
  node.innerHTML = `<div class="context-menu-title">重ね方の詳細</div><label class="context-menu-field">表裏<select data-stack-face><option value="true">表向きで重ねる</option><option value="false">裏向きで重ねる</option></select></label><label class="context-menu-field">重ねる対象<select data-stack-target>${targetOptions}</select></label><button data-stack-position="below">対象カードの下に重ねる</button><button data-stack-position="above">対象カードの上に重ねる</button><div class="menu-separator"></div><button data-stack-back>カード操作へ戻る</button>`;
  positionContextMenu(node, x, y);
  node.querySelectorAll('[data-stack-position]').forEach((button) => button.addEventListener('click', () => {
    const faceUp = node.querySelector('[data-stack-face]').value === 'true';
    const targetId = node.querySelector('[data-stack-target]').value;
    node.classList.add('hidden');
    sendCommand({ command: 'stack', card_ids: sources.map((item) => item.uid), target_id: targetId, face_up: faceUp, position: button.dataset.stackPosition });
  }));
  node.querySelector('[data-stack-back]').addEventListener('click', () => showMenu({ clientX: x, clientY: y }, sources[0].uid, playerIndex, zone));
}

function showMenu(event, uid, playerIndex = 0, zone = '') {
  if (!state.selected.has(uid)) selectCard(uid);
  const node = $('#context-menu');
  const inspectButton = INSPECTABLE_ZONES.has(zone) ? '<button data-menu-command="inspect-zone">内容を見る</button><div class="menu-separator"></div>' : '';
  node.innerHTML = `${inspectButton}<button data-menu-command="stack-details">カードを重ねる ▶</button><button data-menu-command="move" data-zone="hand">手札へ</button><button data-menu-command="move" data-zone="mana">マナへ</button><button data-menu-command="move" data-zone="mana" data-keep-face-down="true">裏向きのままマナへ</button><button data-menu-command="move" data-zone="graveyard">墓地へ</button><button data-menu-command="move" data-zone="battle">バトルゾーンへ</button><button data-menu-command="move" data-zone="shields">シールドゾーンへ</button><button data-menu-command="move" data-zone="shields" data-position="face_up">表向きでシールドゾーンへ</button><button data-menu-command="move" data-zone="extra">超次元へ</button><button data-menu-command="move" data-zone="gachi">ガチャレンジへ</button><button data-menu-command="move" data-zone="abyss">深淵へ</button><div class="menu-separator"></div><button data-menu-command="move" data-zone="deck" data-position="top">山札の一番上へ</button><button data-menu-command="move" data-zone="deck" data-position="bottom">山札の一番下へ</button><button data-menu-command="move" data-zone="deck" data-position="shuffle">山札に加えてシャッフル</button><div class="menu-separator"></div><button data-menu-command="flip" data-value="true">表向きにする</button><button data-menu-command="flip" data-value="false">裏向きにする</button><button data-menu-command="tap" data-value="true">タップする</button><button data-menu-command="tap" data-value="false">アンタップする</button>`;
  positionContextMenu(node, event.clientX, event.clientY);
  node.querySelectorAll('[data-menu-command]').forEach((button) => button.addEventListener('click', () => {
    const command = button.dataset.menuCommand;
    if (command === 'inspect-zone') {
      node.classList.add('hidden');
      openZoneInspector(playerIndex, zone);
      return;
    }
    if (command === 'stack-details') {
      showStackDetailsMenu(node, playerIndex, zone, event.clientX, event.clientY);
      return;
    }
    const body = command === 'move' ? { command, card_ids: Array.from(state.selected), zone: button.dataset.zone, position: button.dataset.position || 'append', target_player: 0, keep_face_down: button.dataset.keepFaceDown === 'true' } : { command, card_ids: Array.from(state.selected), value: button.dataset.value === 'true' };
    node.classList.add('hidden'); sendCommand(body);
  }));
}

function bindCardEvents() {
  $$('.table-card').forEach((node) => {
    node.addEventListener('click', (event) => {
      event.stopPropagation();
      const player = Number(node.dataset.player);
      const zone = node.dataset.zone;
      const item = findTableItem(player, zone, node.dataset.uid);
      if (zone !== 'mana') state.expandedZones.clear();
      if (item && stackCount(item)) {
        openStackInspector(item, player);
        return;
      }
      if (AUTO_INSPECT_ZONES.has(zone)) {
        openZoneInspector(player, zone);
        return;
      }
      if (EXPANDABLE_ZONES.has(zone) && !isZoneExpanded(player, zone)) {
        state.selected.clear();
        state.expandedZones.clear();
        state.expandedZones.add(zoneKey(player, zone));
        renderTable();
        return;
      }
      selectCard(node.dataset.uid, event.ctrlKey || event.metaKey);
    });
    node.addEventListener('contextmenu', (event) => { event.preventDefault(); showMenu(event, node.dataset.uid, Number(node.dataset.player), node.dataset.zone); });
    node.addEventListener('wheel', (event) => { event.preventDefault(); sendCommand({ command: event.deltaY < 0 ? 'tap' : 'tap', card_ids: [node.dataset.uid], value: event.deltaY < 0 }); }, { passive: false });
    node.addEventListener('pointerenter', () => { const item = findTableItem(Number(node.dataset.player), node.dataset.zone, node.dataset.uid); showPreview(item && stackVisualItem(item).card); });
    node.addEventListener('pointerleave', hidePreview);
    node.addEventListener('dragstart', (event) => { event.dataTransfer.setData('text/plain', node.dataset.uid); event.dataTransfer.effectAllowed = 'move'; });
    node.addEventListener('dragover', (event) => event.preventDefault());
    node.addEventListener('drop', (event) => { event.preventDefault(); event.stopPropagation(); const from = event.dataTransfer.getData('text/plain'); if (from && from !== node.dataset.uid) sendCommand({ command: 'swap', first: from, second: node.dataset.uid }); });
  });
  $$('.mana-orb').forEach((node) => {
    node.addEventListener('click', (event) => {
      event.stopPropagation();
      const player = Number(node.dataset.player);
      const item = findTableItem(player, 'mana', node.dataset.uid);
      if (item && stackCount(item)) openStackInspector(item, player);
      else toggleZone(node.closest('.zone'));
    });
    node.addEventListener('contextmenu', (event) => { event.preventDefault(); showMenu(event, node.dataset.uid, Number(node.dataset.player), node.dataset.zone); });
    node.addEventListener('wheel', (event) => {
      event.preventDefault();
      sendCommand({ command: 'tap', card_ids: [node.dataset.uid], value: event.deltaY < 0 });
    }, { passive: false });
  });
}

async function sendCommand(body) {
  if (!state.table) return;
  try {
    const data = await api(`/api/tables/${state.table.id}/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    state.table = data.table;
    if (body.command === 'move' && SPECIAL_ZONES.includes(body.zone)) state.hiddenZones.delete(body.zone);
    state.selected.clear();
    renderTable();
    if (data.deck_view) openInspector(data.deck_view, Number(body.player) === 1 ? '相手の山札を見る' : '山札を見る', Number(body.player) === 1 ? 1 : 0);
    if (data.error) notice(data.error);
  } catch (error) { notice(`操作に失敗しました: ${error.message}`); }
}

function openInspector(cards, title = '山札を見る', targetPlayer = 0) {
  state.inspectorSelected.clear();
  state.inspectorTargetPlayer = targetPlayer;
  $('#inspector-title').textContent = title;
  const node = $('#inspector-cards');
  node.innerHTML = cards.length ? cards.map((item) => `<button class="inspector-card" data-inspector-uid="${item.uid}">${item.card ? cardArt(item.card) + `<span class="card-name">${cardName(item.card)}</span>` : cardArt(null, true)}</button>`).join('') : '<p class="empty-state">このゾーンは空です。</p>';
  node.querySelectorAll('[data-inspector-uid]').forEach((button) => button.addEventListener('click', () => { const uid = button.dataset.inspectorUid; if (state.inspectorSelected.has(uid)) { state.inspectorSelected.delete(uid); button.classList.remove('selected'); } else { state.inspectorSelected.add(uid); button.classList.add('selected'); } }));
  $('#deck-inspector').classList.remove('hidden');
}

function openZoneInspector(playerIndex, zone) {
  const label = ZONE_VIEW_LABELS[zone] || 'ゾーン';
  openInspector(zoneItems(playerIndex, zone), `${label}を見る`, playerIndex);
}

function openStackInspector(item, playerIndex) {
  openInspector(stackDetailItems(item), '重なったカードを見る', playerIndex);
}

const DISPLAY_SETTINGS_KEY = 'dm-table-forge-display-settings';

function applyDisplaySettings() {
  const settings = state.displaySettings;
  settings.cardScale = Math.min(1.25, Math.max(0.9, Number(settings.cardScale) || 1.1));
  settings.cardHeightPercent = Math.min(100, Math.max(60, Number(settings.cardHeightPercent) || 100));
  settings.battleCardWidth = Math.min(0.8, Math.max(0.45, Number(settings.battleCardWidth) || 0.56));
  settings.labelPosition = ['corner', 'top'].includes(settings.labelPosition) ? settings.labelPosition : 'corner';
  settings.backStyle = ['dummy', 'pattern'].includes(settings.backStyle) ? settings.backStyle : 'dummy';
  settings.selfBattleSize = Math.min(360, Math.max(160, Number(settings.selfBattleSize) || 250));
  settings.opponentBattleSize = Math.min(330, Math.max(140, Number(settings.opponentBattleSize) || 220));
  settings.selfLowerSize = Math.min(260, Math.max(120, Number(settings.selfLowerSize) || 180));
  settings.opponentLowerSize = Math.min(200, Math.max(80, Number(settings.opponentLowerSize) || 125));
  document.documentElement.style.setProperty('--card-scale', String(settings.cardScale));
  document.documentElement.style.setProperty('--battle-card-width-ratio', String(settings.battleCardWidth));
  document.documentElement.style.setProperty('--self-battle-row', `${settings.selfBattleSize}fr`);
  document.documentElement.style.setProperty('--opponent-battle-row', `${settings.opponentBattleSize}fr`);
  document.documentElement.style.setProperty('--self-lower-row', `${settings.selfLowerSize}fr`);
  document.documentElement.style.setProperty('--opponent-lower-row', `${settings.opponentLowerSize}fr`);
  document.body.dataset.labelPosition = settings.labelPosition;
  document.body.dataset.backStyle = settings.backStyle;
  $('#card-scale').value = String(settings.cardScale);
  $('#card-scale-value').textContent = `${Math.round(settings.cardScale * 100)}%`;
  $('#card-height-percent').value = String(settings.cardHeightPercent);
  $('#card-height-percent-value').textContent = `${Math.round(settings.cardHeightPercent)}%`;
  $('#battle-card-width').value = String(settings.battleCardWidth);
  $('#battle-card-width-value').textContent = `${Math.round(settings.battleCardWidth * 100)}%`;
  $('#self-battle-size').value = String(settings.selfBattleSize);
  const selfTotal = settings.selfBattleSize + settings.selfLowerSize;
  const opponentTotal = settings.opponentBattleSize + settings.opponentLowerSize;
  $('#self-battle-size-value').textContent = `${Math.round(settings.selfBattleSize / selfTotal * 100)}%`;
  $('#opponent-battle-size').value = String(settings.opponentBattleSize);
  $('#opponent-battle-size-value').textContent = `${Math.round(settings.opponentBattleSize / opponentTotal * 100)}%`;
  $('#self-lower-size').value = String(settings.selfLowerSize);
  $('#self-lower-size-value').textContent = `${Math.round(settings.selfLowerSize / selfTotal * 100)}%`;
  $('#opponent-lower-size').value = String(settings.opponentLowerSize);
  $('#opponent-lower-size-value').textContent = `${Math.round(settings.opponentLowerSize / opponentTotal * 100)}%`;
  $('#label-position').value = settings.labelPosition;
  $('#back-style').value = settings.backStyle;
  fitGameField();
}

function loadDisplaySettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(DISPLAY_SETTINGS_KEY) || '{}');
    state.displaySettings = { ...state.displaySettings, ...saved };
  } catch (error) {
    // 壊れた保存値は初期値で表示する。
  }
  applyDisplaySettings();
}

function saveDisplaySettings() {
  try { localStorage.setItem(DISPLAY_SETTINGS_KEY, JSON.stringify(state.displaySettings)); } catch (error) { /* 保存できない環境でも動作させる */ }
}

function fitGameField() {
  if ($('#game-screen').classList.contains('hidden')) return;
  const width = Math.max(320, window.innerWidth - 24);
  const height = Math.max(260, window.innerHeight - 105);
  const designScale = state.displaySettings.cardScale / 1.1;
  const fit = Math.min(1, width / (1120 * designScale), height / (720 * designScale));
  document.documentElement.style.setProperty('--field-fit', Math.max(0.55, fit).toFixed(3));
  const battleHeights = $$('.self-battle-zone, .opponent-battle-zone').map((node) => node.clientHeight).filter(Boolean);
  const battleHeight = battleHeights.length ? Math.max(...battleHeights) : height * 0.25;
  const cardHeight = Math.max(54, Math.min(170, Math.round(battleHeight * 0.9 * designScale)));
  document.documentElement.style.setProperty('--card-art-height', `${cardHeight}px`);
  const selfBattleHeight = $('.self-battle-zone')?.clientHeight || battleHeight;
  const opponentBattleHeight = $('.opponent-battle-zone')?.clientHeight || battleHeight;
  document.documentElement.style.setProperty('--self-battle-art-height', `${Math.max(48, Math.round(selfBattleHeight * 0.9))}px`);
  document.documentElement.style.setProperty('--opponent-battle-art-height', `${Math.max(48, Math.round(opponentBattleHeight * 0.9))}px`);
  const selfShieldHeight = $('.self-primary-zones .shield-zone')?.clientHeight || cardHeight;
  const opponentShieldHeight = $('.opponent-primary-zones .shield-zone')?.clientHeight || cardHeight;
  document.documentElement.style.setProperty('--self-shield-art-height', `${Math.max(36, Math.round(selfShieldHeight * 0.9))}px`);
  document.documentElement.style.setProperty('--opponent-shield-art-height', `${Math.max(36, Math.round(opponentShieldHeight * 0.9))}px`);
  const selfHandHeight = $('.self-hand-zone')?.clientHeight || cardHeight;
  const opponentHandHeight = $('.opponent-hand-zone')?.clientHeight || cardHeight;
  const selfPrimaryHeight = $('.self-primary-zones')?.clientHeight || cardHeight;
  const opponentPrimaryHeight = $('.opponent-primary-zones')?.clientHeight || cardHeight;
  document.documentElement.style.setProperty('--self-hand-art-height', `${Math.max(36, Math.round(selfHandHeight * 0.9))}px`);
  document.documentElement.style.setProperty('--opponent-hand-art-height', `${Math.max(36, Math.round(opponentHandHeight * 0.9))}px`);
  document.documentElement.style.setProperty('--self-primary-art-height', `${Math.max(32, Math.round(selfPrimaryHeight * 0.9))}px`);
  document.documentElement.style.setProperty('--opponent-primary-art-height', `${Math.max(32, Math.round(opponentPrimaryHeight * 0.9))}px`);
  fitZoneCards();
}

function fitZoneCards() {
  const heightRatio = state.displaySettings.cardHeightPercent / 100;
  $$('.field-board .zone').forEach((zoneNode) => {
    const content = zoneNode.querySelector('.zone-content');
    const cards = Array.from(content?.querySelectorAll('.table-card') || []);
    if (!content || !cards.length) return;

    const style = window.getComputedStyle(content);
    const horizontalPadding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    const verticalPadding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    const gap = parseFloat(style.gap) || 4;
    const availableWidth = Math.max(20, content.clientWidth - horizontalPadding - 4);
    const availableHeight = Math.max(20, content.clientHeight - verticalPadding - 6);
    const canWrap = ['hand', 'shields', 'battle'].includes(zoneNode.dataset.zone) || zoneNode.classList.contains('expanded-zone');
    const maxRows = canWrap && cards.length > 1 ? 2 : 1;
    let bestHeight = 18;

    for (let rows = 1; rows <= maxRows; rows += 1) {
      const columns = Math.ceil(cards.length / rows);
      const heightLimit = (availableHeight - gap * (rows - 1)) / rows;
      const ratio = zoneNode.matches('.self-battle-zone, .opponent-battle-zone')
        ? (Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--battle-card-width-ratio')) || 0.56)
        : 0.56;
      const widthLimit = (availableWidth - gap * (columns - 1)) / columns / ratio;
      bestHeight = Math.max(bestHeight, Math.min(heightLimit * heightRatio, widthLimit));
    }

    zoneNode.style.setProperty('--zone-card-height', `${Math.max(18, Math.floor(bestHeight))}px`);
  });
}

let rangeSelection = null;

function updateRangeBox(event) {
  const box = $('#selection-box');
  const left = Math.min(rangeSelection.startX, event.clientX);
  const top = Math.min(rangeSelection.startY, event.clientY);
  const width = Math.abs(event.clientX - rangeSelection.startX);
  const height = Math.abs(event.clientY - rangeSelection.startY);
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
  box.style.width = `${width}px`;
  box.style.height = `${height}px`;
}

function updateRangeSelection(event) {
  const left = Math.min(rangeSelection.startX, event.clientX);
  const right = Math.max(rangeSelection.startX, event.clientX);
  const top = Math.min(rangeSelection.startY, event.clientY);
  const bottom = Math.max(rangeSelection.startY, event.clientY);
  $$('.table-card').forEach((node) => {
    const rect = node.getBoundingClientRect();
    const intersects = rect.right >= left && rect.left <= right && rect.bottom >= top && rect.top <= bottom;
    if (intersects) state.selected.add(node.dataset.uid); else state.selected.delete(node.dataset.uid);
    node.classList.toggle('selected', state.selected.has(node.dataset.uid));
  });
  $('#selection-count').textContent = `${state.selected.size}枚選択中`;
}

function beginRangeSelection(event) {
  if (event.button !== 0 || event.target.closest('.table-card, .mana-orb, .card-viewer, button, select, input, .zone-head')) return;
  rangeSelection = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, active: false };
  state.selected.clear();
  $('#selection-count').textContent = '0枚選択中';
  $('#field').setPointerCapture?.(event.pointerId);
}

function moveRangeSelection(event) {
  if (!rangeSelection || rangeSelection.pointerId !== event.pointerId) return;
  if (!rangeSelection.active && Math.hypot(event.clientX - rangeSelection.startX, event.clientY - rangeSelection.startY) < 5) return;
  rangeSelection.active = true;
  event.preventDefault();
  $('#selection-box').classList.remove('hidden');
  updateRangeBox(event);
  updateRangeSelection(event);
}

function endRangeSelection(event) {
  if (!rangeSelection || rangeSelection.pointerId !== event.pointerId) return;
  if (rangeSelection.active) event.preventDefault();
  $('#selection-box').classList.add('hidden');
  $('#field').releasePointerCapture?.(event.pointerId);
  rangeSelection = null;
}

function toggleZone(zoneNode) {
  hidePreview();
  const player = Number(zoneNode.dataset.player);
  const zone = zoneNode.dataset.zone;
  if (!EXPANDABLE_ZONES.has(zone)) {
    state.expandedZones.clear();
    renderTable();
    return;
  }
  const key = zoneKey(player, zone);
  if (state.expandedZones.has(key)) state.expandedZones.delete(key);
  else {
    state.expandedZones.clear();
    state.expandedZones.add(key);
  }
  renderTable();
}

function toggleFullScreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.(); else document.exitFullscreen?.();
}

$('#search').addEventListener('input', loadCards);
$('#civil-filter').addEventListener('change', loadCards);
$('#clear-deck').addEventListener('click', () => { state.deck = []; renderDeck(); });
$('#save-deck').addEventListener('click', saveDeckToServer);
$('#load-deck').addEventListener('click', loadSavedDecks);
$('#start-match').addEventListener('click', startTable);
$('#fullscreen').addEventListener('click', toggleFullScreen);
$('#back-setup').addEventListener('click', () => {
  closeHandWindow();
  $('#game-screen').classList.add('hidden');
  $('#game-screen').classList.remove('remote-mode');
  $('#hand-window-toggle').classList.add('hidden');
  $('#setup-screen').classList.remove('hidden');
});
$('#zones-toggle').addEventListener('click', () => $('#zone-settings').classList.toggle('hidden'));
$('#display-toggle').addEventListener('click', () => $('#display-settings').classList.toggle('hidden'));
$('#hand-window-toggle').addEventListener('click', openHandWindow);
$('#close-inspector').addEventListener('click', () => $('#deck-inspector').classList.add('hidden'));
$('#clear-selection').addEventListener('click', () => { state.selected.clear(); renderTable(); });

$('#card-scale').addEventListener('input', (event) => { state.displaySettings.cardScale = Number(event.target.value); applyDisplaySettings(); saveDisplaySettings(); });
$('#card-height-percent').addEventListener('input', (event) => { state.displaySettings.cardHeightPercent = Number(event.target.value); applyDisplaySettings(); saveDisplaySettings(); });
$('#battle-card-width').addEventListener('input', (event) => { state.displaySettings.battleCardWidth = Number(event.target.value); applyDisplaySettings(); saveDisplaySettings(); });
[['self-battle-size', 'selfBattleSize'], ['opponent-battle-size', 'opponentBattleSize'], ['self-lower-size', 'selfLowerSize'], ['opponent-lower-size', 'opponentLowerSize']].forEach(([id, key]) => {
  $(`#${id}`).addEventListener('input', (event) => { state.displaySettings[key] = Number(event.target.value); applyDisplaySettings(); saveDisplaySettings(); });
});
$('#label-position').addEventListener('change', (event) => { state.displaySettings.labelPosition = event.target.value; applyDisplaySettings(); saveDisplaySettings(); });
$('#back-style').addEventListener('change', (event) => { state.displaySettings.backStyle = event.target.value; applyDisplaySettings(); saveDisplaySettings(); });

$$('[data-action]').forEach((button) => button.addEventListener('click', () => {
  const command = button.dataset.action === 'face_up' || button.dataset.action === 'face_down' ? 'flip' : 'tap';
  sendCommand({ command, card_ids: Array.from(state.selected), value: button.dataset.action === 'tap' || button.dataset.action === 'face_up' });
}));

$$('[data-command]').forEach((button) => button.addEventListener('click', () => {
  state.expandedZones.clear();
  const command = button.dataset.command;
  if (command === 'view_deck') sendCommand({ command, player: Number(button.dataset.player), count: 40 });
  if (command === 'draw') sendCommand({ command, player: Number(button.dataset.player), count: 1 });
  if (command === 'shuffle_deck') sendCommand({ command, player: 0 });
}));

$$('.zone').forEach((node) => node.addEventListener('click', (event) => {
  if (event.target.closest('.table-card, .mana-orb, .zone-head button, .zone-action')) return;
  if (AUTO_INSPECT_ZONES.has(node.dataset.zone)) {
    openZoneInspector(Number(node.dataset.player), node.dataset.zone);
    return;
  }
  toggleZone(node);
}));
$('#field').addEventListener('dragover', (event) => { if (event.target.closest('.zone')) event.preventDefault(); });
$('#field').addEventListener('drop', (event) => {
  const zone = event.target.closest('.zone');
  if (!zone) return;
  event.preventDefault();
  const uid = event.dataTransfer.getData('text/plain');
  if (uid) sendCommand({ command: 'move', card_ids: [uid], zone: zone.dataset.zone, target_player: Number(zone.dataset.player) });
});
$$('[data-zone-toggle]').forEach((input) => input.addEventListener('change', () => { const zone = input.dataset.zoneToggle; if (input.checked) state.hiddenZones.delete(zone); else state.hiddenZones.add(zone); renderTable(); }));
$$('[data-inspector-move]').forEach((button) => button.addEventListener('click', () => { if (state.inspectorSelected.size) sendCommand({ command: 'move', card_ids: Array.from(state.inspectorSelected), zone: button.dataset.inspectorMove, position: button.dataset.position || 'append', target_player: state.inspectorTargetPlayer }); }));
$$('[data-inspector-position]').forEach((button) => button.addEventListener('click', () => { if (state.inspectorSelected.size) sendCommand({ command: 'move', card_ids: Array.from(state.inspectorSelected), zone: 'deck', position: button.dataset.inspectorPosition, target_player: state.inspectorTargetPlayer }); }));
$('[data-inspector-shuffle]').addEventListener('click', () => { if (state.inspectorSelected.size) sendCommand({ command: 'move', card_ids: Array.from(state.inspectorSelected), zone: 'deck', position: 'shuffle', target_player: state.inspectorTargetPlayer }); });

window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin || event.source !== state.handWindow) return;
  if (event.data?.type === 'dm-hand-window-ready') syncHandWindow();
  if (event.data?.type === 'dm-hand-command' && event.data.body) sendCommand(event.data.body);
});

document.addEventListener('click', (event) => { if (!event.target.closest('#context-menu') && !event.target.closest('.table-card')) $('#context-menu').classList.add('hidden'); });
$('#field').addEventListener('pointerdown', beginRangeSelection);
$('#field').addEventListener('pointermove', moveRangeSelection);
$('#field').addEventListener('pointerup', endRangeSelection);
$('#field').addEventListener('pointercancel', endRangeSelection);
window.addEventListener('resize', fitGameField);
document.addEventListener('fullscreenchange', fitGameField);
loadDisplaySettings();
loadMeta();
loadCards();
loadSavedDecks();
renderDeck();
window.setInterval(async () => {
  if (!state.table || document.hidden) return;
  try {
    const data = await api(`/api/tables/${state.table.id}`);
    if (tableStateChanged(data.table)) {
      state.table = data.table;
      renderTable();
    }
  } catch (error) {
    // 一時的な通信失敗は次回のポーリングで再試行する。
  }
}, 1000);
