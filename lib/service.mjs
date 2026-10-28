/**
 * service.mjs —— 儀表板的背景服務(macOS launchd)
 *
 * ⚠️ 2026-09-15 Oscar:「儀表板一段時間就斷線」。原因:它一直是某個對話的「預覽」開的,對話一停它就停。
 *    一個要放在第二個螢幕一直開著的東西,不該靠任何對話活著。所以裝成 launchd agent:
 *    開機自動起、掛了自動重啟(KeepAlive)、不需要開任何對話。
 *
 * 規矩:
 *   - 只寫 ~/Library/LaunchAgents 底下自己那一個 plist,拆的時候也只拆它。
 *   - 裝完不准宣稱「好了」——要真的去敲 http://127.0.0.1:4319 看它回不回應(R1)。
 *   - 服務跑的是**主資料夾**的 server.mjs;更新程式之後要 --serve-restart,它才會跑新的(這句要印出來)。
 */
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { codeHome } from './paths.mjs';

export const LABEL = 'com.pipeline-monitor.dashboard';
const PORT = Number(process.env.PIPELINE_MONITOR_PORT ?? 4319);
export const URL = `http://127.0.0.1:${PORT}/`;
const plistPath = (home = homedir()) => join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
const logPath = (home = homedir()) => join(home, 'Library', 'Logs', 'pipeline-monitor', 'dashboard.log');
const domain = () => `gui/${process.getuid()}`;

const xmlEsc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** plist 的內容。純函式,測試釘住:路徑要進去、KeepAlive 要開、特殊字元要跳脫。 */
export function plistXml({ node, script, cwd, log, path, port }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array><string>${xmlEsc(node)}</string><string>${xmlEsc(script)}</string></array>
  <key>WorkingDirectory</key><string>${xmlEsc(cwd)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>${xmlEsc(path)}</string>
    <key>PIPELINE_MONITOR_PORT</key><string>${port}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xmlEsc(log)}</string>
  <key>StandardErrorPath</key><string>${xmlEsc(log)}</string>
</dict>
</plist>
`;
}

function lc(args) {
  try { return { ok: true, out: execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { ok: false, out: String(e.stderr ?? e.message).trim() }; }
}
const isLoaded = () => lc(['print', `${domain()}/${LABEL}`]).ok;

/** 儀表板回不回應——「活著」只有這一種證據。
 *  ⚠️ 敲首頁,不敲 /api/status:後者要跑一堆 git,實測 2 秒多,拿它當活著的證據會把活的說成死的(2026-09-15 裝完當場踩到)。 */
async function answering(ms = 3000) {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), ms);
    const r = await fetch(URL, { signal: c.signal });
    clearTimeout(t);
    return r.ok;
  } catch { return false; }
}
async function waitAlive(tries = 12) {
  for (let i = 0; i < tries; i++) {
    if (await answering()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export async function installService() {
  const out = [];
  const home = codeHome(dirname(dirname(fileURLToPath(import.meta.url))));
  const plist = plistPath(), log = logPath();
  mkdirSync(dirname(plist), { recursive: true });
  mkdirSync(dirname(log), { recursive: true });
  // launchd 的 PATH 很短,node 與 git 要找得到。只放固定的幾個地方,不抄這個 shell 那一串(裡面有對話專屬的路徑)
  const path = [...new Set([dirname(process.execPath), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
  if (isLoaded()) lc(['bootout', `${domain()}/${LABEL}`]);
  writeFileSync(plist, plistXml({ node: process.execPath, script: join(home, 'server.mjs'), cwd: home, log, path, port: PORT }));
  const r = lc(['bootstrap', domain(), plist]);
  if (!r.ok) { out.push(`❌ 背景服務沒起來：${r.out}`, `   設定檔在 ${plist}`); return { ok: false, out }; }
  out.push(`✅ 背景服務裝好了：${plist}`);
  const alive = await waitAlive();
  if (alive) out.push(`   儀表板在 ${URL} 回應了。開機會自動起、掛了會自動重啟,不靠任何對話活著。`);
  else {
    out.push(`   ⚠️ 服務載入了,但 ${URL} 還沒回應——我不能說它好了。`);
    out.push(`   看它自己說了什麼：${log}`);
    out.push(`   常見原因：${PORT} 已經有人在用（你自己 npm start 開的、或某個對話的預覽）。先關掉那一個,它每 10 秒會再試。`);
  }
  out.push('   ⚠️ 之後更新程式（git pull／merge）要 pipeline-status --serve-restart,它才會跑新的。');
  return { ok: true, out, alive };
}

export function uninstallService() {
  const plist = plistPath();
  if (!existsSync(plist)) return { ok: true, out: ['本來就沒裝背景服務。'] };
  lc(['bootout', `${domain()}/${LABEL}`]);
  rmSync(plist, { force: true });
  return { ok: true, out: [`✅ 拆掉了背景服務（${plist}）。紀錄與還原點都還在。`] };
}

export async function restartService() {
  if (!existsSync(plistPath())) return { ok: false, out: ['沒裝背景服務。裝：pipeline-status --serve-install'] };
  const r = lc(['kickstart', '-k', `${domain()}/${LABEL}`]);
  if (!r.ok) return { ok: false, out: [`❌ 重啟失敗：${r.out}`] };
  const alive = await waitAlive();
  // 開著的分頁跑的是它載入那一刻的畫面程式。新版的畫面會發現換版自己重新載入;更舊的分頁沒有這段,要手動重新整理一次(魔鬼教官 2026-09-21)
  return { ok: alive, out: alive ? [`✅ 重啟了,${URL} 回應中。`, '   開著的儀表板分頁如果還是舊的樣子,重新整理一次。'] : [`⚠️ 重啟了,但 ${URL} 還沒回應。看 ${logPath()}`] };
}

/** 三件事分開講:裝了沒(plist)、載入了沒(launchd)、活著沒(回應)。不折成一個「正常」。 */
export async function describeService() {
  const installed = existsSync(plistPath()), loaded = installed && isLoaded(), alive = await answering();
  const out = [];
  if (!installed) out.push(`背景服務：沒裝。${alive ? `但 ${URL} 有人在回應（應該是 npm start 或某個對話的預覽開的——那個一關就沒了）。` : '裝：pipeline-status --serve-install'}`);
  else if (!loaded) out.push(`背景服務：設定檔在（${plistPath()}）,但 launchd 沒載入它。重裝：pipeline-status --serve-install`);
  else if (!alive) out.push(`背景服務：載入了,但 ${URL} 沒回應。看 ${logPath()}`);
  else out.push(`背景服務：活著,${URL}`);
  return { ok: installed && loaded && alive, out };
}

export async function openDashboard() {
  if (!(await answering())) {
    return { ok: false, out: [`${URL} 沒有回應,打開也是空的。`, '裝成背景服務：pipeline-status --serve-install   （或在 pipeline-monitor 資料夾 npm start）'] };
  }
  try { execFileSync('open', [URL], { stdio: 'ignore' }); return { ok: true, out: [`打開了 ${URL}`] }; }
  catch { return { ok: false, out: [`打不開瀏覽器。自己開：${URL}`] }; }
}
