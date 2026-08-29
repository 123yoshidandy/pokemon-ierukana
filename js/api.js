'use strict';

// 共有シート（GAS）との同期クライアント。
// GAS URL 未設定時は localStorage を共有シートに見立てた「お試しモード」で動く。
const Api = (() => {
  const LS_GAS_URL = 'ierukana.gasUrl';
  const LS_MOCK = 'ierukana.mockAnswers';
  const LS_QUEUE = 'ierukana.pendingQueue';

  function configGasUrl() {
    return (typeof CONFIG !== 'undefined' && CONFIG.GAS_URL ? CONFIG.GAS_URL : '').trim();
  }
  function storedGasUrl() {
    return (localStorage.getItem(LS_GAS_URL) || '').trim();
  }
  function gasUrl() {
    return configGasUrl() || storedGasUrl();
  }
  function setGasUrl(url) {
    if (url) localStorage.setItem(LS_GAS_URL, url);
    else localStorage.removeItem(LS_GAS_URL);
  }
  function isMock() {
    return !gasUrl();
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

  // --- お試しモード実装 ---
  function mockAnswers() {
    return loadJson(LS_MOCK, []);
  }
  function mockRequest(payload) {
    let answers = mockAnswers();
    if (payload.action === 'answer') {
      const seen = new Set(answers.map((a) => a.no));
      for (const e of payload.entries) {
        if (!seen.has(e.no)) {
          seen.add(e.no);
          answers.push({ no: e.no, player: e.player, ts: e.ts || new Date().toISOString() });
        }
      }
    } else if (payload.action === 'reset') {
      answers = [];
    }
    localStorage.setItem(LS_MOCK, JSON.stringify(answers));
    return { ok: true, answers };
  }

  // --- GAS 実装 ---
  async function gasPost(payload) {
    const res = await fetch(gasUrl(), {
      method: 'POST',
      // text/plain なら CORS プリフライトが発生しないため GAS でそのまま受けられる
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
    });
    return parseResponse(res);
  }
  async function gasGet() {
    const res = await fetch(gasUrl());
    return parseResponse(res);
  }
  async function parseResponse(res) {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'サーバーエラー');
    return data;
  }

  async function post(payload) {
    return isMock() ? mockRequest(payload) : gasPost(payload);
  }

  // 同期リクエストを直列化する（連打しても同時に複数の通信を走らせない）
  let chain = Promise.resolve();
  function serialized(task) {
    const run = chain.then(task);
    chain = run.catch(() => {});
    return run;
  }

  // キューの回答を送信してから最新の全回答を返す。キューが空なら取得のみ。
  function sync() {
    return serialized(async () => {
      const queue = pendingEntries();
      let data;
      if (queue.length) {
        data = await post({ action: 'answer', entries: queue });
        // 送信できた分だけキューから消す（送信中に増えた分は残す）
        const sent = new Set(queue.map((e) => e.no));
        saveQueue(pendingEntries().filter((e) => !sent.has(e.no)));
      } else {
        data = isMock() ? { ok: true, answers: mockAnswers() } : await gasGet();
      }
      return data.answers;
    });
  }

  // 回答をキューに積んで同期。通信に失敗してもキューに残るので消えない。
  function submitAnswer(no, player) {
    enqueue({ no, player, ts: new Date().toISOString() });
    return sync();
  }

  function reset() {
    return serialized(async () => {
      saveQueue([]);
      const data = await post({ action: 'reset' });
      return data.answers;
    });
  }

  return {
    isMock,
    configGasUrl,
    storedGasUrl,
    setGasUrl,
    pendingEntries,
    submitAnswer,
    sync,
    reset,
  };
})();
