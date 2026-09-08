const state = {
  cards: [],
  cardCache: new Map(),
  deck: [],
  specialDecks: { extra: [], gachi: [], battle: [] },
  deckTarget: 'deck',
  table: null,
  selected: new Set(),
  inspectorSelected: new Set(),
  inspectorItems: [],
  inspectorZone: '',
  inspectorTargetPlayer: 0,
  hiddenZones: new Set(),
  autoHiddenZones: new Set(),
  expandedZones: new Set(),
  mode: 'normal',
  handWindow: null,
  stackMode: null,
  displaySettings: {
    cardScale: 1.1,
    cardHeightPercent: 100,
    labelPosition: 'corner',
    backStyle: 'dummy',
    selfBattleSize: 250,
    opponentBattleSize: 220,
    selfPrimarySize: 68,
    selfHandSize: 65,
    selfManaSize: 47,
    opponentPrimarySize: 50,
    opponentHandSize: 44,
    opponentManaSize: 31,
    selfFieldSize: 100,
    opponentFieldSize: 100,
  },
};

const SPECIAL_ZONES = ['extra', 'gachi', 'abyss'];
const CARD_ASPECT_RATIO = 650 / 909;
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
  extra: ['サイキック'],
  gachi: ['GRクリーチャー'],
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
  const params = new URLSearchParams({ q: $('#search').value, civil: $('#civil-filter').value, section: state.deckTarget, limit: '80' });
  try {
    const data = await api(`/api/cards?${params.toString()}`);
    if (params.get('section') !== state.deckTarget || params.get('q') !== $('#search').value || params.get('civil') !== $('#civil-filter').value) return;
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
  const section = state.deckTarget;
  const home = state.cardCache.get(cardId)?.home_zone;
  if ((section === 'deck' && home) || (['extra', 'gachi'].includes(section) && home !== section)) {
    notice('カードの種類に合った追加先を選んでください。'); return;
  }
  const cards = deckSection(section);
  const limit = section === 'deck' ? 40 : $('#allow-size-exceptions').checked || section === 'battle' ? 200 : section === 'extra' ? 8 : 12;
  if (cards.length >= limit) { notice(`この枠は${limit}枚までです。`); return; }
  cards.push(cardId);
  renderDeck();
}

function deckSection(section) { return section === 'deck' ? state.deck : state.specialDecks[section]; }

function deckCountError() {
  if ($('#allow-size-exceptions').checked) return '';
  const starts = state.specialDecks.battle.map((id) => state.cardCache.get(id)?.home_zone);
  const extra = state.specialDecks.extra.length + starts.filter((zone) => zone === 'extra').length;
  const gr = state.specialDecks.gachi.length + starts.filter((zone) => zone === 'gachi').length;
  if (extra > 8) return '超次元は8枚以下にしてください（開始時バトル分を含む）。';
  if (gr && gr !== 12) return `ガチャレンジは12枚必要です。現在${gr}枚です（開始時バトル分を含む）。作成途中でも保存できます。`;
  return '';
}

function setDeckSection(section) {
  state.deckTarget = section;
  $('#deck-target').value = section;
  renderDeck();
  loadCards();
}

function renderDeck() {
  $('#deck-count').textContent = `${state.deck.length} / 40`;
  const hints = {
    deck: '通常の山札です。40枚未満の不足分は開始時に補充します。',
    gachi: '使用する場合は12枚。開始時にシャッフルして裏向きでガチャレンジゾーンに置きます。',
    extra: '基本8枚以下。選んだ面・並び順で超次元ゾーンに置きます。両面を別々に登録せず、1枚につき開始時の面を選んでください。',
    battle: '山札と別枠です。指定したカードを開始時からバトルゾーンに置きます。',
  };
  $('#deck-section-help').textContent = hints[state.deckTarget];
  for (const section of ['deck', 'gachi', 'extra', 'battle']) {
    const cards = deckSection(section);
    $(`[data-deck-count="${section}"]`).textContent = `${cards.length}${section === 'battle' ? '枚' : '/' + ({ deck: 40, gachi: 12, extra: 8 })[section]}`;
    $(`[data-deck-section="${section}"]`).setAttribute('aria-selected', String(section === state.deckTarget));
    const node = $(section === 'deck' ? '#deck-list' : `#${section}-deck-list`);
    node.className = `deck-list${section === state.deckTarget ? '' : ' hidden'}${cards.length ? '' : ' empty-state'}`;
    node.innerHTML = cards.length ? cards.map((id, index) => {
      const card = state.cardCache.get(id) || { cardname: '読み込み中' };
      return `<span class="deck-chip"><span>${index + 1}. ${cardName(card)}<br><small>${escapeHtml(card.packname || '')}</small></span><button data-remove-deck="${index}" aria-label="削除">×</button></span>`;
    }).join('') : 'カードライブラリからカードを追加してください。';
    node.querySelectorAll('[data-remove-deck]').forEach((button) => button.addEventListener('click', () => { cards.splice(Number(button.dataset.removeDeck), 1); renderDeck(); }));
  }
  const error = deckCountError();
  $('#deck-validation').textContent = error;
  $('#start-match').disabled = Boolean(error);
}

