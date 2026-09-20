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
const LS_TYPE_HINT = 'ierukana.typeHint';

const nameIndex = buildNameIndex(POKEDEX);
const byNo = new Map(POKEDEX.map((p) => [p.no, p]));

let serverAnswers = new Map(); // no -> {no, player, ts}
let lastSyncError = null;
// 起動時の初回同期が終わるまで true。キャッシュ描画で生まれる画像リクエストが同期と回線を取り合わないようにする
let imgHold = false;

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
  typeHintInput: document.getElementById('typeHintInput'),
  historyDialog: document.getElementById('historyDialog'),
  historyList: document.getElementById('historyList'),
  historyNote: document.getElementById('historyNote'),
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

// タイプヒント（未回答マスにタイプを出す）の端末ごとの設定。未設定は OFF
let typeHint = localStorage.getItem(LS_TYPE_HINT) === '1';

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
    card.append(noEl, bodyEl);
    gridEl.appendChild(card);
    cards.set(p.no, { root: card, body: bodyEl, key: '' }); // 空キー: 初回 applyState で必ず描く
  }
  els.dex.appendChild(frag);
}

function renderCard(card, p, state, answer) {
  card.root.className = 'card ' + state;
  card.body.textContent = '';
  if (state === 'hidden') {
    card.body.textContent = '???';
    // 古い pokedex.js がキャッシュされていて types が無い場合は ??? だけにする
    if (typeHint && p.types?.length) {
      const typesEl = document.createElement('div');
      typesEl.className = 'card-types';
      typesEl.textContent = p.types.join(' / ');
      card.body.append(typesEl);
    }
    return;
  }
  const img = document.createElement('img');
  // 待機中は src を付けず data-src に持たせ、初回同期後に releaseImages() でまとめて付ける
  if (imgHold) img.dataset.src = SPRITE_URL(p.no);
  else img.src = SPRITE_URL(p.no);
  img.alt = p.name;
  img.loading = 'lazy';
  img.width = 68;
  img.height = 68;
  const nameEl = document.createElement('div');
  nameEl.className = 'card-name';
  nameEl.textContent = p.name;
  const playerEl = document.createElement('div');
  playerEl.className = 'card-player';
  playerEl.textContent = answer.player;
  card.body.append(img, nameEl, playerEl);
}

// サーバー状態 + 未送信キューを画面へ反映する
function applyState() {
  // 送信前の回答も確定済みと同じ見た目で描く（サーバー確定時の描き直しをなくす）
  const pendingMap = new Map();
  for (const e of Api.pendingEntries()) {
    if (!serverAnswers.has(e.no)) pendingMap.set(e.no, { player: e.player });
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
    const state = answer ? 'answered' : 'hidden';
    // 描画内容を決める要素だけをキーにする（回答済み: 回答者名、未回答: ヒント表示の有無）
    const key = answer ? `answered|${answer.player}` : `hidden|${typeHint}`;
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

// 人ごとの集計を「履歴」への入り口を兼ねた行として描く（クリックで履歴ダイアログ）
function renderPlayerStats(perPlayer) {
  els.playerStats.hidden = !perPlayer.size;
  if (!perPlayer.size) return;
  const items = [...perPlayer.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, n]) => `${name}: ${n}匹`);
  const label = document.createElement('span');
  label.className = 'player-stats-label';
  label.textContent = '履歴';
  els.playerStats.textContent = '';
  els.playerStats.append(label, ' — ' + items.join(' ／ '));
}

const HISTORY_LIMIT = 50;

// 「M/D HH:MM」形式（当日分も日付付き）
function formatHistoryTime(ts) {
  const d = new Date(ts);
  if (isNaN(d)) return '';
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

function renderHistory() {
  // applyState と同様に、未送信キューの回答も確定分に重ねて表示する
  const merged = new Map(serverAnswers);
  for (const e of Api.pendingEntries()) {
    if (!merged.has(e.no)) merged.set(e.no, e);
  }
  const entries = [...merged.values()].sort((a, b) => new Date(b.ts) - new Date(a.ts));

  els.historyList.textContent = '';
  for (const a of entries.slice(0, HISTORY_LIMIT)) {
    const li = document.createElement('li');
    const time = document.createElement('span');
    time.className = 'history-time';
    time.textContent = formatHistoryTime(a.ts);
    const name = document.createElement('span');
    name.className = 'history-name';
    name.textContent = byNo.has(a.no) ? byNo.get(a.no).name : 'No.' + a.no;
    const player = document.createElement('span');
    player.className = 'history-player';
    player.textContent = a.player;
    li.append(time, name, player);
    els.historyList.appendChild(li);
  }

  if (!entries.length) {
    els.historyNote.textContent = 'まだ回答がありません';
  } else if (entries.length > HISTORY_LIMIT) {
    els.historyNote.textContent = `全${entries.length}件のうち直近${HISTORY_LIMIT}件を表示しています`;
  } else {
    els.historyNote.textContent = '';
  }
}

// 通常時は何も表示せず、同期エラーが起きているときだけ出す
// （正常な送信中の回答は表示しない。失敗してキューに残ったときだけ知らせる）
function updateSyncStatus() {
  const parts = [];
  if (lastSyncError) {
    parts.push(`同期エラー: ${lastSyncError}`);
    const pending = Api.pendingEntries().length;
    if (pending) parts.push(`未送信 ${pending} 件は次の回答か「更新」で自動再送します`);
  }
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

// 初回同期の完了後に、待たせていた画像の読み込みを始める（以降に描くカードは即 src が付く）
function releaseImages() {
  imgHold = false;
  for (const img of document.querySelectorAll('.card img[data-src]')) {
    img.src = img.dataset.src;
    delete img.dataset.src;
  }
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
  applyState(); // 通信を待たずに即時描画
  try {
    const answers = await submitting;
    if (answers) setServerAnswers(answers); // null = 先行リクエストが送信済み（通信なし）
    lastSyncError = null;
  } catch (err) {
    lastSyncError = err.message || String(err);
  }
  applyState();
  els.input.focus();
});

els.refreshButton.addEventListener('click', refresh);

els.playerStats.addEventListener('click', () => {
  renderHistory();
  els.historyDialog.showModal();
});

els.settingsButton.addEventListener('click', () => openSettings());

function openSettings() {
  els.playerInput.value = getPlayer();
  els.typeHintInput.checked = typeHint;
  els.settingsDialog.showModal();
  if (!getPlayer()) els.playerInput.focus();
}

els.settingsDialog.addEventListener('close', () => {
  if (els.settingsDialog.returnValue !== 'save') return;
  const name = els.playerInput.value.trim();
  if (name) localStorage.setItem(LS_PLAYER, name);
  typeHint = els.typeHintInput.checked;
  localStorage.setItem(LS_TYPE_HINT, typeHint ? '1' : '0');
  applyState(); // 通信を待たずヒント切替を即時反映（refresh 内の applyState はキー一致で no-op）
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
  setServerAnswers(Api.cachedAnswers()); // 前回同期時の状態を先に描き、GAS の応答を待たせない
  imgHold = true; // applyState より前に立てる（キャッシュ分の画像を待機させるため）
  applyState();
  if (!getPlayer()) openSettings();
  refresh().then(releaseImages); // refresh はエラーを内部で捕捉するので必ず then に来る
}
