'use strict';

// デプロイ時の設定ファイル。
// GAS_URL に Google Apps Script の Web アプリ URL（…/exec）を設定してから
// 全ファイルを S3 / GitHub Pages 等へアップロードすると、全員が同じシートに接続される。
// 未設定のままだと動作しない（画面にエラーが表示される）。
const CONFIG = {
  GAS_URL: 'https://script.google.com/macros/s/AKfycbwtaChO-fM_EEIQ5TrBvX7o5jtmxr2PYq2e0uR93Ucl0-bPGgqMHLMKzByhouqNdMM8/exec',
};