async function resolveDeckEntries(entries) {
  if (!Array.isArray(entries)) throw new Error('カード一覧が見つかりません。');
  const candidateIds = entries.map((entry) => (entry && typeof entry === 'object' ? entry.id : entry))
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0)
    .slice(0, 200);

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
  if (validCards.length !== entries.length) throw new Error('DBに存在しないカードIDが含まれています。');
  return validCards.map(({ id }) => id);
}

async function saveDeckToServer() {
  if (![state.deck, ...Object.values(state.specialDecks)].some((cards) => cards.length)) { notice('保存するカードがありません。'); return; }
  const fallbackName = `デッキ ${new Date().toLocaleString('ja-JP', { hour12: false })}`;
  const name = window.prompt('保存するデッキ名を入力してください。', fallbackName);
  if (name === null) return;
  try {
    const data = await api('/api/decks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), cards: state.deck, ...state.specialDecks, allow_size_exceptions: $('#allow-size-exceptions').checked }),
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
    const sections = await Promise.all(['cards', 'extra', 'gachi', 'battle'].map((key) => resolveDeckEntries(data.deck[key] || [])));
    state.deck = sections[0].filter((id) => !state.cardCache.get(id)?.home_zone);
    state.specialDecks = { extra: sections[1], gachi: sections[2], battle: sections[3] };
    for (const id of sections[0]) {
      const home = state.cardCache.get(id)?.home_zone;
      if (home) state.specialDecks[home].push(id);
    }
    $('#allow-size-exceptions').checked = data.deck.allow_size_exceptions === true;
    renderDeck();
    notice(`「${data.deck.name}」を読み込みました。`);
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
    node.innerHTML = data.decks.map((deck) => `<button class="saved-deck-item" data-saved-deck="${escapeHtml(deck.id)}"><span><strong>${escapeHtml(deck.name)}</strong><small>山札 ${deck.card_count} / GR ${deck.gachi_count || 0} / 超次元 ${deck.extra_count || 0} / 開始時 ${deck.battle_count || 0}${deck.saved_at ? ` / ${escapeHtml(new Date(deck.saved_at).toLocaleString('ja-JP'))}` : ''}</small></span><span class="saved-deck-open">開く</span></button>`).join('');
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
    table: state.table,
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
  const error = deckCountError();
  if (error) { notice(error); return; }
  state.mode = $('#play-mode').value === 'remote' ? 'remote' : 'normal';
  if (state.mode === 'remote') openHandWindow(); else closeHandWindow();
  try {
    const data = await api('/api/tables', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ player_name: 'プレイヤー', deck: state.deck, ...state.specialDecks, allow_size_exceptions: $('#allow-size-exceptions').checked }) });
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
    applyDisplaySettings();
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
    const visibleCount = group.querySelectorAll('.zone:not(.zone-hidden)').length;
    group.classList.toggle('all-hidden', !visibleCount);
    setLayoutProperty(group, '--visible-special-count', String(Math.max(1, visibleCount)));
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

function actionCardIds(item) {
  return item && stackCount(item) ? stackDetailItems(item).map((child) => child.uid) : [item?.uid];
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
  stackBridge.connect();
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
  $('[data-action="face_down"]').disabled = findGameItems(state.table, state.selected).some((item) => cardHomeZone(item) === 'extra');
  bindCardEvents();
  fitGameField();
  updateStackModeUI();
  syncHandWindow();
}

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

function stackSourcesExist(mode) {
  const player = state.table?.players?.[mode.player];
  const items = player ? [...Object.values(player.zones).flat(), ...player.shields] : [];
  return mode.cardIds.length > 0 && mode.cardIds.every((uid) => items.some((item) => item.uid === uid));
}

function isStackTarget(node) {
  const mode = state.stackMode;
  return Boolean(mode && Number(node.dataset.player) === mode.player &&
    ['battle', 'shields'].includes(node.dataset.zone) && !mode.cardIds.includes(node.dataset.uid) &&
    cardsCanMove(findGameItems(state.table, mode.cardIds), node.dataset.zone));
}

function updateStackModeUI() {
  const mode = state.stackMode;
  if (mode && !mode.busy && !stackSourcesExist(mode)) {
    endStackMode('重ねるカードが移動したため、重ねるモードを解除しました。');
    return;
  }
  const message = mode?.busy ? 'カードを重ねています…' :
    `${mode?.cardIds.length || 0}枚を対象の${mode?.position === 'below' ? '下' : '上'}へ。緑枠のバトル／シールドのカードを左クリックしてください。`;
  stackPanel.update(mode, message);
  $('#field').classList.toggle('stack-selecting', Boolean(mode));
  $$('.table-card').forEach((node) => {
    node.classList.toggle('stack-target', isStackTarget(node));
    node.classList.toggle('stack-source', Boolean(mode?.cardIds.includes(node.dataset.uid)));
  });
  $$('.zone').forEach((node) => node.classList.toggle('stack-target-zone', Boolean(mode &&
    Number(node.dataset.player) === mode.player && ['battle', 'shields'].includes(node.dataset.zone) &&
    cardsCanMove(findGameItems(state.table, mode.cardIds), node.dataset.zone))));
  fitZoneCards();
}

function publishStackMode(message = '') {
  const mode = state.stackMode;
  if (mode?.requestId) stackBridge.send({ type: 'status', requestId: mode.requestId,
    active: true, position: mode.position, busy: mode.busy, message });
}

function beginStackMode(cardIds, player = 0, requestId = null) {
  const mode = { cardIds: [...new Set(cardIds)], player, requestId, position: 'above', busy: false };
  if (!stackSourcesExist(mode)) {
    notice('同じプレイヤーのカードを選択してください。');
    return false;
  }
  if (state.stackMode?.busy) return false;
  if (state.stackMode) endStackMode();
  state.stackMode = mode;
  $('#context-menu').classList.add('hidden');
  $('#deck-inspector').classList.add('hidden');
  updateStackModeUI();
  publishStackMode();
  return true;
}

function setStackPosition(position) {
  if (!state.stackMode || state.stackMode.busy || !['above', 'below'].includes(position)) return;
  state.stackMode.position = position;
  updateStackModeUI();
  publishStackMode();
}

function endStackMode(message = '') {
  const mode = state.stackMode;
  if (!mode || mode.busy) return;
  state.stackMode = null;
  updateStackModeUI();
  if (mode.requestId) stackBridge.send({ type: 'status', requestId: mode.requestId, active: false, message });
  if (message) notice(message);
}

async function completeStackMode(node) {
  const mode = state.stackMode;
  if (!mode || mode.busy) return;
  if (!node || !isStackTarget(node)) {
    notice('緑枠のバトルゾーンまたはシールドゾーンのカードを左クリックしてください。');
    return;
  }
  mode.busy = true;
  updateStackModeUI();
  publishStackMode();
  const ok = await sendCommand({ command: 'stack', card_ids: mode.cardIds,
    target_id: node.dataset.uid, position: mode.position });
  mode.busy = false;
  if (ok) endStackMode(`${mode.cardIds.length}枚を対象カードの${mode.position === 'above' ? '上' : '下'}に重ねました。`);
  else {
    updateStackModeUI();
    publishStackMode('操作に失敗しました。対象を選び直すか、キャンセルしてください。');
  }
}

let pendingStackRequest = null;
async function receiveHandStackMode(message) {
  if (!message || state.mode !== 'remote' || !state.table || $('#game-screen').classList.contains('hidden')) return;
  if (message.type === 'cancel') {
    if (pendingStackRequest === message.requestId) pendingStackRequest = null;
    if (state.stackMode?.requestId === message.requestId) endStackMode();
    return;
  }
  if (message.type === 'position' && state.stackMode?.requestId === message.requestId) {
    setStackPosition(message.position);
    return;
  }
  if (message.type !== 'start' || !Array.isArray(message.cardIds) || !message.requestId) return;
  const tableId = state.table.id;
  pendingStackRequest = message.requestId;
  try {
    // The hand window may have drawn cards since the field's last poll.
    const data = await api(`/api/tables/${tableId}`);
    if (pendingStackRequest !== message.requestId || tableId !== state.table?.id) return;
    pendingStackRequest = null;
    state.table = data.table;
    renderTable();
    const hand = state.table.players[0].zones.hand;
    if (!message.cardIds.every((uid) => hand.some((item) => item.uid === uid)) ||
        !beginStackMode(message.cardIds, 0, message.requestId)) throw new Error('手札の選択を確認してください。');
  } catch (error) {
    if (tableId === state.table?.id) stackBridge.send({ type: 'status', requestId: message.requestId,
      active: false, message: `重ねるモードを開始できませんでした: ${error.message}` });
  }
}

const stackPanel = createStackModePanel($('#stack-mode-bar'), setStackPosition, () => endStackMode());
const stackBridge = createStackModeBridge('field', () => state.table?.id, () => state.handWindow, receiveHandStackMode);

function showMenu(event, uid, playerIndex = 0, zone = '') {
  if (!state.selected.has(uid)) selectCard(uid);
  const node = $('#context-menu');
  const inspectButton = INSPECTABLE_ZONES.has(zone) ? '<button data-menu-command="inspect-zone">内容を見る</button><div class="menu-separator"></div>' : '';
  node.innerHTML = `${inspectButton}<button data-menu-command="stack-details">カードを重ねる ▶</button><button data-menu-command="move" data-zone="hand">手札へ</button><button data-menu-command="move" data-zone="mana">マナへ</button><button data-menu-command="move" data-zone="mana" data-keep-face-down="true">裏向きのままマナへ</button><button data-menu-command="move" data-zone="graveyard">墓地へ</button><button data-menu-command="move" data-zone="battle">バトルゾーンへ</button><button data-menu-command="move" data-zone="shields">シールドゾーンへ</button><button data-menu-command="move" data-zone="shields" data-position="face_up">表向きでシールドゾーンへ</button>${specialZoneMenuMarkup("field-special-zones")}<div class="menu-separator"></div><button data-menu-command="move" data-zone="deck" data-position="top">山札の一番上へ</button><button data-menu-command="move" data-zone="deck" data-position="bottom">山札の一番下へ</button><button data-menu-command="move" data-zone="deck" data-position="shuffle">山札に加えてシャッフル</button><div class="menu-separator"></div><button data-menu-command="flip" data-value="true">表向きにする</button><button data-menu-command="flip" data-value="false">裏向きにする</button><button data-menu-command="tap" data-value="true">タップする</button><button data-menu-command="tap" data-value="false">アンタップする</button>`;
  positionContextMenu(node, event.clientX, event.clientY);
  bindSpecialZoneMenu(node, () => positionContextMenu(node, event.clientX, event.clientY));
  updateMoveButtons(node, findGameItems(state.table, state.selected));
  const clickedItem = findGameItems(state.table, [uid])[0];
  if (cardHomeZone(clickedItem) === 'extra') addTurnOverButton(node, clickedItem, event);
  node.querySelectorAll('[data-menu-command="flip"]').forEach((button) => {
    button.disabled = button.dataset.value === 'false' && findGameItems(state.table, state.selected).some((item) => cardHomeZone(item) === 'extra');
  });
  node.querySelectorAll('[data-menu-command]').forEach((button) => button.addEventListener('click', (clickEvent) => {
    clickEvent.stopPropagation();
    const command = button.dataset.menuCommand;
    if (command === 'inspect-zone') {
      node.classList.add('hidden');
      openZoneInspector(playerIndex, zone);
      return;
    }
    if (command === 'stack-details') {
      beginStackMode(Array.from(state.selected), playerIndex);
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
        openStackInspector(item, player, zone);
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
    node.addEventListener('wheel', (event) => {
      event.preventDefault();
      const player = Number(node.dataset.player);
      const item = findTableItem(player, node.dataset.zone, node.dataset.uid);
      sendCommand({ command: 'tap', card_ids: actionCardIds(item), value: event.deltaY < 0 });
    }, { passive: false });
    node.addEventListener('pointerenter', () => { const item = findTableItem(Number(node.dataset.player), node.dataset.zone, node.dataset.uid); showPreview(item && stackVisualItem(item).card); });
    node.addEventListener('pointerleave', hidePreview);
    node.addEventListener('dragstart', (event) => { event.dataTransfer.setData('text/plain', node.dataset.uid); event.dataTransfer.effectAllowed = 'move'; });
    node.addEventListener('drop', (event) => {
      event.preventDefault(); event.stopPropagation();
      const from = event.dataTransfer.getData('text/plain');
      if (!from || from === node.dataset.uid) return;
      const source = $(`.table-card[data-uid="${CSS.escape(from)}"]`);
      if (source?.dataset.zone === node.dataset.zone && source?.dataset.player === node.dataset.player) sendCommand({ command: 'swap', first: from, second: node.dataset.uid });
      else sendCommand({ command: 'move', card_ids: [from], zone: node.dataset.zone, target_player: Number(node.dataset.player) });
    });
  });
  $$('.mana-orb').forEach((node) => {
    node.addEventListener('click', (event) => {
      event.stopPropagation();
      const player = Number(node.dataset.player);
      const item = findTableItem(player, 'mana', node.dataset.uid);
      if (item && stackCount(item)) openStackInspector(item, player, 'mana');
      else toggleZone(node.closest('.zone'));
    });
    node.addEventListener('contextmenu', (event) => { event.preventDefault(); showMenu(event, node.dataset.uid, Number(node.dataset.player), node.dataset.zone); });
    node.addEventListener('wheel', (event) => {
      event.preventDefault();
      const player = Number(node.dataset.player);
      const item = findTableItem(player, 'mana', node.dataset.uid);
      sendCommand({ command: 'tap', card_ids: actionCardIds(item), value: event.deltaY < 0 });
    }, { passive: false });
  });
}

async function sendCommand(body) {
  if (!state.table) return false;
  if (body.command === 'move' && !cardsCanMove(findGameItems(state.table, body.card_ids || []), body.zone)) {
    notice('このカードはそのゾーンへ移動できません。');
    return false;
  }
  if (state.stackMode && body.command !== 'stack') {
    notice('重ねる操作を完了するか、キャンセルしてください。');
    return false;
  }
  try {
    const data = await api(`/api/tables/${state.table.id}/commands`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    state.table = data.table;
    if (body.command === 'move' && SPECIAL_ZONES.includes(body.zone)) state.hiddenZones.delete(body.zone);
    state.selected.clear();
    renderTable();
    if (data.deck_view) openInspector(data.deck_view, Number(body.player) === 1 ? '相手の山札を見る' : '山札を見る', Number(body.player) === 1 ? 1 : 0, 'deck');
    if (data.error) notice(data.error);
    if (body.inspectorAction && body.command === 'move') {
      const moved = new Set(body.card_ids || []);
      state.inspectorItems = state.inspectorItems.filter((item) => !moved.has(item.uid));
      state.inspectorSelected.clear();
      renderInspectorCards();
    }
    if (body.command === 'turn_over') {
      const updated = findGameItems(state.table, body.card_ids)[0];
      state.inspectorItems = state.inspectorItems.map((item) => item.uid === updated?.uid ? updated : item);
      if (!$('#deck-inspector').classList.contains('hidden')) renderInspectorCards();
      showPreview(updated?.card);
    }
    return true;
  } catch (error) { notice(`操作に失敗しました: ${error.message}`); return false; }
}

function allItemsInZone(playerIndex, zone) {
  const flatten = (items) => items.flatMap((item) => [item, ...flatten(stackParts(item).below), ...flatten(stackParts(item).above)]);
  return flatten(zoneItems(playerIndex, zone));
}

function inspectorCardIds() {
  const items = allItemsInZone(state.inspectorTargetPlayer, state.inspectorZone);
  const ids = [];
  for (const uid of state.inspectorSelected) {
    const item = items.find((candidate) => candidate.uid === uid);
    if (!item) continue;
    stackDetailItems(item).forEach((child) => { if (!ids.includes(child.uid)) ids.push(child.uid); });
  }
  return ids;
}

function renderInspectorCards() {
  const node = $('#inspector-cards');
  hidePreview();
  node.innerHTML = state.inspectorItems.length
    ? state.inspectorItems.map((item) => `<button class="inspector-card${state.inspectorSelected.has(item.uid) ? ' selected' : ''}" data-inspector-uid="${escapeHtml(item.uid)}">${item.card ? cardArt(item.card) + `<span class="card-name">${cardName(item.card)}</span>` : cardArt(null, true)}</button>`).join('')
    : '<p class="empty-state">このゾーンは空です。</p>';
  node.querySelectorAll('[data-inspector-uid]').forEach((button) => {
    const uid = button.dataset.inspectorUid;
    const preview = () => showPreview(state.inspectorItems.find((item) => item.uid === uid)?.card);
    button.setAttribute('aria-pressed', String(state.inspectorSelected.has(uid)));
    button.addEventListener('pointerenter', preview);
    button.addEventListener('focus', preview);
    button.addEventListener('click', () => {
      if (state.inspectorSelected.has(uid)) state.inspectorSelected.delete(uid); else state.inspectorSelected.add(uid);
      button.classList.toggle('selected', state.inspectorSelected.has(uid));
      button.setAttribute('aria-pressed', String(state.inspectorSelected.has(uid)));
      updateInspectorActions();
      preview();
    });
    button.addEventListener('contextmenu', (event) => {
      const item = state.inspectorItems.find((item) => item.uid === uid);
      if (cardHomeZone(item) !== 'extra') return;
      event.preventDefault();
      const menu = $('#context-menu');
      menu.innerHTML = '';
      addTurnOverButton(menu, item, event);
      positionContextMenu(menu, event.clientX, event.clientY);
    });
  });
  updateInspectorActions();
}

function updateInspectorActions() {
  updateMoveButtons($('#deck-inspector'), findGameItems(state.table, inspectorCardIds()));
}

function addTurnOverButton(menu, item, event) {
  const actions = item.card?.face_actions || { up: [], down: [] };
  const directional = [
    ['up', 'コストが大きい方へ裏返す'],
    ['down', 'コストが小さい方へ裏返す'],
  ];
  const options = item.card?.face_options || [];
  const addButton = (label, target, direction = '') => {
    const button = document.createElement('button');
    button.textContent = label;
    button.dataset.turnOver = item.uid;
    if (direction) button.dataset.turnDirection = direction;
    button.dataset.faceId = String(target.id);
    button.addEventListener('click', () => {
      menu.classList.add('hidden');
      sendCommand({ command: 'turn_over', card_ids: [item.uid], face_id: target.id, direction });
    });
    menu.append(button);
  };
  for (const [direction, label] of directional) {
    const targets = actions[direction] || [];
    if (targets.length === 1) addButton(`${label}（${targets[0].costtxt || ''}）`, targets[0], direction);
    else if (targets.length > 1) targets.forEach((target) => addButton(`${label}：${target.cardname}`, target, direction));
  }
  // Same-cost multi-face cards (サイキックリンクなど) have no cost direction.
  if (!directional.some(([direction]) => (actions[direction] || []).length)) {
    if (options.length === 1) addButton('裏返す', options[0]);
    else if (options.length > 1) options.forEach((target) => addButton(`裏返す：${target.cardname}`, target));
  }
  if (!menu.querySelector('[data-turn-over]')) {
    const button = document.createElement('button');
    button.textContent = '裏返す（候補なし）';
    button.disabled = true;
    menu.append(button);
  }
  positionContextMenu(menu, event.clientX, event.clientY);
}

function openInspector(cards, title = '山札を見る', targetPlayer = 0, sourceZone = '') {
  state.inspectorSelected.clear();
  state.inspectorItems = Array.isArray(cards) ? cards : [];
  state.inspectorTargetPlayer = targetPlayer;
  state.inspectorZone = sourceZone;
  $('#inspector-title').textContent = title;
  renderInspectorCards();
  $('#deck-inspector').classList.remove('hidden');
}

function openZoneInspector(playerIndex, zone) {
  const label = ZONE_VIEW_LABELS[zone] || 'ゾーン';
  openInspector(zoneItems(playerIndex, zone), `${label}を見る`, playerIndex, zone);
}

function openStackInspector(item, playerIndex, zone) {
  openInspector(stackDetailItems(item), '重なったカードを見る', playerIndex, zone);
}

const DISPLAY_SETTINGS_KEY = 'dm-table-forge-display-settings';
const ZONE_SIZE_DEFAULTS = {
  self: { battle: 250, primary: 68, hand: 65, mana: 47 },
  opponent: { battle: 220, primary: 50, hand: 44, mana: 31 },
};

function applyDisplaySettings() {
  const settings = state.displaySettings;
  settings.cardScale = Math.min(1.25, Math.max(0.9, Number(settings.cardScale) || 1.1));
  settings.cardHeightPercent = Math.min(100, Math.max(60, Number(settings.cardHeightPercent) || 100));
  settings.selfFieldSize = Math.min(190, Math.max(10, Number(settings.selfFieldSize) || 100));
  settings.opponentFieldSize = 200 - settings.selfFieldSize;
  settings.labelPosition = ['corner', 'top'].includes(settings.labelPosition) ? settings.labelPosition : 'corner';
  settings.backStyle = ['dummy', 'pattern'].includes(settings.backStyle) ? settings.backStyle : 'dummy';
  document.documentElement.style.setProperty('--card-scale', String(settings.cardScale));
  for (const [side, zones] of Object.entries(ZONE_SIZE_DEFAULTS)) {
    let total = 0;
    for (const [zone, fallback] of Object.entries(zones)) {
      const key = `${side}${zone[0].toUpperCase() + zone.slice(1)}Size`;
      settings[key] = Math.min(400, Math.max(1, Number(settings[key]) || fallback));
      const detachedHand = side === 'self' && zone === 'hand' && state.mode === 'remote';
      if (!detachedHand) total += settings[key];
      document.documentElement.style.setProperty(`--${side}-${zone}-row`, `${settings[key]}fr`);
      $(`#${side}-${zone}-size`).value = String(settings[key]);
      $(`#${side}-${zone}-size`).disabled = detachedHand;
    }
    document.documentElement.style.setProperty(`--${side}-lower-row`, `${total - settings[`${side}BattleSize`]}fr`);
    for (const zone of Object.keys(zones)) {
      const key = `${side}${zone[0].toUpperCase() + zone.slice(1)}Size`;
      $(`#${side}-${zone}-size-value`).textContent = side === 'self' && zone === 'hand' && state.mode === 'remote'
        ? '別窓' : `${Math.round(settings[key] / total * 100)}%`;
    }
  }
  document.documentElement.style.setProperty('--self-area-row', `${settings.selfFieldSize}fr`);
  document.documentElement.style.setProperty('--opponent-area-row', `${settings.opponentFieldSize}fr`);
  document.body.dataset.labelPosition = settings.labelPosition;
  document.body.dataset.backStyle = settings.backStyle;
  $('#card-scale').value = String(settings.cardScale);
  $('#card-scale-value').textContent = `${Math.round(settings.cardScale * 100)}%`;
  $('#card-height-percent').value = String(settings.cardHeightPercent);
  $('#card-height-percent-value').textContent = `${Math.round(settings.cardHeightPercent)}%`;
  $('#self-field-size').value = String(settings.selfFieldSize);
  $('#self-field-size-value').textContent = `${Math.round(settings.selfFieldSize)}%`;
  $('#opponent-field-size').value = String(settings.opponentFieldSize);
  $('#opponent-field-size-value').textContent = `${Math.round(settings.opponentFieldSize)}%`;
  $('#label-position').value = settings.labelPosition;
  $('#back-style').value = settings.backStyle;
  fitGameField();
}

function loadDisplaySettings() {
  try {
    const saved = JSON.parse(localStorage.getItem(DISPLAY_SETTINGS_KEY) || '{}');
    if (saved.layoutVersion !== 2) {
      // 旧版の補助ゾーン配分を各段へ分解し、以前の表示を引き継ぐ。
      for (const side of ['self', 'opponent']) {
        const lower = Number(saved[`${side}LowerSize`]);
        const ratios = side === 'self' ? { primary: 1.05, hand: 1, mana: .72 } : { primary: 1.15, hand: 1, mana: .72 };
        const total = Object.values(ratios).reduce((sum, value) => sum + value, 0);
        if (Number.isFinite(lower) && lower > 0) for (const [zone, ratio] of Object.entries(ratios)) {
          saved[`${side}${zone[0].toUpperCase() + zone.slice(1)}Size`] = lower * ratio / total;
        }
      }
      const self = Math.min(140, Math.max(60, Number(saved.selfFieldSize) || 100));
      const opponent = Math.min(140, Math.max(60, Number(saved.opponentFieldSize) || 100));
      saved.selfFieldSize = self / (self + opponent) * 200;
    }
    state.displaySettings = { ...state.displaySettings, ...saved };
    // 旧版の細いカード枠は引き継がず、実画像の縦横比を使用する。
    delete state.displaySettings.battleCardWidth;
    delete state.displaySettings.selfLowerSize;
    delete state.displaySettings.opponentLowerSize;
  } catch (error) {
    // 壊れた保存値は初期値で表示する。
  }
  state.displaySettings.layoutVersion = 2;
  applyDisplaySettings();
}

function saveDisplaySettings() {
  try { localStorage.setItem(DISPLAY_SETTINGS_KEY, JSON.stringify(state.displaySettings)); } catch (error) { /* 保存できない環境でも動作させる */ }
}

function fitGameField() {
  if ($('#game-screen').classList.contains('hidden')) return;
  // 詳細一覧の左端を実際のフィールドに合わせ、左の確認欄を空ける。
  setLayoutProperty(document.documentElement, '--inspector-left', `${$('.field-board').getBoundingClientRect().left}px`);
  fitZoneCards();
}

function setLayoutProperty(node, key, value) {
  if (node.style.getPropertyValue(key) !== value) node.style.setProperty(key, value);
}

function fitZoneCards() {
  const heightRatio = Math.min(1, state.displaySettings.cardHeightPercent / 100 * state.displaySettings.cardScale / 1.1);
  $$('.field-board .zone').forEach((zoneNode) => {
    const content = zoneNode.querySelector('.zone-content');
    const cards = Array.from(content?.querySelectorAll('.table-card') || []);
    if (!content) return;

    const style = window.getComputedStyle(content);
    const horizontalPadding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    const verticalPadding = (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0);
    const columnGap = parseFloat(style.columnGap) || 0;
    const rowGap = parseFloat(style.rowGap) || 0;
    const bounds = content.getBoundingClientRect();
    const availableWidth = bounds.width - horizontalPadding;
    const availableHeight = bounds.height - verticalPadding;
    if (availableWidth <= 0 || availableHeight <= 0) return;
    const orbs = content.querySelectorAll('.mana-orb');
    if (orbs.length) {
      const size = Math.max(0, Math.min(22 * state.displaySettings.cardScale, availableHeight, (availableWidth - columnGap * (orbs.length - 1)) / orbs.length));
      setLayoutProperty(zoneNode, '--mana-orb-size', `${size}px`);
    }
    if (!cards.length) return;
    const canWrap = ['hand', 'shields', 'battle'].includes(zoneNode.dataset.zone) || zoneNode.classList.contains('expanded-zone');
    const maxRows = canWrap && cards.length > 1 ? 2 : 1;
    const sizes = cards.map((card) => card.classList.contains('tapped')
      ? { width: 1, height: CARD_ASPECT_RATIO }
      : { width: CARD_ASPECT_RATIO, height: 1 });
    // CSSの折り返しと同じ順序で、タップ後の占有幅・高さも含めて収まりを調べる。
    const fits = (height) => {
      let rows = 1, width = 0, rowHeight = 0, totalHeight = 0;
      for (const size of sizes) {
        const cardWidth = height * size.width;
        if (cardWidth > availableWidth) return false;
        const gap = width ? columnGap : 0;
        if (width && width + gap + cardWidth > availableWidth) {
          totalHeight += rowHeight + rowGap;
          rows += 1;
          width = 0;
          rowHeight = 0;
        }
        width += (width ? columnGap : 0) + cardWidth;
        rowHeight = Math.max(rowHeight, height * size.height);
      }
      return rows <= maxRows && totalHeight + rowHeight <= availableHeight;
    };
    let low = 0;
    let high = availableHeight * heightRatio / Math.max(...sizes.map((size) => size.height));
    for (let step = 0; step < 24; step += 1) {
      const candidate = (low + high) / 2;
      if (fits(candidate)) low = candidate; else high = candidate;
    }
    // 少数ピクセルの丸めで余分な折り返しが発生しないよう、わずかに切り下げる。
    const height = Math.max(0, Math.floor((low - 0.1) * 100) / 100);
    setLayoutProperty(zoneNode, '--zone-card-height', `${height}px`);
    setLayoutProperty(zoneNode, '--zone-card-width', `${height * CARD_ASPECT_RATIO}px`);
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
  if (state.stackMode) return;
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
$('#clear-deck').addEventListener('click', () => { state.deck = []; state.specialDecks = { extra: [], gachi: [], battle: [] }; renderDeck(); });
$('#deck-target').addEventListener('change', (event) => setDeckSection(event.target.value));
$$('[data-deck-section]').forEach((button) => button.addEventListener('click', () => setDeckSection(button.dataset.deckSection)));
$('#allow-size-exceptions').addEventListener('change', renderDeck);
$('#save-deck').addEventListener('click', saveDeckToServer);
$('#load-deck').addEventListener('click', loadSavedDecks);
$('#start-match').addEventListener('click', startTable);
$('#fullscreen').addEventListener('click', toggleFullScreen);
$('#back-setup').addEventListener('click', () => {
  if (state.stackMode?.busy) return;
  pendingStackRequest = null;
  endStackMode();
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
for (const side of ['self', 'opponent']) {
  $(`#${side}-field-size`).addEventListener('input', (event) => {
    state.displaySettings.selfFieldSize = side === 'self' ? Number(event.target.value) : 200 - Number(event.target.value);
    applyDisplaySettings();
    saveDisplaySettings();
  });
  for (const zone of Object.keys(ZONE_SIZE_DEFAULTS[side])) {
    $(`#${side}-${zone}-size`).addEventListener('input', (event) => {
      state.displaySettings[`${side}${zone[0].toUpperCase() + zone.slice(1)}Size`] = Number(event.target.value);
      applyDisplaySettings();
      saveDisplaySettings();
    });
  }
}
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
$('#field').addEventListener('dragover', (event) => {
  const zone = event.target.closest('.zone');
  if (!zone) return;
  // A drag's payload is not readable during dragover; retain its UID from dragstart.
  const source = $('#field .drag-source');
  if (source && cardsCanMove(findGameItems(state.table, [source.dataset.uid]), zone.dataset.zone)) {
    event.preventDefault(); event.dataTransfer.dropEffect = 'move';
  } else event.dataTransfer.dropEffect = 'none';
});
$('#field').addEventListener('dragstart', (event) => event.target.closest('.table-card')?.classList.add('drag-source'));
$('#field').addEventListener('dragend', () => $$('.drag-source').forEach((node) => node.classList.remove('drag-source')));
$('#field').addEventListener('drop', (event) => {
  const zone = event.target.closest('.zone');
  if (!zone) return;
  event.preventDefault();
  const uid = event.dataTransfer.getData('text/plain');
  if (uid) sendCommand({ command: 'move', card_ids: [uid], zone: zone.dataset.zone, target_player: Number(zone.dataset.player) });
});
$$('[data-zone-toggle]').forEach((input) => input.addEventListener('change', () => { const zone = input.dataset.zoneToggle; if (input.checked) state.hiddenZones.delete(zone); else state.hiddenZones.add(zone); renderTable(); }));
function sendInspectorMove(body) {
  const cardIds = inspectorCardIds();
  if (cardIds.length) sendCommand({ ...body, card_ids: cardIds, inspectorAction: true });
}

$$('[data-inspector-move]').forEach((button) => button.addEventListener('click', () => {
  sendInspectorMove({ command: 'move', zone: button.dataset.inspectorMove, position: button.dataset.position || 'append', target_player: state.inspectorTargetPlayer });
}));
$$('[data-inspector-position]').forEach((button) => button.addEventListener('click', () => {
  sendInspectorMove({ command: 'move', zone: 'deck', position: button.dataset.inspectorPosition, target_player: state.inspectorTargetPlayer });
}));
$('[data-inspector-shuffle]').addEventListener('click', () => {
  sendInspectorMove({ command: 'move', zone: 'deck', position: 'shuffle', target_player: state.inspectorTargetPlayer });
});

window.addEventListener('message', (event) => {
  if (event.origin !== window.location.origin || event.source !== state.handWindow) return;
  if (event.data?.type === 'dm-hand-window-ready') syncHandWindow();
  if (event.data?.type === 'dm-hand-command' && event.data.body) sendCommand(event.data.body);
});

document.addEventListener('click', (event) => { if (!event.target.closest('#context-menu') && !event.target.closest('.table-card')) $('#context-menu').classList.add('hidden'); });
// Stop menu clicks before an outside-click handler can mistake a detached button for the page.
$('#context-menu').addEventListener('click', (event) => event.stopPropagation());
$('#field').addEventListener('click', (event) => {
  if (!state.stackMode) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  completeStackMode(event.target.closest('.table-card'));
}, true);
['contextmenu', 'dragstart', 'drop', 'wheel'].forEach((type) => $('#field').addEventListener(type, (event) => {
  if (!state.stackMode) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, { capture: true, passive: false }));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    $('#deck-inspector').classList.add('hidden');
    $('#context-menu').classList.add('hidden');
    endStackMode();
  }
});
$('#field').addEventListener('pointerdown', beginRangeSelection);
$('#field').addEventListener('pointermove', moveRangeSelection);
$('#field').addEventListener('pointerup', endRangeSelection);
$('#field').addEventListener('pointercancel', endRangeSelection);
window.addEventListener('resize', fitGameField);
document.addEventListener('fullscreenchange', fitGameField);
let fieldFitFrame = 0;
const fieldSizeObserver = new ResizeObserver(() => {
  if (fieldFitFrame) return;
  fieldFitFrame = requestAnimationFrame(() => { fieldFitFrame = 0; fitGameField(); });
});
$$('.field-board .zone').forEach((zone) => fieldSizeObserver.observe(zone));
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
