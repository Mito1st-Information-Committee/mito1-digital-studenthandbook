#!/usr/bin/env python3
"""
時間割の自動同期スクリプト.

  Google Sheets の htmlview（静的HTML）から時間割画像
  （img[src^="https://docs.google.com/sheets-images-rt/"]）を抽出し、
  画像バイトのハッシュを前回分と比較して、差分があれば
  public/timetable/ に上書き保存する。

■ なぜURL比較ではなく中身比較か
  sheets-images-rt のトークンは取得ごとに変わる。
  別トークンの2URLを落として比べるとバイト単位で完全一致する
  （sha256一致を確認済み）。URL文字列の比較では毎回「差分あり」に
  なってしまうため、必ずダウンロード→ハッシュ比較すること。

■ 使い方
  python .github/scripts/timetable_sync.py   # リポジトリルートで実行

■ 環境変数
  TIMETABLE_SHEET_URL            対象シートのhtmlview URL（既定値あり）
  TIMETABLE_OUT_DIR              出力先（既定: public/timetable）
  FIREBASE_SERVICE_ACCOUNT_JSON  設定時のみ: 更新後にWeb Push一斉送信する
  TIMETABLE_WORKERS_URL          WorkersのベースURL（既定値あり）
"""

import hashlib
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path

import requests

JST = timezone(timedelta(hours=9))
UA = {"User-Agent": "Mozilla/5.0 (compatible; mito1-timetable-sync/1.0)"}

SHEET_URL = os.environ.get(
    "TIMETABLE_SHEET_URL",
    "https://docs.google.com/spreadsheets/u/0/d/"
    "1fdSGqT1s2kit91TcQV_mjcuvOawGAU6JZ_5N684bH3U/htmlview/sheet"
    "?headers=false&gid=0&pli=1",
)
IMG_PREFIX = "https://docs.google.com/sheets-images-rt/"
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
OUT_DIR = Path(os.environ.get("TIMETABLE_OUT_DIR", REPO_ROOT / "public" / "timetable"))
MANIFEST_NAME = "manifest.json"
# 過去分アーカイブ: public/timetable/history/YYYY-MM-DD/ + history.json
# 最新 + 過去を含め最大7日分（7件の日付フォルダ）を保持する。
HISTORY_KEEP = int(os.environ.get("TIMETABLE_HISTORY_KEEP", "7"))
HISTORY_INDEX_NAME = "history.json"
WORKERS_URL = os.environ.get(
    "TIMETABLE_WORKERS_URL",
    "https://mito1-hundbook.asanuma-ryuto.workers.dev",
)


class SheetImageParser(HTMLParser):
    """imgタグのsrcのうち sheets-images-rt のものだけ集める."""

    def __init__(self):
        super().__init__()
        self.srcs = []

    def handle_starttag(self, tag, attrs):
        if tag != "img":
            return
        for name, value in attrs:
            if name == "src" and value and value.startswith(IMG_PREFIX):
                self.srcs.append(value)


def log(msg):
    print(f"[timetable] {msg}", flush=True)


def fetch(url, timeout=30, retries=2):
    last = None
    for attempt in range(retries + 1):
        try:
            r = requests.get(url, headers=UA, timeout=timeout)
            r.raise_for_status()
            return r.content
        except Exception as e:
            last = e
            log(f"fetch retry {attempt + 1}: {e}")
            time.sleep(3)
    raise last


def extract_image_urls(html):
    parser = SheetImageParser()
    parser.feed(html)
    # 順序を保ったまま重複URLを除去
    return list(dict.fromkeys(parser.srcs))


