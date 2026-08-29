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
const LS_CLOSED_GENS = 'ierukana.closedGens';

const nameIndex = buildNameIndex(POKEDEX);
const byNo = new Map(POKEDEX.map((p) => [p.no, p]));

let serverAnswers = new Map(); // no -> {no, player, ts}
let lastSyncError = null;

const els = {
  dex: document.getElementById('dex'),
  form: document.getElementById('answerForm'),
  input: document.getElementById('answerInput'),
  submitButton: document.getElementById('submitButton'),
  refreshButton: document.getElementById('refreshButton'),
  settingsButton: document.getElementById('settingsButton'),
  totalCount: document.getElementById('totalCount'),
  feedback: document.getElementById('feedback'),
  syncStatus: document.getElementById('syncStatus'),
  playerStats: document.getElementById('playerStats'),
  settingsDialog: document.getElementById('settingsDialog'),
  playerInput: document.getElementById('playerInput'),
  resetButton: document.getElementById('resetButton'),
};

const cards = new Map(); // no -> {root, body, key}
const genCounts = new Map(); // gen -> {el, total, done}

// 折りたたんだ世代の記憶（リロード後も維持）
let closedGens;
try {
  closedGens = new Set(JSON.parse(localStorage.getItem(LS_CLOSED_GENS) || '[]'));
} catch {
  closedGens = new Set();
}

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
      const gen = currentGen;
      const details = document.createElement('details');
      details.className = 'gen';
      details.open = !closedGens.has(gen);
      const summary = document.createElement('summary');
      const title = document.createElement('span');
      title.className = 'gen-title';
      title.textContent = `第${gen}世代 ${GEN_NAMES[gen] || ''}`;
      const count = document.createElement('span');
      count.className = 'gen-count';
      summary.append(title, count);
      genCounts.set(gen, { el: count, total: 0, done: 0 });
      details.appendChild(summary);
      gridEl = document.createElement('div');
      gridEl.className = 'grid';
      details.appendChild(gridEl);
      details.addEventListener('toggle', () => {
        if (details.open) closedGens.delete(gen);
        else closedGens.add(gen);
        localStorage.setItem(LS_CLOSED_GENS, JSON.stringify([...closedGens]));
      });
      frag.appendChild(details);
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
    const state = answer ? (answer.pending ? 'pending' : 'answered') : 'hidden';
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

// 通常時は何も表示せず、注意が必要なときだけ出す
function updateSyncStatus() {
  const pending = Api.pendingEntries().length;
  const parts = [];
  if (pending) parts.push(`未同期 ${pending} 件（次の回答か「更新」で再送します）`);
  if (lastSyncError) parts.push(`同期エラー: ${lastSyncError}`);
  els.syncStatus.textContent = parts.join(' ／ ');
  els.syncStatus.classList.toggle('has-warning', parts.length > 0);
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

els.settingsButton.addEventListener('click', () => openSettings());

function openSettings() {
  els.playerInput.value = getPlayer();
  els.settingsDialog.showModal();
  if (!getPlayer()) els.playerInput.focus();
}

els.settingsDialog.addEventListener('close', () => {
  if (els.settingsDialog.returnValue !== 'save') return;
  const name = els.playerInput.value.trim();
  if (name) localStorage.setItem(LS_PLAYER, name);
  refresh();
});

els.resetButton.addEventListener('click', async () => {
  if (!confirm('共有シートの全員の進捗をリセットして最初からやり直します。よろしいですか？')) return;
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
if (!Api.hasUrl()) {
  // config.js が未設定のまま配布された場合は操作不能にしてエラーを出す
  els.input.disabled = true;
  setBusy(true);
  lastSyncError = '共有シートの URL が未設定です（js/config.js の GAS_URL を設定してください）';
  applyState();
} else {
  applyState();
  if (!getPlayer()) openSettings();
  refresh();
}
