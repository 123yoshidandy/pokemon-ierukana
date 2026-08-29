'use strict';

const GEN_NAMES = {
  1: 'カントー',
  2: 'ジョウト',
  3: 'ホウエン',
  4: 'シンオウ',
  5: 'イッシュ',
  6: 'カロス',
  7: 'アローラ',
  8: 'ガラル・ヒスイ',
  9: 'パルデア',
};
const SPRITE_URL = (no) => `https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon/${no}.png`;
const LS_PLAYER = 'ierukana.player';

const nameIndex = buildNameIndex(POKEDEX);
const byNo = new Map(POKEDEX.map((p) => [p.no, p]));

let serverAnswers = new Map(); // no -> {no, player, ts}
let revealRemaining = false;
let lastSyncError = null;

const els = {
  dex: document.getElementById('dex'),
  form: document.getElementById('answerForm'),
  input: document.getElementById('answerInput'),
  submitButton: document.getElementById('submitButton'),
  refreshButton: document.getElementById('refreshButton'),
  revealToggle: document.getElementById('revealToggle'),
  settingsButton: document.getElementById('settingsButton'),
  totalCount: document.getElementById('totalCount'),
  feedback: document.getElementById('feedback'),
  syncStatus: document.getElementById('syncStatus'),
  playerStats: document.getElementById('playerStats'),
  settingsDialog: document.getElementById('settingsDialog'),
  playerInput: document.getElementById('playerInput'),
  gasUrlInput: document.getElementById('gasUrlInput'),
  gasUrlNote: document.getElementById('gasUrlNote'),
  resetButton: document.getElementById('resetButton'),
};

const cards = new Map(); // no -> {root, body, key}
const genCounts = new Map(); // gen -> {el, total, done}

function getPlayer() {
  return (localStorage.getItem(LS_PLAYER) || '').trim();
}

// ---- 描画 ----

function buildGrid() {
  const frag = document.createDocumentFragment();
  let currentGen = 0;
  let gridEl = null;
  for (const p of POKEDEX) {
    if (p.gen !== currentGen) {
      currentGen = p.gen;
      const section = document.createElement('section');
      const h2 = document.createElement('h2');
      h2.textContent = `第${currentGen}世代 ${GEN_NAMES[currentGen] || ''}`;
      const count = document.createElement('span');
      count.className = 'gen-count';
      h2.appendChild(count);
      genCounts.set(currentGen, { el: count, total: 0, done: 0 });
      section.appendChild(h2);
      gridEl = document.createElement('div');
      gridEl.className = 'grid';
      section.appendChild(gridEl);
      frag.appendChild(section);
    }
    genCounts.get(p.gen).total += 1;

    const card = document.createElement('div');
    card.className = 'card hidden';
    const noEl = document.createElement('span');
    noEl.className = 'card-no';
    noEl.textContent = 'No.' + String(p.no).padStart(4, '0');
    const bodyEl = document.createElement('div');
    bodyEl.className = 'card-body';
    bodyEl.textContent = '???';
    card.append(noEl, bodyEl);
    gridEl.appendChild(card);
    cards.set(p.no, { root: card, body: bodyEl, key: 'hidden|' });
  }
  els.dex.appendChild(frag);
}

function renderCard(card, p, state, answer) {
  card.root.className = 'card ' + state;
  card.body.textContent = '';
  if (state === 'hidden') {
    card.body.textContent = '???';
    return;
  }
  if (state === 'revealed') {
    card.body.textContent = p.name;
    return;
  }
  const img = document.createElement('img');
  img.src = SPRITE_URL(p.no);
  img.alt = p.name;
  img.loading = 'lazy';
  img.width = 68;
  img.height = 68;
  const nameEl = document.createElement('div');
  nameEl.className = 'card-name';
  nameEl.textContent = p.name;
  const playerEl = document.createElement('div');
  playerEl.className = 'card-player';
  playerEl.textContent = state === 'pending' ? `${answer.player}（未同期）` : answer.player;
  card.body.append(img, nameEl, playerEl);
}

// サーバー状態 + 未送信キューを画面へ反映する
function applyState() {
  const pendingMap = new Map();
  for (const e of Api.pendingEntries()) {
    if (!serverAnswers.has(e.no)) pendingMap.set(e.no, { player: e.player, pending: true });
  }

  let total = 0;
  const perPlayer = new Map();
  for (const g of genCounts.values()) g.done = 0;

  for (const p of POKEDEX) {
    const answer = serverAnswers.get(p.no) || pendingMap.get(p.no) || null;
    if (answer) {
      total += 1;
      genCounts.get(p.gen).done += 1;
      perPlayer.set(answer.player, (perPlayer.get(answer.player) || 0) + 1);
    }
    const state = answer ? (answer.pending ? 'pending' : 'answered') : revealRemaining ? 'revealed' : 'hidden';
    const key = `${state}|${answer ? answer.player : ''}`;
    const card = cards.get(p.no);
    if (card.key === key) continue;
    card.key = key;
    renderCard(card, p, state, answer);
  }

  els.totalCount.textContent = total;
  for (const g of genCounts.values()) g.el.textContent = `${g.done} / ${g.total}`;
  renderPlayerStats(perPlayer);
  updateSyncStatus();
}