def sniff_ext(blob):
    if blob[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if blob[:3] == b"\xff\xd8\xff":
        return "jpg"
    if blob[:4] == b"RIFF" and blob[8:12] == b"WEBP":
        return "webp"
    if blob.startswith(b"GIF8"):
        return "gif"
    return "bin"


def sync():
    log(f"GET {SHEET_URL}")
    html = fetch(SHEET_URL).decode("utf-8", errors="replace")
    urls = extract_image_urls(html)
    log(f"img抽出: {len(urls)}件")
    if not urls:
        return {"changed": False, "reason": "no-images"}

    # ダウンロード→ハッシュ化（トークンが回転するため中身で比較する）
    images = []
    seen_hashes = set()
    for i, url in enumerate(urls):
        time.sleep(1)
        blob = fetch(url)
        digest = hashlib.sha256(blob).hexdigest()
        if digest in seen_hashes:
            log(f"{i}枚目: 内容が重複のためスキップ")
            continue
        seen_hashes.add(digest)
        images.append({"blob": blob, "hash": digest, "bytes": len(blob),
                       "ext": sniff_ext(blob)})
        log(f"{i}枚目: {len(blob)} bytes sha256={digest[:12]}...")

    if not images:
        return {"changed": False, "reason": "all-duplicate"}

    new_hashes = [im["hash"] for im in images]
    manifest_path = OUT_DIR / MANIFEST_NAME
    old_hashes = []
    old_files_ok = False
    old_manifest = None
    if manifest_path.exists():
        try:
            old_manifest = json.loads(manifest_path.read_text())
            old_hashes = [im["hash"] for im in old_manifest["images"]]
            old_files_ok = all((OUT_DIR / im["file"]).exists() for im in old_manifest["images"])
        except Exception as e:
            log(f"既存マニフェスト読み取り失敗（新規扱い）: {e}")

    # 集合で比較する（順序だけの入れ替わりでは更新扱いにしない）。
    # 枚数が減って残りが旧集合の部分集合の場合は、表示からは消すが
    # 通知はしない（Schedule_Bot の「枚数が減っただけなので終了」と同旨）。
    new_set, old_set = set(new_hashes), set(old_hashes)
    if new_set == old_set and old_files_ok:
        log("ハッシュ一致 → 更新なし")
        # 導入直後で履歴が空の場合のみ今日分を補完する（要コミットのためchanged扱い・通知なし）
        try:
            if old_manifest and backfill_today_history_if_empty(old_manifest):
                return {"changed": True, "notify": False, "count": len(images),
                        "updatedAt": old_manifest.get("updatedAt", ""), "reason": "backfill-history"}
        except Exception as e:
            log(f"バックフィルに失敗（無視）: {e}")
        return {"changed": False, "reason": "unchanged", "count": len(images)}
    notify = not (new_set < old_set)
    if not notify:
        log("画像が減っただけ → 表示は更新するが通知はしない")

    # 差分あり → 上書き保存（余ったslotファイルは掃除）
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    now = datetime.now(JST)
    entries = []
    for i, im in enumerate(images):
        fname = f"slot-{i}.{im['ext']}"
        (OUT_DIR / fname).write_bytes(im["blob"])
        entries.append({"file": fname, "hash": im["hash"], "bytes": im["bytes"]})
    for stale in OUT_DIR.glob("slot-*.*"):
        if stale.name != MANIFEST_NAME and stale.name not in {e["file"] for e in entries}:
            stale.unlink()
    manifest = {
        "updatedAt": now.isoformat(timespec="seconds"),
        "updatedAtLabel": f"{now.year}年{now.month}月{now.day}日 {now.hour}:{now.minute:02d}更新",
        "images": entries,
    }
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
    log(f"更新あり → {len(entries)}枚を保存 (notify={notify})")
    try:
        archive_snapshot(now, manifest, images)
    except Exception as e:
        log(f"履歴保存に失敗（最新表示には影響なし）: {e}")
    return {"changed": True, "notify": notify, "count": len(entries),
            "updatedAt": manifest["updatedAt"]}


def archive_snapshot(now, manifest, images):
    """当日分のスナップショットを history/YYYY-MM-DD/ に保存し、history.json を更新する.

    images は {"blob", "hash", "bytes", "ext"} または
    {"file", "hash", "bytes"}（バックフィル時）の混在を許容する。
    同一日の複数回更新は上書き（その日の最新を残す）。
    古い日付フォルダは HISTORY_KEEP 件を超えた分だけ削除する。
    """
    date_str = now.strftime("%Y-%m-%d")
    hdir = OUT_DIR / "history" / date_str
    hdir.mkdir(parents=True, exist_ok=True)
    hentries = []
    for i, im in enumerate(images):
        ext = im.get("ext") or (im.get("file", "").rsplit(".", 1)[-1] if "." in im.get("file", "") else "bin")
        fname = f"slot-{i}.{ext}"
        dest = hdir / fname
        blob = im.get("blob")
        if blob is not None:
            dest.write_bytes(blob)
            size = len(blob)
        else:
            src = OUT_DIR / im["file"]
            data = src.read_bytes()
            dest.write_bytes(data)
            size = len(data)
        hentries.append({"file": fname, "hash": im["hash"], "bytes": im.get("bytes", size)})
    # 日付フォルダ内の古いslotファイルを掃除
    for stale in hdir.glob("slot-*.*"):
        if stale.name not in {e["file"] for e in hentries}:
            try:
                stale.unlink()
            except Exception:
                pass
    hmanifest = {
        "date": date_str,
        "updatedAt": manifest.get("updatedAt", now.isoformat(timespec="seconds")),
        "updatedAtLabel": manifest.get("updatedAtLabel", ""),
        "images": hentries,
    }
    (hdir / MANIFEST_NAME).write_text(json.dumps(hmanifest, ensure_ascii=False, indent=2) + "\n")

    # history.json インデックスを更新（日付の降順・最大HISTORY_KEEP件）
    hist_path = OUT_DIR / HISTORY_INDEX_NAME
    items = []
    if hist_path.exists():
        try:
            loaded = json.loads(hist_path.read_text())
            if isinstance(loaded, list):
                items = loaded
            elif isinstance(loaded, dict) and isinstance(loaded.get("items"), list):
                items = loaded["items"]
        except Exception as e:
            log(f"history.json読み取り失敗（作り直し）: {e}")
    items = [it for it in items if isinstance(it, dict) and it.get("date") != date_str]
    items.append({
        "date": date_str,
        "updatedAt": hmanifest["updatedAt"],
        "updatedAtLabel": hmanifest["updatedAtLabel"],
        "dir": f"history/{date_str}",
        "images": hentries,
    })
    # 日付降順に並べ替え（date が無い旧形式は末尾）
    items.sort(key=lambda it: (it.get("date") or "", it.get("updatedAt") or ""), reverse=True)
    kept, dropped = items[:HISTORY_KEEP], items[HISTORY_KEEP:]
    hist_path.write_text(json.dumps(kept, ensure_ascii=False, indent=2) + "\n")
    # 保持外の日付フォルダを削除
    for it in dropped:
        d = it.get("date")
        if d:
            _rm_history_dir(d)
    # インデックスに無い古いフォルダ（手動削除漏れ等）も掃除
    try:
        keep_dates = {it.get("date") for it in kept if isinstance(it, dict)}
        hist_root = OUT_DIR / "history"
        if hist_root.exists():
            for child in hist_root.iterdir():
                if child.is_dir() and child.name not in keep_dates:
                    # YYYY-MM-DD 形式のものだけ消す（安全弁）
                    if len(child.name) == 10 and child.name[4] == "-" and child.name[7] == "-":
                        _rm_history_dir(child.name)
    except Exception as e:
        log(f"履歴掃除に失敗（無視）: {e}")
    log(f"履歴保存 → {date_str}（保持{len(kept)}件）")


def _rm_history_dir(date_str):
    import shutil
    target = OUT_DIR / "history" / date_str
    try:
        if target.exists():
            shutil.rmtree(target)
            log(f"古い履歴を削除: {date_str}")
    except Exception as e:
        log(f"履歴削除に失敗 {date_str}: {e}")


def backfill_today_history_if_empty(old_manifest):
    """導入直後（history.jsonが空）の救済: 現在の最新画像を今日分として保存する.

    過去の画像は復元できないため、初回は今日の1件から始まり、
    翌日以降の更新で自然に蓄積される。
    """
    hist_path = OUT_DIR / HISTORY_INDEX_NAME
    try:
        if hist_path.exists():
            loaded = json.loads(hist_path.read_text())
            items = loaded if isinstance(loaded, list) else loaded.get("items", [])
            if items:
                return False
    except Exception:
        pass
    if not old_manifest or not old_manifest.get("images"):
        return False
    try:
        updated_at = old_manifest.get("updatedAt", "")
        try:
            now = datetime.fromisoformat(updated_at)
            if now.tzinfo is None:
                now = now.replace(tzinfo=JST)
        except Exception:
            now = datetime.now(JST)
        archive_snapshot(now, old_manifest, old_manifest["images"])
        log("history.jsonが空だったため今日分をバックフィルした")
        return True
    except Exception as e:
        log(f"バックフィルに失敗（無視）: {e}")
        return False


# -------------------------------------------------------------------
# Web Push一斉送信（FIREBASE_SERVICE_ACCOUNT_JSONがある場合のみ）
# -------------------------------------------------------------------
def broadcast_push():
    sa_json = os.environ.get("FIREBASE_SERVICE_ACCOUNT_JSON", "")
    if not sa_json.strip():
        log("SA鍵なし → Push送信をスキップ")
        return {"sent": 0, "skipped": True}

    from google.auth.transport.requests import AuthorizedSession
    from google.oauth2 import service_account

    info = json.loads(sa_json)
    project_id = info["project_id"]
    creds = service_account.Credentials.from_service_account_info(
        info, scopes=["https://www.googleapis.com/auth/datastore"]
    )
    sess = AuthorizedSession(creds)
    base = f"https://firestore.googleapis.com/v1/projects/{project_id}/databases/(default)/documents"

    def rest(method, path, **kw):
        r = sess.request(method, base + path, timeout=30, **kw)
        if r.status_code in (404, 410):
            return None
        r.raise_for_status()
        return r.json() if r.content else {}

    def list_user_subs(uid):
        """1ユーザーの pushSubscriptions を全ページ取得する."""
        out, token = [], ""
        while True:
            params = {"pageSize": 100}
            if token:
                params["pageToken"] = token
            data = rest("GET", f"/users/{uid}/pushSubscriptions", params=params) or {}
            for sdoc in data.get("documents", []):
                f = sdoc.get("fields", {})
                try:
                    out.append({
                        "name": sdoc["name"],
                        "endpoint": f["endpoint"]["stringValue"],
                        "keys": {
                            "p256dh": f["keys"]["mapValue"]["fields"]["p256dh"]["stringValue"],
                            "auth": f["keys"]["mapValue"]["fields"]["auth"]["stringValue"],
                        },
                    })
                except KeyError:
                    continue
            token = data.get("nextPageToken", "")
            if not token:
                return out

    # 全ユーザーを列挙 → 各自の pushSubscriptions を並列で集める
    # （逐次だとユーザー数に比例して遅延するため。購読の送信自体も後段で並列化）
    uids, page_token = [], ""
    while True:
        params = {"pageSize": 300}
        if page_token:
            params["pageToken"] = page_token
        data = rest("GET", "/users", params=params) or {}
        uids.extend(doc["name"].split("/")[-1] for doc in data.get("documents", []))
        page_token = data.get("nextPageToken", "")
        if not page_token:
            break
    subs = []
    with ThreadPoolExecutor(max_workers=8) as pool:
        for user_subs in pool.map(list_user_subs, uids):
            subs.extend(user_subs)
    log(f"購読取得: ユーザー{len(uids)}件 → 購読{len(subs)}件")

    payload = {
        "title": "時間割が更新されました",
        "body": "時間割が更新されました。手帳で確認してください。",
        "url": "/#timetable",
        "tag": "timetable-update",
    }
    sent, gone = 0, 0

    def send_one(sub):
        try:
            r = requests.post(
                f"{WORKERS_URL}/push/send",
                json={"subscription": {"endpoint": sub["endpoint"], "keys": sub["keys"]},
                      "payload": payload},
                timeout=30,
            )
            data = r.json() if r.content else {}
            if r.ok and data.get("ok") is True:
                return "sent"
            if r.status_code in (404, 410) or data.get("gone"):
                # 購読切れ → Firestoreから削除
                sess.delete(base + "/" + sub["name"].split("/documents/", 1)[1], timeout=30)
                return "gone"
            return "failed"
        except Exception:
            return "failed"

    with ThreadPoolExecutor(max_workers=8) as pool:
        for result in pool.map(send_one, subs):
            if result == "sent":
                sent += 1
            elif result == "gone":
                gone += 1
    log(f"Push送信: 成功{sent}件 / 購読切れ削除{gone}件")
    return {"sent": sent, "gone": gone, "total": len(subs)}


def emit_output(result):
    out = os.environ.get("GITHUB_OUTPUT", "")
    if out:
        with open(out, "a") as f:
            f.write(f"changed={'true' if result.get('changed') else 'false'}\n")
            f.write(f"count={result.get('count', 0)}\n")
    summary = os.environ.get("GITHUB_STEP_SUMMARY", "")
    if summary:
        with open(summary, "a") as f:
            f.write(f"## 時間割同期\n- changed: {result.get('changed')}\n"
                    f"- count: {result.get('count', 0)}\n"
                    f"- reason: {result.get('reason', '-')}\n")
            if "push" in result:
                p = result["push"]
                f.write(f"- push sent: {p.get('sent', 0)} / total: {p.get('total', '-')} "
                        f"/ gone: {p.get('gone', 0)}\n")


def main():
    result = sync()
    force = os.environ.get("FORCE_NOTIFY", "") in ("true", "1")
    # 減枚のみの更新ではPushしない（表示の同期はする）。
    # 手動実行の force_notify はテスト用に差分なしでも送信する。
    if result.get("changed") and result.get("notify", True):
        result["push"] = broadcast_push()
    elif result.get("changed"):
        log("通知なし更新のためPush送信をスキップ")
    elif force:
        log("force_notify のためテスト送信する")
        result["push"] = broadcast_push()
        result["push"]["test"] = True
    emit_output(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
