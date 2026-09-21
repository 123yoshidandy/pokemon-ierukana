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
const LS_ROOM = 'ierukana.room'; // 最後に遊んだ部屋 ID。起動時にこの部屋を開く
const LS_ROOMS = 'ierukana.rooms'; // 入室済みの部屋 [{id, players}]（最近遊んだ順）。切替 UI に出す

const nameIndex = buildNameIndex(POKEDEX);
const byNo = new Map(POKEDEX.map((p) => [p.no, p]));

let serverAnswers = new Map(); // no -> {no, player, ts}
let lastSyncError = null;
// 起動時の初回同期が終わるまで true。キャッシュ描画で生まれる画像リクエストが同期と回線を取り合わないようにする
let imgHold = false;

// 今いる部屋（4 桁の文字列。先頭 0 を保つため数値化しない）。DEFAULT_ROOM は api.js で定義
let currentRoom = localStorage.getItem(LS_ROOM) || DEFAULT_ROOM;
let rooms = Api.loadJson(LS_ROOMS, []);
if (!Array.isArray(rooms)) rooms = [];
if (!rooms.some((r) => r.id === DEFAULT_ROOM)) rooms.push({ id: DEFAULT_ROOM, players: [] }); // みんなの部屋は常に入室済み
// みんなの部屋は改名不可。以前のバージョンで付いた名前が残っていても捨てる
delete rooms.find((r) => r.id === DEFAULT_ROOM).name;
// 設定ダイアログを開いたときの部屋。入室・作成で閉じた後は currentRoom が変わるので、部屋名の保存先として覚えておく
let settingsRoom = null;

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
  roomBadge: document.getElementById('roomBadge'),
  roomForm: document.getElementById('roomForm'),
  roomList: document.getElementById('roomList'),
  roomInput: document.getElementById('roomInput'),
  joinRoomButton: document.getElementById('joinRoomButton'),
  createRoomButton: document.getElementById('createRoomButton'),
  roomMessage: document.getElementById('roomMessage'),
  roomNameInput: document.getElementById('roomNameInput'),
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

function roomName(id) {
  return id === DEFAULT_ROOM ? 'みんなの部屋' : `部屋 ${id}`;
}

