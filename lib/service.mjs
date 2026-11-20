/**
 * service.mjs —— 儀表板的背景服務（macOS launchd，Antigravity 專用版）
 *
 * 與原版完全隔離：
 *   - Label: com.pipeline-monitor-agy.dashboard
 *   - 預設埠：4320（AGY_PIPELINE_PORT）
 *   - Log:   ~/Library/Logs/pipeline-monitor-agy/dashboard.log
 *
 * 規矩：
 *   - 只寫 ~/Library/LaunchAgents 底下自己那一個 plist，拆的時候也只拆它。
 *   - 裝完不准宣稱「好了」——要真的去敲 http://127.0.0.1:4320 看它回不回應（R1）。
 *   - 服務跑的是主資料夾的 server.mjs；更新程式之後要 agy-pipeline --serve-restart。
 */
import { writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { codeHome } from './paths.mjs';
import { zhEn } from './lang.mjs';

export const LABEL = 'com.pipeline-monitor-agy.dashboard';
const PORT = Number(process.env.AGY_PIPELINE_PORT ?? 4320);
export const URL = `http://127.0.0.1:${PORT}/`;
const plistPath = (home = homedir()) => join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
const logPath = (home = homedir()) => join(home, 'Library', 'Logs', 'pipeline-monitor-agy', 'dashboard.log');
const domain = () => `gui/${process.getuid()}`;

const xmlEsc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/** plist 的內容。純函式，測試釘住：路徑要進去、KeepAlive 要開、特殊字元要跳脫。 */
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
    <key>AGY_PIPELINE_PORT</key><string>${port}</string>
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

/** 儀表板回不回應——「活著」只有這一種證據（敲首頁，不敲 /api/status）。 */
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
  const path = [...new Set([dirname(process.execPath), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
  try {
    mkdirSync(dirname(plist), { recursive: true });
    mkdirSync(dirname(log), { recursive: true });
    if (isLoaded()) lc(['bootout', `${domain()}/${LABEL}`]);
    writeFileSync(plist, plistXml({ node: process.execPath, script: join(home, 'server.mjs'), cwd: home, log, path, port: PORT }));
  } catch (e) {
    if (e?.code === 'EACCES' || e?.code === 'EPERM') {
      const p = typeof e.path === 'string' ? e.path : dirname(plist);
      out.push(zhEn(`❌ 寫不進 ${p}（沒有權限或受沙盒限制）。`, `❌ Couldn't write to ${p} (no permission or blocked by sandbox).`));
      out.push(zhEn('   請改在自己的終端機執行：agy-pipeline --serve-install', '   Run in your own terminal: agy-pipeline --serve-install'));
      return { ok: false, out };
    }
    throw e;
  }
  const r = lc(['bootstrap', domain(), plist]);
  if (!r.ok) { out.push(zhEn(`❌ 背景服務沒起來：${r.out}`, `❌ The background service didn't start: ${r.out}`), zhEn(`   設定檔在 ${plist}`, `   The settings file is at ${plist}`)); return { ok: false, out }; }
  out.push(zhEn(`✅ 背景服務裝好了：${plist}`, `✅ Background service installed: ${plist}`));
  const alive = await waitAlive();
  if (alive) out.push(zhEn(`   儀表板在 ${URL} 回應了。開機會自動起、掛了會自動重啟,不靠任何對話活著。`, `   The dashboard answered at ${URL}. It starts at boot and restarts if it crashes, without depending on any conversation.`));
  else {
    out.push(zhEn(`   ⚠️ 服務載入了,但 ${URL} 還沒回應——我不能說它好了。`, `   ⚠️ The service is loaded, but ${URL} hasn't answered yet, so I can't say it works.`));
    out.push(zhEn(`   看它自己說了什麼：${log}`, `   See what it said itself: ${log}`));
    out.push(zhEn(`   常見原因：${PORT} 已經有人在用（你自己 npm start 開的、或某個對話的預覽）。先關掉那一個,它每 10 秒會再試。`,
      `   A common cause: port ${PORT} is already taken (by an npm start you ran, or a conversation's preview). Close that one first; it retries every 10 seconds.`));
  }
  out.push(zhEn('   ⚠️ 之後更新程式（git pull／merge）要 agy-pipeline --serve-restart,它才會跑新的。', '   ⚠️ After updating the program (git pull/merge), run agy-pipeline --serve-restart so it runs the new one.'));
  return { ok: true, out, alive };
}

export function uninstallService() {
  const plist = plistPath();
  if (!existsSync(plist)) return { ok: true, out: [zhEn('本來就沒裝背景服務。', 'The background service wasn\'t installed in the first place.')] };
  lc(['bootout', `${domain()}/${LABEL}`]);
  try {
    rmSync(plist, { force: true });
  } catch (e) {
    if (e?.code === 'EACCES' || e?.code === 'EPERM') {
      return { ok: false, out: [
        zhEn(`❌ 沒有權限移除 ${plist}（請改在自己的終端機執行：agy-pipeline --serve-uninstall）。`,
          `❌ No permission to remove ${plist} (run in your own terminal: agy-pipeline --serve-uninstall).`),
      ] };
    }
    throw e;
  }
  return { ok: true, out: [zhEn(`✅ 拆掉了背景服務（${plist}）。紀錄與還原點都還在。`, `✅ Removed the background service (${plist}). The records and restore points are still there.`)] };
}

export async function restartService() {
  if (!existsSync(plistPath())) return { ok: false, out: [zhEn('沒裝背景服務。裝：agy-pipeline --serve-install', 'The background service isn\'t installed. To install: agy-pipeline --serve-install')] };
  const r = lc(['kickstart', '-k', `${domain()}/${LABEL}`]);
  if (!r.ok) return { ok: false, out: [zhEn(`❌ 重啟失敗：${r.out}`, `❌ The restart failed: ${r.out}`)] };
  const alive = await waitAlive();
  return { ok: alive, out: alive ? [zhEn(`✅ 重啟了,${URL} 回應中。`, `✅ Restarted; ${URL} is answering.`), zhEn('   開著的儀表板分頁如果還是舊的樣子,重新整理一次。', '   If an open dashboard tab still looks old, reload it once.')]
    : [zhEn(`⚠️ 重啟了,但 ${URL} 還沒回應。看 ${logPath()}`, `⚠️ Restarted, but ${URL} hasn't answered yet. See ${logPath()}`)] };
}

/** 三件事分開講：裝了沒（plist）、載入了沒（launchd）、活著沒（回應）。不折成一個「正常」。 */
export async function describeService() {
  const installed = existsSync(plistPath()), loaded = installed && isLoaded(), alive = await answering();
  const out = [];
  if (!installed) {
    out.push(zhEn(`背景服務：沒裝。${alive ? `但 ${URL} 有人在回應（應該是 npm start 或某個對話的預覽開的——那個一關就沒了）。` : '裝：agy-pipeline --serve-install'}`,
      `Background service: not installed. ${alive ? `But something is answering at ${URL} (probably an npm start or a conversation's preview, which goes away when closed).` : 'To install: agy-pipeline --serve-install'}`));
  } else if (!loaded) out.push(zhEn(`背景服務：設定檔在（${plistPath()}）,但 launchd 沒載入它。重裝：agy-pipeline --serve-install`, `Background service: the settings file is there (${plistPath()}), but launchd hasn't loaded it. To reinstall: agy-pipeline --serve-install`));
  else if (!alive) out.push(zhEn(`背景服務：載入了,但 ${URL} 沒回應。看 ${logPath()}`, `Background service: loaded, but ${URL} isn't answering. See ${logPath()}`));
  else out.push(zhEn(`背景服務：活著,${URL}`, `Background service: alive, ${URL}`));
  return { ok: installed && loaded && alive, out };
}

export async function openDashboard() {
  if (!(await answering())) {
    return { ok: false, out: [zhEn(`${URL} 沒有回應,打開也是空的。`, `${URL} isn't answering, so opening it would show nothing.`),
      zhEn('裝成背景服務：agy-pipeline --serve-install   （或在專案資料夾 npm start）', 'Install it as a background service: agy-pipeline --serve-install   (or npm start in the project folder)')] };
  }
  try { execFileSync('open', [URL], { stdio: 'ignore' }); return { ok: true, out: [zhEn(`打開了 ${URL}`, `Opened ${URL}`)] }; }
  catch { return { ok: false, out: [zhEn(`打不開瀏覽器。自己開：${URL}`, `Couldn't open a browser. Open it yourself: ${URL}`)] }; }
}
