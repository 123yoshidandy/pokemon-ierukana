'use strict';

// 表記ゆれ用の別名 → 図鑑No（正式名は buildNameIndex で POKEDEX から自動登録される）
const NAME_ALIASES = {
  'ニドランオス': 32,
  'ニドランメス': 29,
  'ポリゴンツー': 233,
  'ポリゴンゼット': 474,
  'タイプヌル': 772,
};

// 入力と正式名の両方に適用する正規化。
// 例: 「ぽりごんｚ」→「ポリゴンZ」、「タイプ：ヌル」→「タイプヌル」、「ニドラン♂」→「ニドランオス」
function normalizeName(raw) {
  let s = String(raw || '').normalize('NFKC'); // 全角英数→半角、半角カナ→全角カナ など
  s = s.replace(/\s+/g, '');
  s = s.replace(/[・:.,'"「」()]/g, '');
  s = s.replace(/[-−–—]/g, 'ー'); // ハイフン類は長音の打ち間違いとみなす
  s = s.replace(/♂/g, 'オス').replace(/♀/g, 'メス');
  s = s.replace(/[ぁ-ゖ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0x60)); // ひらがな→カタカナ
  return s.toUpperCase();
}

// 正規化済みの名前 → 図鑑No の辞書
function buildNameIndex(pokedex) {
  const index = new Map();
  for (const p of pokedex) index.set(normalizeName(p.name), p.no);
  for (const alias of Object.keys(NAME_ALIASES)) index.set(normalizeName(alias), NAME_ALIASES[alias]);
  return index;
}