function renderPlayerStats(perPlayer) {
  if (!perPlayer.size) {
    els.playerStats.textContent = '';
    return;
  }
  const items = [...perPlayer.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${name}: ${n}匹`);
  els.playerStats.textContent = '貢献 — ' + items.join(' ／ ');
}

function updateSyncStatus() {
  const pending = Api.pendingEntries().length;
  const parts = [];
  parts.push(Api.isMock() ? '⚠ お試しモード（進捗はこの端末のブラウザ内にのみ保存）' : '☁ 共有シートに接続');
  if (pending) parts.push(`未同期 ${pending} 件（次の回答か「更新」で再送します）`);
  if (lastSyncError) parts.push(`同期エラー: ${lastSyncError}`);
  els.syncStatus.textContent = parts.join(' ／ ');
  els.syncStatus.classList.toggle('has-warning', Api.isMock() || pending > 0 || Boolean(lastSyncError));
}

function showFeedback(kind, message) {
  els.feedback.className = 'feedback ' + kind;
  els.feedback.textContent = message;
}

function setServerAnswers(list) {
  serverAnswers = new Map(list.map((a) => [a.no, a]));
}

function setBusy(busy) {
  els.submitButton.disabled = busy;
  els.refreshButton.disabled = busy;
}

// ---- 同期 ----

async function refresh() {
  setBusy(true);
  try {
    setServerAnswers(await Api.sync());
    lastSyncError = null;
  } catch (err) {
    lastSyncError = err.message || String(err);
  }
  setBusy(false);
  applyState();
}

// ---- イベント ----

els.form.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const raw = els.input.value.trim();
  if (!raw) return;

  const player = getPlayer();
  if (!player) {
    showFeedback('ng', '先にニックネームを設定してください');
    openSettings();
    return;
  }

  const no = nameIndex.get(normalizeName(raw));
  if (!no) {
    showFeedback('ng', `「${raw}」というポケモンは見つからない…`);
    els.input.select();
    return;
  }

  const answered = serverAnswers.get(no) || Api.pendingEntries().find((e) => e.no === no);
  if (answered) {
    showFeedback('dup', `${byNo.get(no).name} は ${answered.player} さんが回答済み！`);
    els.input.select();
    return;
  }

  els.input.value = '';
  showFeedback('ok', `No.${no} ${byNo.get(no).name} ゲット！`);
  const submitting = Api.submitAnswer(no, player); // この時点でキュー投入済み
  applyState(); // 通信を待たずに即時描画（pending 表示）
  try {
    setServerAnswers(await submitting);
    lastSyncError = null;
  } catch (err) {
    lastSyncError = err.message || String(err);
  }
  applyState();
  els.input.focus();
});

els.refreshButton.addEventListener('click', refresh);

els.revealToggle.addEventListener('change', () => {
  revealRemaining = els.revealToggle.checked;
  applyState();
});

els.settingsButton.addEventListener('click', () => openSettings());

function openSettings() {
  els.playerInput.value = getPlayer();
  if (Api.configGasUrl()) {
    // config.js で固定されている場合は変更させない
    els.gasUrlInput.value = Api.configGasUrl();
    els.gasUrlInput.disabled = true;
    els.gasUrlNote.textContent = '共有シートの URL は js/config.js で設定済みです。';
  } else {
    els.gasUrlInput.value = Api.storedGasUrl();
    els.gasUrlInput.disabled = false;
  }
  els.settingsDialog.showModal();
  if (!getPlayer()) els.playerInput.focus();
}

els.settingsDialog.addEventListener('close', () => {
  if (els.settingsDialog.returnValue !== 'save') return;
  const name = els.playerInput.value.trim();
  if (name) localStorage.setItem(LS_PLAYER, name);
  if (!els.gasUrlInput.disabled) Api.setGasUrl(els.gasUrlInput.value.trim());
  refresh();
});

els.resetButton.addEventListener('click', async () => {
  const target = Api.isMock() ? 'この端末の進捗' : '共有シートの全員の進捗';
  if (!confirm(`${target}をリセットして最初からやり直します。よろしいですか？`)) return;
  els.settingsDialog.close('cancel');
  setBusy(true);
  try {
    setServerAnswers(await Api.reset());
    lastSyncError = null;
    showFeedback('ok', 'リセットしました。あたらしい冒険のはじまり！');
  } catch (err) {
    lastSyncError = err.message || String(err);
  }
  setBusy(false);
  applyState();
});

// ---- 起動 ----

buildGrid();
applyState();
if (!getPlayer()) openSettings();
refresh();
