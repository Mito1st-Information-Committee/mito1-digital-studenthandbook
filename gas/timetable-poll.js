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
 *   sheets-images-rt のトークンは取得ごとに変わるため、
 *   URL文字列の比較では毎回「差分あり」になってしまう。
 *
 * ■ なぜ厳密なバイト一致で判定しないか（2026-10 追記）
 *   Google側の画像プロキシがJPEGを再エンコードするようになり、
 *   同じ見た目でも取得ごとに数十バイト変わり sha256 が反転する
 *   （例: 81432⇔81439 bytesで10分おきの誤dispatchを確認）。
 *   GASには画像デコード手段がないため、ここでは枚数＋サイズ許容
 *   （2KBまたは5%以内の差は無視）で「たぶん変わった」ときだけ送り、
 *   真の判定は Actions 側 timetable_sync.py の画素比較に任せる。
 *   GASが見逃しても Actions の schedule（10分おき）が拾うので、
 *   誤検出（spam）を減らす側に倒してよい。
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

  // シートの画像を落として比較する。トークンは回転するためURL比較は不可。
  // バイト厳密一致は再エンコード微差で毎回変わるため、枚数＋サイズ許容で判定する。
  const html = UrlFetchApp.fetch(
    'https://docs.google.com/spreadsheets/u/0/d/1fdSGqT1s2kit91TcQV_mjcuvOawGAU6JZ_5N684bH3U/htmlview/sheet?headers=false&gid=0&pli=1'
  ).getContentText('utf-8');
  const urls = [...new Set(
    [...html.matchAll(/<img[^>]+src="(https:\/\/docs\.google\.com\/sheets-images-rt\/[^"]+)"/g)].map(m => m[1])
  )];
  const sizes = urls.map(u => {
    Utilities.sleep(1000);
    const bytes = UrlFetchApp.fetch(u).getContent();
    return bytes.length;
  }).sort((a, b) => a - b);
  Logger.log('current: count=' + sizes.length + ' sizes=' + sizes.join(','));

  // 前回との比較（許容: 各画像 2KBまたは5%以内の差は再エンコード微差とみなす）
  let changed = false;
  let prev = null;
  try { prev = JSON.parse(props.getProperty('LAST_STATE') || 'null'); } catch (e) { prev = null; }
  if (!prev || !Array.isArray(prev.sizes) || prev.sizes.length !== sizes.length) {
    changed = sizes.length > 0; // 枚数が変われば変化（0枚の取得失敗時は送らない）
    if (sizes.length === 0) {
      Logger.log('no images → skip (fetch failure?)');
      return;
    }
  } else {
    for (let i = 0; i < sizes.length; i++) {
      const a = prev.sizes[i], b = sizes[i];
      const tol = Math.max(2048, Math.floor(a * 0.05));
      if (Math.abs(a - b) > tol) { changed = true; break; }
    }
  }
  // 状態は毎回更新（微差ドリフトを溜めない）
  props.setProperty('LAST_STATE', JSON.stringify({ sizes: sizes }));
  // 旧キーで止まっている場合の取り残し防止（次回からは使わない）
  try { props.deleteProperty('LAST_HASHES'); } catch (e) {}

  if (!changed) {
    Logger.log('no change → skip');
    return;
  }

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
