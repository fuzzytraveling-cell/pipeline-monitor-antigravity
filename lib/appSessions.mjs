/**
 * appSessions.mjs —— 對話的標題與「在 app 裡被刪了沒」,從 Claude 自己的檔案讀
 *
 * ⚠️ 2026-09-15 Oscar:「對話標題沒有連上」。原因:感測器只在 UserPromptSubmit 的 payload 裡拿得到
 *    session_title,而標題是對話**開始之後**才生出來的——只講一句話的對話,紀錄裡永遠沒有標題。
 *    標題真正住的地方是桌面 app 自己的對話索引(每個對話一個 json,有 title 與 cliSessionId)。
 *
 * 規矩:
 *   - **只讀,只拿兩個欄位**(title、cliSessionId)。那些檔案裡還有別的東西,一律不碰、不存、不印。
 *   - 那是別人的內部格式,隨時會變。讀不到、讀不懂 → 當沒有,畫面退回感測器記的標題或「（還沒有標題）」。
 *     絕不因為它變了就讓整頁掛掉,也絕不印出半個內部值。
 *   - 「已在 app 裡刪除」看轉錄資料夾裡的 <session>.desktop-released.json(reason:delete)。
 *     一個被刪掉的對話還畫成「進行中」,是這個工具最忌諱的那種假畫面。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const APP_SESSIONS = join(homedir(), 'Library', 'Application Support', 'Claude', 'claude-code-sessions');
const TRANSCRIPTS = join(homedir(), '.claude', 'projects');

/** 桌面 app 的對話索引 → Map<claude 的 session id, 標題>。目錄結構是 <workspace>/<sub>/local_*.json,只走兩層。 */
export function readAppTitles(dir = APP_SESSIONS) {
  const map = new Map();
  let level1 = [];
  try { level1 = readdirSync(dir); } catch { return map; }
  for (const a of level1) {
    let level2 = [];
    try { level2 = readdirSync(join(dir, a)); } catch { continue; }
    for (const b of level2) {
      let files = [];
      try { files = readdirSync(join(dir, a, b)); } catch { continue; }
      for (const f of files) {
        if (!f.startsWith('local_') || !f.endsWith('.json')) continue;
        try {
          const d = JSON.parse(readFileSync(join(dir, a, b, f), 'utf8'));
          if (typeof d?.cliSessionId === 'string' && typeof d?.title === 'string' && d.title.trim()) {
            map.set(d.cliSessionId, d.title.trim());
          }
        } catch { /* 讀不懂就跳過這一個,不影響其他的 */ }
      }
    }
  }
  return map;
}

/** 轉錄資料夾的名字:cwd 裡非英數的字元全換成 -(實測:「/Users/x/Desktop/Forma Pro」→「-Users-x-Desktop-Forma-Pro」) */
export const transcriptDirName = (cwd) => String(cwd).replace(/[^A-Za-z0-9]/g, '-');

/** 這個對話在 app 裡被刪了沒。回 ISO 時間或 null。 */
export function deletedAt(sessionId, cwd, root = TRANSCRIPTS) {
  if (!sessionId || !cwd) return null;
  const p = join(root, transcriptDirName(cwd), `${sessionId}.desktop-released.json`);
  if (!existsSync(p)) return null;
  try {
    const d = JSON.parse(readFileSync(p, 'utf8'));
    return d?.reason === 'delete' && typeof d?.releasedAt === 'string' ? d.releasedAt : null;
  } catch { return null; }
}

/**
 * 這個對話真正開始的時間:轉錄檔(<session>.jsonl)建立的那一刻。只看檔案的建立時間,不讀內容。
 * 感測器記到的「第一筆」不一定是開始——感測器壞著的時候開始的對話,第一筆被記到的是修好之後(規格:agent回報與故障記號 AC-5,魔鬼教官第一輪)。
 * 找不到檔、這台電腦的檔案系統不給建立時間(回 0)→ null,呼叫端照「不知道真的起點」處理,不猜。
 */
export function sessionStartOf(sessionId, cwd, root = TRANSCRIPTS) {
  if (!sessionId || !cwd) return null;
  try {
    const ms = statSync(join(root, transcriptDirName(cwd), `${sessionId}.jsonl`)).birthtimeMs;
    return ms > 0 ? new Date(ms).toISOString() : null;
  } catch { return null; }
}
