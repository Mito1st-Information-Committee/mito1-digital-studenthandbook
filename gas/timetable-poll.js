/**
 * gas/timetable-poll.js
 * 時間割のポーリング用 GAS（Google Apps Script）
 *
 * ■ 役割
 *   10分おきにシートの htmlview から時間割画像を落としてハッシュ化し、
 *   前回分と差分があれば GitHub へ repository_dispatch を送る。
 *   受けた timetable.yml が画像保存・Pagesデプロイ・Push送信を行う。
 *   差分がなければ何もしない（Actions の実行履歴を汚さないため）。
 *
 * ■ なぜ URL 比較ではなく中身比較か
 *   sheets-images-rt のトークンは取得ごとに変わる。
 *   別トークンの URL を落として比べるとバイト単位で完全一致するため、
 *   必ずダウンロード→SHA-256 比較すること。
 *
 * ■ 設置方法（初回のみ手作業）
 *   1. https://script.google.com で新規プロジェクト → このファイルの内容を貼り付け
 *   2. 歯車 → スクリプトプロパティ → GH_PAT に PAT を登録
 *      （Fine-grained: 対象リポジトリのみ・Actions 読み書き。
 *       動かなければ classic の public_repo で作り直す。
 *       PAT はコードに書かないこと）
 *   3. 時計アイコン → トリガー追加 → pollTimetable・時間主導・分タイマー・10分おき
 *   4. エディタの実行ボタンで一度手動実行（初回は承認ダイアログが出る）。
 *      実行ログに 204 と出れば成功。Actions 側に実行が並ぶ。
 *
 * ■ このファイルと本番 GAS の関係
 *   本番で動くのは script.google.com 側に貼られたコード。
 *   変更したら必ずこっちにも反映し、両者を一致させておくこと。
 */

function pollTimetable() {
  // 夜間休止（JST 18:00〜10:00）。GASの実行コストとレート制限を避ける。
  const now = new Date();
  const hour = now.getHours();
  if (hour < 10 || hour >= 18) {
    Logger.log('休暇時間のためスキップ: ' + hour + '時');
    return;
  }

  const props = PropertiesService.getScriptProperties();
  const pat = props.getProperty('GH_PAT');
  if (!pat) throw new Error('GH_PAT未設定');

  // シートの画像を落としてハッシュ化（トークンは回転するため中身で比較）
  const html = UrlFetchApp.fetch(
    'https://docs.google.com/spreadsheets/u/0/d/1fdSGqT1s2kit91TcQV_mjcuvOawGAU6JZ_5N684bH3U/htmlview/sheet?headers=false&gid=0&pli=1'
  ).getContentText('utf-8');
  const urls = [...new Set(
    [...html.matchAll(/<img[^>]+src="(https:\/\/docs\.google\.com\/sheets-images-rt\/[^"]+)"/g)].map(m => m[1])
  )];
  const hashes = urls.map(u => {
    Utilities.sleep(1000);
    const bytes = UrlFetchApp.fetch(u).getContent();
    return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes)
      .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
  }).sort().join(',');
  Logger.log('current: ' + hashes.slice(0, 32) + '...');

  if (hashes === props.getProperty('LAST_HASHES')) {
    Logger.log('no change → skip');
    return;
  }
  props.setProperty('LAST_HASHES', hashes);

  const res = UrlFetchApp.fetch(
    'https://api.github.com/repos/Ryuto-dev/mito1-digital-studenthandbook/dispatches',
    {
      method: 'post',
      contentType: 'application/json',
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + pat,
      },
      payload: JSON.stringify({ event_type: 'timetable-poll' }),
      muteHttpExceptions: true,
    }
  );
  Logger.log(res.getResponseCode());
  if (res.getResponseCode() !== 204) throw new Error(res.getContentText().slice(0, 200));
}