// 部屋の表示名。自分で付けた名前があれば優先し、共有に使う ID を併記する（みんなの部屋は改名不可なので常に既定名）
function roomLabel(id) {
  const room = rooms.find((r) => r.id === id);
  if (id === DEFAULT_ROOM || !room || !room.name) return roomName(id);
  return `${room.name}（${id}）`;
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
  for (const e of Api.pendingEntries(currentRoom)) {
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
  saveRoomPlayers(perPlayer);
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
  for (const e of Api.pendingEntries(currentRoom)) {
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
    const pending = Api.pendingEntries(currentRoom).length;
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

// ---- 部屋 ----

function saveRooms() {
  localStorage.setItem(LS_ROOMS, JSON.stringify(rooms));
}

// 部屋一覧に回答者名（回答数の多い順に最大 5 名）を残し、切替 UI で「誰と遊んだ部屋か」を見せる
function saveRoomPlayers(perPlayer) {
  const room = rooms.find((r) => r.id === currentRoom);
  if (!room) return;
  // リセット直後などで回答が無いときは前回の名前を残す（誰と遊んだ部屋かは変わらない）
  if (perPlayer.size) {
    room.players = [...perPlayer.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name]) => name);
  }
  saveRooms();
}

function renderRoomBadge() {
  els.roomBadge.textContent = roomLabel(currentRoom);
}

// 入室済みの部屋を最近遊んだ順に並べる（今いる部屋は選べない）
function renderRoomList() {
  els.roomList.textContent = '';
  for (const r of rooms) {
    const current = r.id === currentRoom;
    const btn = document.createElement('button');
    btn.type = 'button'; // roomForm の submit（入室）と区別する
    btn.className = 'room-item' + (current ? ' current' : '');
    btn.disabled = current;
    btn.dataset.room = r.id;
    const id = document.createElement('span');
    id.className = 'room-item-id';
    id.textContent = roomLabel(r.id);
    const players = document.createElement('span');
    players.className = 'room-item-players';
    const names = (r.players || []).join('、') || 'まだ回答なし';
    players.textContent = current ? `${names}（今いる部屋）` : names;
    btn.append(id, players);
    const li = document.createElement('li');
    li.appendChild(btn);
    els.roomList.appendChild(li);
  }
}

// 部屋を切り替える。answers はその部屋の最新回答（入室時の取得結果。作成直後は空）
function enterRoom(id, answers) {
  currentRoom = id;
  localStorage.setItem(LS_ROOM, id);
  const known = rooms.find((r) => r.id === id) || { id, players: [] };
  rooms = [known, ...rooms.filter((r) => r !== known)]; // 最近遊んだ順に
  setServerAnswers(answers);
  lastSyncError = null;
  renderRoomBadge();
  applyState(); // 中の saveRoomPlayers が rooms を保存する
}

function setRoomMessage(text, isError) {
  els.roomMessage.textContent = text;
  els.roomMessage.classList.toggle('ng', Boolean(isError));
}

function setRoomBusy(busy) {
  els.joinRoomButton.disabled = busy;
  els.createRoomButton.disabled = busy;
  els.roomList.classList.toggle('busy', busy);
}

// 入室・作成の共通処理。成功したらダイアログを閉じて図鑑を新しい部屋に切り替える。
// 失敗はダイアログ内に出す（閉じてしまうと ID を打ち直せないため）
async function roomAction(task) {
  setRoomBusy(true);
  setRoomMessage('通信中…');
  try {
    const message = await task();
    setRoomMessage('');
    els.settingsDialog.close('room'); // 入力途中のニックネーム等も close ハンドラで保存される
    showFeedback('ok', message);
  } catch (err) {
    setRoomMessage(err.message || String(err), true);
  }
  setRoomBusy(false);
}

function joinRoom(id) {
  if (!/^\d{4}$/.test(id)) {
    setRoomMessage('部屋 ID は 4 桁の数字です', true);
    return;
  }
  // sync は部屋が無ければ reject するので存在確認を兼ねる。その部屋の未送信分があればここで送られる
  roomAction(async () => {
    enterRoom(id, await Api.sync(id));
    return `${roomLabel(id)} に入室しました`;
  });
}

function createRoom() {
  roomAction(async () => {
    const id = await Api.createRoom();
    enterRoom(id, []);
    return `部屋 ${id} を作りました。この番号を伝えると一緒に遊べます`;
  });
}

// ---- 同期 ----

// 部屋の通信結果を図鑑へ反映する。応答を待つ間に別の部屋へ切り替わっていたら旧部屋の結果なので捨てる。反映できたら true
async function applyResult(room, promise) {
  try {
    const answers = await promise;
    if (room !== currentRoom) return false;
    if (answers) setServerAnswers(answers); // null = 先行リクエストが送信済み（通信なし）
    lastSyncError = null;
    return true;
  } catch (err) {
    if (room === currentRoom) lastSyncError = err.message || String(err);
    return false;
  }
}

async function refresh() {
  const room = currentRoom;
  setBusy(true);
  await applyResult(room, Api.sync(room));
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

  const answered = serverAnswers.get(no) || Api.pendingEntries(currentRoom).find((e) => e.no === no);
  if (answered) {
    showFeedback('dup', `${byNo.get(no).name} は ${answered.player} さんが回答済み！`);
    els.input.select();
    return;
  }

  els.input.value = '';
  showFeedback('ok', `No.${no} ${byNo.get(no).name} ゲット！`);
  const room = currentRoom;
  const submitting = Api.submitAnswer(room, no, player); // この時点でキュー投入済み
  applyState(); // 通信を待たずに即時描画
  await applyResult(room, submitting);
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
  els.settingsDialog.returnValue = ''; // 前回の 'save'/'room' が残ると Esc で閉じても保存扱いになる
  els.playerInput.value = getPlayer();
  els.typeHintInput.checked = typeHint;
  settingsRoom = currentRoom;
  // みんなの部屋は改名不可: 欄は出したまま無効化し、欄の中で「変更不可」と示す
  const isShared = currentRoom === DEFAULT_ROOM;
  els.roomNameInput.disabled = isShared;
  els.roomNameInput.value = isShared
    ? 'みんなの部屋（変更不可）'
    : (rooms.find((r) => r.id === currentRoom) || {}).name || '';
  els.roomInput.value = '';
  setRoomMessage('');
  renderRoomList();
  els.settingsDialog.showModal();
  if (!getPlayer()) els.playerInput.focus();
}

els.settingsDialog.addEventListener('close', () => {
  const rv = els.settingsDialog.returnValue;
  // 'room' = 入室・作成で閉じた。入力途中のニックネームが消えないよう 'save' と同じく保存する
  if (rv !== 'save' && rv !== 'room') return;
  const name = els.playerInput.value.trim();
  if (name) localStorage.setItem(LS_PLAYER, name);
  typeHint = els.typeHintInput.checked;
  localStorage.setItem(LS_TYPE_HINT, typeHint ? '1' : '0');
  // 部屋の名前は設定を開いたときの部屋に付ける（入室・作成で閉じた場合は currentRoom が既に別の部屋）。みんなの部屋は対象外
  const named = settingsRoom !== DEFAULT_ROOM && rooms.find((r) => r.id === settingsRoom);
  if (named) {
    const roomNameValue = els.roomNameInput.value.trim();
    if (roomNameValue) named.name = roomNameValue;
    else delete named.name; // 空にしたら既定の表示（部屋 1234 / みんなの部屋）に戻る
    saveRooms();
    renderRoomBadge();
  }
  applyState(); // 通信を待たずヒント切替を即時反映（refresh 内の applyState はキー一致で no-op）
  if (rv === 'save') refresh(); // 入室直後は取得済みなので再同期しない
});

els.roomBadge.addEventListener('click', () => openSettings());

// 「入室」ボタンと ID 欄の Enter が同じ submit に集まる
els.roomForm.addEventListener('submit', (ev) => {
  ev.preventDefault();
  joinRoom(els.roomInput.value.trim());
});

els.createRoomButton.addEventListener('click', createRoom);

els.roomList.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-room]');
  if (btn) joinRoom(btn.dataset.room);
});

els.resetButton.addEventListener('click', async () => {
  const room = currentRoom;
  if (!confirm(`${roomLabel(room)} の全員の進捗をリセットして最初からやり直します。よろしいですか？`)) return;
  els.settingsDialog.close('cancel');
  setBusy(true);
  if (await applyResult(room, Api.reset(room))) {
    showFeedback('ok', 'リセットしました。あたらしい冒険のはじまり！');
  }
  setBusy(false);
  applyState();
});

// ---- 起動 ----

buildGrid();
renderRoomBadge();
if (!Api.hasUrl()) {
  // config.js が未設定のまま配布された場合は操作不能にしてエラーを出す
  els.input.disabled = true;
  setBusy(true);
  lastSyncError = '共有シートの URL が未設定です（js/config.js の GAS_URL を設定してください）';
  applyState();
} else {
  setServerAnswers(Api.cachedAnswers(currentRoom)); // 前回同期時の状態を先に描き、GAS の応答を待たせない
  imgHold = true; // applyState より前に立てる（キャッシュ分の画像を待機させるため）
  applyState();
  if (!getPlayer()) openSettings();
  refresh().then(releaseImages); // refresh はエラーを内部で捕捉するので必ず then に来る
}
