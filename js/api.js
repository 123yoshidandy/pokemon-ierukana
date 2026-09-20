'use strict';

// 部屋機能より前から使っている共有シート（answers）を指す特別な部屋。全員が入室済み扱い
const DEFAULT_ROOM = '0000';

// 共有シート（GAS）との同期クライアント。部屋（room: 4 桁の文字列）単位で読み書きする。
const Api = (() => {
  // 未送信キューは部屋ごと。部屋 A でオフライン回答 → 部屋 B に切替 で B へ誤送信しないため
  const LS_QUEUE = 'ierukana.pendingQueue.'; // + 部屋 ID
  // 直近に同期した 1 部屋分 {room, answers}。次回起動時に通信を待たず描くため。
  // 部屋ごとには持たない（1 部屋 ≈ 60KB で localStorage を食う。切替時は必ず取得するので即描画が要るのは起動時だけ）
  const LS_ANSWERS = 'ierukana.answersCache';

  function gasUrl() {
    return (typeof CONFIG !== 'undefined' && CONFIG.GAS_URL ? CONFIG.GAS_URL : '').trim();
  }
  function hasUrl() {
    return Boolean(gasUrl());
  }
  function requireUrl() {
    if (!gasUrl()) throw new Error('共有シートの URL が未設定です（js/config.js の GAS_URL）');
  }

  function loadJson(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key)) ?? fallback;
    } catch {
      return fallback;
    }
  }

  // 部屋機能より前のキーは「みんなの部屋」のデータなので、部屋別キー／新形式へ 1 回だけ引き継ぐ
  try {
    const oldQueue = localStorage.getItem('ierukana.pendingQueue');
    if (oldQueue !== null) {
      localStorage.setItem(LS_QUEUE + DEFAULT_ROOM, oldQueue);
      localStorage.removeItem('ierukana.pendingQueue');
    }
    const oldCache = loadJson(LS_ANSWERS, null);
    if (Array.isArray(oldCache)) {
      localStorage.setItem(LS_ANSWERS, JSON.stringify({ room: DEFAULT_ROOM, answers: oldCache }));
    }
  } catch {
    // 保存できない環境でも起動は止めない（キャッシュ無しでも動く）
  }

  // --- 送信キュー: 通信失敗時もここに残り、次の同期で再送される ---
  function pendingEntries(room) {
    return loadJson(LS_QUEUE + room, []);
  }
  function saveQueue(room, queue) {
    localStorage.setItem(LS_QUEUE + room, JSON.stringify(queue));
  }
  function enqueue(room, entry) {
    const queue = pendingEntries(room);
    if (!queue.some((e) => e.no === entry.no)) {
      queue.push(entry);
      saveQueue(room, queue);
    }
  }

  // --- GAS 呼び出し ---
  async function gasPost(payload) {
    requireUrl();
    const res = await fetch(gasUrl(), {
      method: 'POST',
      // text/plain なら CORS プリフライトが発生しないため GAS でそのまま受けられる
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
    });
    return parseResponse(res);
  }
  async function gasGet(room) {
    requireUrl();
    const res = await fetch(`${gasUrl()}?room=${encodeURIComponent(room)}`);
    return parseResponse(res);
  }
  async function parseResponse(res) {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'サーバーエラー');
    // 全応答が room と answers を含むので、ここ 1 箇所で保存すれば漏れない。
    // 部屋 ID をサーバー応答から取るので、切替中に旧部屋の応答が遅れて届いても部屋と中身がずれない
    if (data.room && Array.isArray(data.answers)) {
      try {
        localStorage.setItem(LS_ANSWERS, JSON.stringify({ room: data.room, answers: data.answers }));
      } catch {
        // 容量超過などで保存できなくても同期自体は成功しているので無視する
      }
    }
    return data;
  }

  // 前回同期時の回答一覧。別の部屋のもの（や壊れたもの）なら空として扱い、次の同期で上書きされる
  function cachedAnswers(room) {
    const cache = loadJson(LS_ANSWERS, null);
    return cache && cache.room === room && Array.isArray(cache.answers) ? cache.answers : [];
  }

  // 同期リクエストを直列化する（連打しても同時に複数の通信を走らせない）
  let chain = Promise.resolve();
  function serialized(task) {
    const run = chain.then(task);
    chain = run.catch(() => {});
    return run;
  }

  // 部屋のキューを送信して最新の全回答を返す。送るものが無ければ null（通信なし）。
  // serialized() 内から呼ぶこと。
  async function sendQueue(room) {
    const queue = pendingEntries(room);
    if (!queue.length) return null;
    const data = await gasPost({ action: 'answer', room, entries: queue });
    // 送信できた分だけキューから消す（送信中に増えた分は残す）
    const sent = new Set(queue.map((e) => e.no));
    saveQueue(room, pendingEntries(room).filter((e) => !sent.has(e.no)));
    return data.answers;
  }

  // 手動更新・起動時・入室時: キューを送信し、無ければ取得のみ。
  // 部屋が存在しなければ「部屋 XXXX が見つかりません」で reject するので、入室時の存在確認も兼ねる
  function sync(room) {
    return serialized(async () => (await sendQueue(room)) ?? (await gasGet(room)).answers);
  }

  // 回答時: キューに積んで送信。通信に失敗してもキューに残るので消えない。
  // 先行リクエストがまとめて送信済みだった場合は通信せず null を返す。
  function submitAnswer(room, no, player) {
    enqueue(room, { no, player, ts: new Date().toISOString() });
    return serialized(() => sendQueue(room));
  }

  function reset(room) {
    return serialized(async () => {
      saveQueue(room, []);
      const data = await gasPost({ action: 'reset', room });
      return data.answers;
    });
  }

  // 新しい部屋を作り、発行された 4 桁 ID（文字列）を返す
  function createRoom() {
    return serialized(async () => (await gasPost({ action: 'create' })).room);
  }

  return {
    hasUrl,
    loadJson,
    pendingEntries,
    cachedAnswers,
    submitAnswer,
    sync,
    reset,
    createRoom,
  };
})();
