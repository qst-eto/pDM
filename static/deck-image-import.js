/* Image import keeps a draft until Apply; cancelling never changes the current deck. */
window.createDeckImageImporter = function ({ apply, notice }) {
  const dialog = document.querySelector('#deck-image-import');
  const $ = (selector) => dialog.querySelector(selector);
  const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  let generation = 0;
  let controller = null;
  let previewUrl = '';
  let draft = null;
  let choices = [];
  let reviewIndices = [];
  let cursor = 0;
  let applying = false;
  let searchVersion = 0;

  function message(text, error = false) {
    $('#import-status').textContent = text;
    $('#import-status').classList.toggle('import-error', error);
  }
  function close() {
    if (applying) return;
    generation += 1;
    searchVersion += 1;
    controller?.abort();
    controller = null;
    draft = null;
    choices = [];
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = '';
    $('#import-preview').removeAttribute('src');
    dialog.close();
  }
  function open() {
    generation += 1;
    dialog.querySelectorAll('button').forEach((button) => { button.disabled = false; });
    draft = null;
    choices = [];
    $('#import-file').value = '';
    $('#import-skip-review').checked = false;
    $('#import-mode').value = 'replace';
    $('#import-preview').classList.add('hidden');
    $('#import-upload').classList.remove('hidden');
    $('#import-review').classList.add('hidden');
    $('#import-analyze').disabled = false;
    $('#import-file').disabled = false;
    $('#import-mode').disabled = false;
    $('#import-skip-review').disabled = false;
    $('#close-deck-import').disabled = false;
    message('デッキ一覧の画像を選んでください。サムネイル1個を1枚として読み込みます。');
    dialog.showModal();
  }
  function selection(candidate, imageIndex = candidate.image_index) {
    return { id: Number(candidate.card.id), image_index: Number(imageIndex), card: candidate.card };
  }
  function recommended(row) {
    return row.candidates.length ? selection(row.candidates[0]) : null;
  }
  function renderCandidates(candidates, node, manual = false) {
    node.replaceChildren();
    for (const [rank, candidate] of candidates.entries()) {
      const card = candidate.card;
      const preferred = Number(candidate.image_index);
      const options = card.image_options?.length ? card.image_options : [{ index: preferred, image_url: card.image_url }];
      const best = options.find((option) => Number(option.index) === preferred) || options[0];
      const section = document.createElement('article');
      section.className = 'import-candidate';
      const selected = choices[reviewIndices[cursor]];
      const current = selected?.id === Number(card.id) && selected?.image_index === Number(best.index);
      section.innerHTML = `<button type="button" class="import-choice${current ? ' selected' : ''}" data-import-card="${card.id}" data-import-image="${best.index}" aria-label="${escape(card.cardname)}・画像${Number(best.index) + 1}を選択">
        <span class="import-candidate-rank">${manual ? '検索結果' : `候補 ${rank + 1} · 類似度 ${candidate.score.toFixed(3)}`}</span>
        <img src="${escape(best.image_url)}" alt="${escape(card.cardname)}" loading="lazy">
        <strong>${escape(card.cardname)}</strong><small>画像 ${Number(best.index) + 1}</small></button>`;
      section.querySelector('button').addEventListener('click', () => choose(candidate, Number(best.index)));
      if (options.length > 1) {
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = `同じカードの別画像（${options.length}種）`;
        details.append(summary);
        const variants = document.createElement('div');
        variants.className = 'import-variants';
        for (const option of options) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className = 'import-variant';
          button.dataset.importCard = String(card.id);
          button.dataset.importImage = String(option.index);
          button.setAttribute('aria-label', `${card.cardname}・画像${Number(option.index) + 1}を選択`);
          button.innerHTML = `<img loading="lazy" src="${escape(option.image_url)}" alt=""><span>画像 ${Number(option.index) + 1}</span>`;
          button.addEventListener('click', () => choose(candidate, Number(option.index)));
          variants.append(button);
        }
        details.append(variants);
        section.append(details);
      }
      node.append(section);
    }
  }
  function renderReview() {
    searchVersion += 1;
    $('#import-search-results').replaceChildren();
    $('#import-card-search').value = '';
    const remaining = choices.filter((choice) => choice === undefined).length;
    const count = choices.filter(Boolean).length;
    const index = reviewIndices[cursor];
    const row = draft.cards[index];
    $('#import-progress').textContent = `${draft.detected_count}枚を検出 · 未確認 ${remaining}枚 · 反映予定 ${count}枚`;
    $('#import-position').textContent = `確認 ${cursor + 1} / ${reviewIndices.length}（画像内の ${row.position} 枚目）`;
    $('#import-crop').src = row.crop_url;
    $('#import-reason').textContent = row.reason;
    $('#import-previous').disabled = cursor === 0;
    $('#import-next').disabled = cursor >= reviewIndices.length - 1;
    $('#import-apply').disabled = remaining > 0;
    $('#import-apply').textContent = `選択した${count}枚をデッキに反映`;
    renderCandidates(row.candidates, $('#import-candidates'));
    message(remaining ? '入力画像と見比べて、使うカードの画像を選択してください。類似度は正解確率ではありません。' :
      `確認が完了しました。${choices.filter((c) => c === null).length}領域を除外し、${count}枚を反映します。`);
  }
  function choose(candidate, index) {
    if (applying) return;
    choices[reviewIndices[cursor]] = selection(candidate, index);
    advance();
  }
  function advance() {
    const next = reviewIndices.findIndex((index) => choices[index] === undefined);
    if (next >= 0) cursor = next;
    renderReview();
    if (next < 0) $('#import-apply').focus();
  }
  async function commit() {
    if (applying || !draft) return;
    if (choices.some((choice) => choice === undefined)) return;
    const selected = choices.filter(Boolean);
    if (!selected.length) { message('反映するカードがありません。候補を選ぶか、閉じて画像を選び直してください。', true); return; }
    applying = true;
    dialog.querySelectorAll('button').forEach((button) => { button.disabled = true; });
    message('選んだカードをデッキに反映しています…');
    try {
      await apply(selected, $('#import-mode').value);
      const omitted = choices.filter((choice) => choice === null).length;
      applying = false;
      close();
      notice(`${selected.length}枚を画像から読み込みました。${omitted ? ` ${omitted}領域を除外しました。` : ''}通常通り編集・保存・対戦を開始できます。`);
    } catch (error) {
      applying = false;
      dialog.querySelectorAll('button').forEach((button) => { button.disabled = false; });
      // An automatic import that cannot fit still offers individual edits/exclusions.
      reviewIndices = draft.cards.map((_, index) => index);
      $('#import-upload').classList.add('hidden');
      $('#import-review').classList.remove('hidden');
      renderReview();
      message(error.message, true);
    }
  }
  async function analyze() {
    const file = $('#import-file').files[0];
    if (!file) { message('画像ファイルを選択してください。', true); return; }
    if (!file.size || file.size > 20 * 1024 * 1024) { message('画像は20MB以下のファイルを選んでください。', true); return; }
    const version = ++generation;
    controller?.abort();
    controller = new AbortController();
    $('#import-analyze').disabled = true;
    $('#import-file').disabled = true;
    $('#import-mode').disabled = true;
    $('#import-skip-review').disabled = true;
    message('カードを解析しています… 初回は参照画像の準備に時間がかかります。');
    try {
      const response = await fetch('/api/deck-imports', { method: 'POST', body: file,
        headers: { 'Content-Type': file.type || 'application/octet-stream' }, signal: controller.signal });
      const data = await response.json();
      if (version !== generation) return;
      if (!response.ok) throw new Error(data.error || '画像解析に失敗しました。');
      if (!data.cards?.length) throw new Error('カードが見つかりませんでした。');
      draft = data;
      choices = data.cards.map((row) => row.requires_review ? undefined : recommended(row));
      reviewIndices = data.cards.map((_, index) => index).filter((index) => choices[index] === undefined);
      cursor = 0;
      if ($('#import-skip-review').checked || !reviewIndices.length) {
        choices = data.cards.map(recommended);
        await commit();
      } else {
        $('#import-upload').classList.add('hidden');
        $('#import-review').classList.remove('hidden');
        renderReview();
        $('#import-candidates button')?.focus();
      }
    } catch (error) {
      if (version !== generation || error.name === 'AbortError') return;
      message(error.message, true);
    } finally {
      if (version === generation) {
        $('#import-analyze').disabled = false;
        $('#import-file').disabled = false;
        if (!draft) { $('#import-mode').disabled = false; $('#import-skip-review').disabled = false; }
      }
    }
  }
  async function search(event) {
    event.preventDefault();
    if (!draft || applying) return;
    const text = $('#import-card-search').value.trim();
    if (!text) return;
    const version = ++searchVersion;
    $('#import-search-results').textContent = '検索しています…';
    try {
      const response = await fetch(`/api/cards?q=${encodeURIComponent(text)}&limit=30`);
      const data = await response.json();
      if (version !== searchVersion || !dialog.open) return;
      if (!response.ok) throw new Error(data.error || '検索に失敗しました。');
      if (!data.cards.length) { $('#import-search-results').textContent = '該当カードがありません。別のカード名で検索してください。'; return; }
      renderCandidates(data.cards.map((card) => ({ card, image_index: card.image_index || 0 })), $('#import-search-results'), true);
    } catch (error) {
      if (version === searchVersion) $('#import-search-results').textContent = error.message;
    }
  }
  $('#import-file').addEventListener('change', () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    const file = $('#import-file').files[0];
    previewUrl = file ? URL.createObjectURL(file) : '';
    $('#import-preview').src = previewUrl;
    $('#import-preview').classList.toggle('hidden', !file);
  });
  $('#import-analyze').addEventListener('click', analyze);
  $('#close-deck-import').addEventListener('click', close);
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
  $('#import-previous').addEventListener('click', () => { if (cursor > 0) { cursor -= 1; renderReview(); } });
  $('#import-next').addEventListener('click', () => { if (cursor < reviewIndices.length - 1) { cursor += 1; renderReview(); } });
  $('#import-exclude').addEventListener('click', () => { choices[reviewIndices[cursor]] = null; advance(); });
  $('#import-apply').addEventListener('click', commit);
  $('#import-accept-all').addEventListener('click', () => {
    choices = draft.cards.map((row, index) => choices[index] === undefined ? recommended(row) : choices[index]);
    commit();
  });
  $('#import-search-form').addEventListener('submit', search);
  return { open };
};
