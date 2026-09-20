// ポケモンいえるかなの共有シート API。
// スプレッドシートに紐づく Apps Script（拡張機能 > Apps Script）として貼り付け、
// 「ウェブアプリ」としてデプロイして使う。手順は README.md を参照。
//
// 部屋ごとに 1 シート。作成した部屋は room_1234（列は no, player, ts）。
// 既存の answers シートは「みんなの部屋」（部屋 ID 0000、全員が入室済み）として扱う。

var HEADER = ['no', 'player', 'ts'];
var ROOM_PREFIX = 'room_';
var DEFAULT_ROOM = '0000'; // 既存の answers シートを指す特別な部屋
var DEFAULT_SHEET = 'answers';

// 状態取得: GET https://…/exec?room=1234（room 省略時はみんなの部屋）
function doGet(e) {
  try {
    var room = roomId_(e && e.parameter && e.parameter.room);
    return jsonOutput_(readState_(room));
  } catch (err) {
    return jsonOutput_({ ok: false, error: err.message || String(err) });
  }
}

// 部屋作成 / 回答追加 / リセット: POST（本文は text/plain の JSON）
//   {"action":"create"}                                            → 部屋を作って ID を返す
//   {"action":"answer","room":"1234","entries":[{"no":25,"player":"かずき"}, …]}
//   {"action":"reset","room":"1234"}
function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20 * 1000);
  try {
    var req = JSON.parse(e.postData.contents);
    if (req.action === 'create') {
      return jsonOutput_(readState_(createRoom_()));
    }
    var room = roomId_(req.room);
    if (req.action === 'answer') {
      addAnswers_(room, req.entries || []);
      return jsonOutput_(readState_(room));
    }
    if (req.action === 'reset') {
      resetAnswers_(room);
      return jsonOutput_(readState_(room));
    }
    return jsonOutput_({ ok: false, error: 'unknown action: ' + req.action });
  } catch (err) {
    return jsonOutput_({ ok: false, error: err.message || String(err) });
  } finally {
    lock.releaseLock();
  }
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

// 部屋 ID は 4 桁数字のみ受け付ける（シート名に任意の文字列が混ざるのを防ぐ）。
// 未指定は部屋機能より前のアプリからの呼び出しなので、みんなの部屋として扱う
function roomId_(value) {
  var id = value == null ? '' : String(value).trim();
  if (!id) return DEFAULT_ROOM;
  if (!/^\d{4}$/.test(id)) throw new Error('部屋 ID は 4 桁の数字です');
  return id;
}

// 部屋のシート。みんなの部屋だけは無ければ作る（従来互換）。他は create で作ったものだけ有効
function roomSheet_(room) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var name = room === DEFAULT_ROOM ? DEFAULT_SHEET : ROOM_PREFIX + room;
  var sheet = ss.getSheetByName(name);
  if (!sheet && room === DEFAULT_ROOM) sheet = newRoomSheet_(ss, name);
  if (!sheet) throw new Error('部屋 ' + room + ' が見つかりません');
  return sheet;
}

function newRoomSheet_(ss, name) {
  var sheet = ss.insertSheet(name);
  // 新規シートは 26 列 × 1000 行。使う 3 列だけ残してセル数（ブック上限 1,000 万）を節約する
  sheet.deleteColumns(HEADER.length + 1, sheet.getMaxColumns() - HEADER.length);
  sheet.appendRow(HEADER);
  return sheet;
}

// 未使用の 4 桁 ID を引いて部屋シートを作る。doPost のロック内で呼ばれるので同時作成でも重複しない
function createRoom_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  for (var i = 0; i < 50; i++) {
    var room = String(1000 + Math.floor(Math.random() * 9000));
    if (!ss.getSheetByName(ROOM_PREFIX + room)) {
      newRoomSheet_(ss, ROOM_PREFIX + room);
      return room;
    }
  }
  throw new Error('空いている部屋 ID が見つかりません');
}

function readRows_(sheet) {
  var last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, 3).getValues();
}

// 全応答の共通形。room を返すのはクライアントが「どの部屋の応答か」を突き合わせるため
function readState_(room) {
  var answers = readRows_(roomSheet_(room)).map(function (row) {
    return {
      no: Number(row[0]),
      player: String(row[1]),
      ts: row[2] instanceof Date ? row[2].toISOString() : String(row[2]),
    };
  });
  return { ok: true, room: room, answers: answers };
}

// 未回答の図鑑Noだけ追記する（先に答えた人が勝ち）
function addAnswers_(room, entries) {
  var sheet = roomSheet_(room);
  var seen = {};
  readRows_(sheet).forEach(function (row) {
    seen[Number(row[0])] = true;
  });
  var rows = [];
  entries.forEach(function (e) {
    var no = Math.floor(Number(e.no));
    if (!no || no < 1 || no > 10000 || seen[no]) return;
    seen[no] = true;
    rows.push([no, String(e.player || '名無し').slice(0, 20), new Date()]);
  });
  if (!rows.length) return;
  var start = sheet.getLastRow() + 1;
  // 1025 匹 + ヘッダでシート既定の 1000 行を超える。setValues の自動拡張に頼らず先に行を足す
  var lack = start + rows.length - 1 - sheet.getMaxRows();
  if (lack > 0) sheet.insertRowsAfter(sheet.getMaxRows(), lack);
  sheet.getRange(start, 1, rows.length, 3).setValues(rows);
}

// 現在の回答を log_部屋ID_日時 シートへ退避してからクリアする
function resetAnswers_(room) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = roomSheet_(room);
  if (sheet.getLastRow() < 2) return;
  var stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmmss');
  var copy = sheet.copyTo(ss);
  copy.setName('log_' + room + '_' + stamp);
  sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).clearContent();
}
