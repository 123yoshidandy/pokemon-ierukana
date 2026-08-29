// 全ポケモン言えるかな（協力版）の共有シート API。
// スプレッドシートに紐づく Apps Script（拡張機能 > Apps Script）として貼り付け、
// 「ウェブアプリ」としてデプロイして使う。手順は README.md を参照。

var ANSWER_SHEET = 'answers';
var HEADER = ['no', 'player', 'ts'];

// 状態取得: GET https://…/exec
function doGet() {
  return jsonOutput_(readState_());
}

// 回答追加 / リセット: POST（本文は text/plain の JSON）
//   {"action":"answer","entries":[{"no":25,"player":"かずき"}, …]}
//   {"action":"reset"}
function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20 * 1000);
  try {
    var req = JSON.parse(e.postData.contents);
    if (req.action === 'answer') {
      addAnswers_(req.entries || []);
      return jsonOutput_(readState_());
    }
    if (req.action === 'reset') {
      resetAnswers_();
      return jsonOutput_(readState_());
    }
    return jsonOutput_({ ok: false, error: 'unknown action: ' + req.action });
  } catch (err) {
    return jsonOutput_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(
    ContentService.MimeType.JSON
  );
}

function answerSheet_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(ANSWER_SHEET);
  if (!sheet) {
    sheet = ss.insertSheet(ANSWER_SHEET);
    sheet.appendRow(HEADER);
  }
  return sheet;
}

function readRows_() {
  var sheet = answerSheet_();
  var last = sheet.getLastRow();
  if (last < 2) return [];
  return sheet.getRange(2, 1, last - 1, 3).getValues();
}

function readState_() {
  var answers = readRows_().map(function (row) {
    return {
      no: Number(row[0]),
      player: String(row[1]),
      ts: row[2] instanceof Date ? row[2].toISOString() : String(row[2]),
    };
  });
  return { ok: true, answers: answers };
}

// 未回答の図鑑Noだけ追記する（先に答えた人が勝ち）
function addAnswers_(entries) {
  var sheet = answerSheet_();
  var seen = {};
  readRows_().forEach(function (row) {
    seen[Number(row[0])] = true;
  });
  var rows = [];
  entries.forEach(function (e) {
    var no = Math.floor(Number(e.no));
    if (!no || no < 1 || no > 10000 || seen[no]) return;
    seen[no] = true;
    rows.push([no, String(e.player || '名無し').slice(0, 20), new Date()]);
  });
  if (rows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 3).setValues(rows);
  }
}

// 現在の回答を log_日時 シートへ退避してからクリアする
function resetAnswers_() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = answerSheet_();
  if (sheet.getLastRow() < 2) return;
  var stamp = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyyMMdd_HHmmss');
  var copy = sheet.copyTo(ss);
  copy.setName('log_' + stamp);
  sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).clearContent();
}
