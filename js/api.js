'use strict';

// 共有シート（GAS）との同期クライアント。
const Api = (() => {
  const LS_QUEUE = 'ierukana.pendingQueue';

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

  // --- 送信キュー: 通信失敗時もここに残り、次の同期で再送される ---
  function pendingEntries() {
    return loadJson(LS_QUEUE, []);
  }
  function saveQueue(queue) {
    localStorage.setItem(LS_QUEUE, JSON.stringify(queue));
  }
  function enqueue(entry) {
    const queue = pendingEntries();
    if (!queue.some((e) => e.no === entry.no)) {
      queue.push(entry);
      saveQueue(queue);
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
  async function gasGet() {
    requireUrl();
    const res = await fetch(gasUrl());
    return parseResponse(res);
  }
  async function parseResponse(res) {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'サーバーエラー');
    return data;
  }

  // 同期リクエストを直列化する（連打しても同時に複数の通信を走らせない）
  let chain = Promise.resolve();
  function serialized(task) {
    const run = chain.then(task);
    chain = run.catch(() => {});
    return run;
  }

  // キューを送信して最新の全回答を返す。送るものが無ければ null（通信なし）。
  // serialized() 内から呼ぶこと。
  async function sendQueue() {
    const queue = pendingEntries();
    if (!queue.length) return null;
    const data = await gasPost({ action: 'answer', entries: queue });
    // 送信できた分だけキューから消す（送信中に増えた分は残す）
    const sent = new Set(queue.map((e) => e.no));
    saveQueue(pendingEntries().filter((e) => !sent.has(e.no)));
    return data.answers;
  }

  // 手動更新・起動時: キューを送信し、無ければ取得のみ。
  function sync() {
    return serialized(async () => (await sendQueue()) ?? (await gasGet()).answers);
  }

  // 回答時: キューに積んで送信。通信に失敗してもキューに残るので消えない。
  // 先行リクエストがまとめて送信済みだった場合は通信せず null を返す。
  function submitAnswer(no, player) {
    enqueue({ no, player, ts: new Date().toISOString() });
    return serialized(sendQueue);
  }

  function reset() {
    return serialized(async () => {
      saveQueue([]);
      const data = await gasPost({ action: 'reset' });
      return data.answers;
    });
  }

  return {
    hasUrl,
    pendingEntries,
    submitAnswer,
    sync,
    reset,
  };
})();
