/**
 * checkpoint.mjs —— 章(還原點)住哪、這個資料夾認哪一顆。只有這一份。規格:新對話接手舊資料夾 AC-3(路徑看 CLAUDE.md 的表)
 *
 * ⚠️ 以前兩處各算一次(老毛病 P2):終端機照「專案__分支.json」找、儀表板照檔案裡的 worktree 找。
 *    app 把舊對話的資料夾換一條新分支給新對話用之後(2026-09-24 實測),終端機說「還沒有還原點」、
 *    儀表板拿上一個對話的章當基準——「蓋章之後改過 40 個檔」、T2,其實這個對話只改了 19 個、T1。
 *    同一個資料夾有兩個章檔時(TutorPod 的 agent-dashboard 資料夾),儀表板認哪一顆看檔名排序的運氣。
 * 章蓋在「這個資料夾的這條分支」上——章本來就兩樣都記(pipeline-status 的規格:三個 worktree 各有各的分支)——
 * 而且要蓋在這個資料夾最近一次換人之後(lib/origin.mjs 的 takeoverOf):換了分支,舊章留給舊分支。
 * 章檔的寫法不變:checkpoints/<專案>__<分支>.json,檔名跟紀錄檔同一條規則(safeName;網頁拿兩種檔名對專案,誠實修補 C3)。
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { makeDataDir } from './paths.mjs';
import { join } from 'node:path';
import { safeName } from './events.mjs';

/** 一條分支的章檔。寫(--checkpoint)只用這裡拼路徑。 */
export function checkpointFile(dir, project, branch) {
  return join(dir, `${safeName(project)}__${safeName(branch)}.json`);
}

/**
 * 這個專案所有讀得懂的章,蓋的時間舊到新。project 給真的專案名或 safeName 過的都可以(safeName 再套一次不變)。
 * 讀不到、不是章(沒有版本)的檔跳過——一個壞檔不准害死整頁、也不准害死收工。
 */
export function stampsIn(dir, project) {
  const pre = `${safeName(project)}__`;
  let files = [];
  try { files = existsSync(dir) ? readdirSync(dir) : []; } catch { files = []; }
  const list = [];
  for (const f of files) {
    if (!f.startsWith(pre) || !f.endsWith('.json')) continue;
    try {
      const cp = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (cp && typeof cp === 'object' && typeof cp.commit === 'string') list.push(cp);
    } catch { /* 讀不到就當沒有 */ }
  }
  return list.sort((a, b) => (Date.parse(a.at) || 0) - (Date.parse(b.at) || 0));
}

/** 這顆章是不是蓋在換人之前(上一手的)。時間讀不懂的也算之前:分不出是不是這一手蓋的,不拿來當還原點。 */
function stampedBefore(cp, takeover) {
  if (takeover?.state !== 'ok') return false;
  const t = Date.parse(cp?.at);
  return !Number.isFinite(t) || t < takeover.cutMs;
}

/**
 * 這個資料夾現在認的那一顆:資料夾、分支都對得上,而且蓋在最近一次換人之後。沒有 → null——
 * 畫面講「還沒有還原點」(還不知道哪個版本是綠的,不是沒有好版本)。
 * 同一條分支蓋過好幾次只有一個檔(後蓋的蓋掉前面的);萬一不只一顆,認最晚蓋的,不看檔名排序。
 * @param takeover lib/origin.mjs 的 takeoverOf();沒換過人(none／unknown)就只看資料夾與分支
 */
export function checkpointFor({ dir, project, root, branch, takeover = null }) {
  return stampsIn(dir, project).filter((cp) => cp.worktree === root && cp.branch === branch && !stampedBefore(cp, takeover)).at(-1) ?? null;
}

/** 換人之前,這個資料夾最後一顆章:上一手的頁面拿它當那個對話自己那一輪的分界(AC-5)。沒換過人、或之前沒蓋過 → null。 */
export function stampBefore({ dir, project, root, takeover }) {
  if (takeover?.state !== 'ok') return null;
  return stampsIn(dir, project).filter((cp) => cp.worktree === root && stampedBefore(cp, takeover)).at(-1) ?? null;
}

/** 資料夾已經不在了:分支問不到,還講得出的只剩它最後蓋的那一顆。 */
export function lastStampOf(dir, project, root) {
  return stampsIn(dir, project).filter((cp) => cp.worktree === root).at(-1) ?? null;
}

/** ⚠️ 跟感測器刻意相反:寫不進去要大聲(pipeline-status 的規格 AC-6)——錯誤丟出去,呼叫端照實說「你沒有還原點」。 */
export function writeCheckpoint(dir, ctx, data) {
  makeDataDir(dir);   // 新建的家只給自己讀寫(規格:紀錄搬到固定的家 AC-6)
  writeFileSync(checkpointFile(dir, ctx.project, ctx.branch), JSON.stringify(data, null, 2));
}
