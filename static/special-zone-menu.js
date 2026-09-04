function specialZoneMenuMarkup(id) {
  return `<button type="button" data-special-zone-toggle aria-expanded="false" aria-controls="${id}">特殊ゾーンへ ▶</button>
    <div id="${id}" class="special-zone-options hidden" role="group" aria-label="特殊ゾーンへの移動">
      <button type="button" data-menu-command="move" data-zone="extra">超次元ゾーンへ</button>
      <button type="button" data-menu-command="move" data-zone="gachi">ガチャレンジゾーンへ</button>
      <button type="button" data-menu-command="move" data-zone="abyss">深淵ゾーンへ</button>
    </div>`;
}

function bindSpecialZoneMenu(menu, reposition) {
  const button = menu.querySelector('[data-special-zone-toggle]');
  const options = menu.querySelector('.special-zone-options');
  button.addEventListener('click', (event) => {
    // 同じDOM内で開閉する。外側のclick処理にメニューを閉じさせない。
    event.stopPropagation();
    const expanded = button.getAttribute('aria-expanded') !== 'true';
    button.setAttribute('aria-expanded', String(expanded));
    button.textContent = `特殊ゾーンへ ${expanded ? '▼' : '▶'}`;
    options.classList.toggle('hidden', !expanded);
    reposition();
    if (expanded) options.scrollIntoView({ block: 'nearest' });
  });
}
