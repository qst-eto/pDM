// The origin is sent even for concealed cards, so their movement rules stay usable.
function cardHomeZone(item) { return item?.home_zone || item?.card?.home_zone || null; }

function cardTree(item) {
  return [item, ...(item.stack?.below || []).flatMap(cardTree), ...(item.stack?.above || []).flatMap(cardTree)];
}

function findGameItems(table, ids) {
  const wanted = new Set(ids);
  return (table?.players || []).flatMap((player) => [...Object.values(player.zones).flat(), ...(player.shields || [])])
    .flatMap(cardTree).filter((item) => wanted.has(item.uid));
}

function cardsCanMove(items, zone) {
  return items.length > 0 && items.flatMap(cardTree).every((item) => !cardHomeZone(item) || [cardHomeZone(item), 'battle', 'abyss'].includes(zone));
}

function updateMoveButtons(root, items) {
  root.querySelectorAll('button[data-zone], [data-inspector-move], [data-inspector-position], [data-inspector-shuffle]').forEach((button) => {
    const zone = button.dataset.zone || button.dataset.inspectorMove || 'deck';
    button.disabled = !cardsCanMove(items, zone);
    button.title = button.disabled && items.length ? 'このカードを移動できないゾーンです' : '';
  });
}
