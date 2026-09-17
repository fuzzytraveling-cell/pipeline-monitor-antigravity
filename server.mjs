#!/usr/bin/env node
/**
 * server.mjs —— ③ 畫面的本機伺服器
 * 規格:pipeline-ui(路徑看 CLAUDE.md 的表)
 *
 * ⚠️ AC-7:只綁 127.0.0.1,而且**刻意不提供對外的開關**。
 *    這個畫面看得到你所有專案的路徑、分支、你打過的字。
 *    CCAM 出過一次「預設對整個區網開放」的漏洞——我們連那個選項都不做。
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { collectAll } from './lib/collect.mjs';
import { logFileOf } from './lib/events.mjs';
import { optIn, optOut } from './lib/mount.mjs';
import { monitorHome } from './lib/paths.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';          // ⚠️ 不要參數化。見上面。
// PORT 是給開發工具用的通用慣例(預覽伺服器會派一個空的埠);PIPELINE_MONITOR_PORT 優先。
const PORT = Number(process.env.PIPELINE_MONITOR_PORT ?? process.env.PORT ?? 4319);

const TYPES = { '.svg': 'image/svg+xml; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
                '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8' };

/** 只准送這幾個檔案。不做通用靜態檔伺服器——那會變成一條把整台機器讀出去的路。 */
const SERVE = {
  '/': join(HERE, 'ui', 'index.html'),
  '/app.js': join(HERE, 'ui', 'app.js'),
  '/ui.css': join(HERE, 'ui', 'ui.css'),
  // 畫面與測試共用同一份「資料多新」的判斷,不各寫一份(否則兩邊遲早不一致)
  '/freshness.mjs': join(HERE, 'lib', 'freshness.mjs'),
  // AC-9:設計數值只有一份,畫面直接吃那個檔,不抄一份進程式碼
  '/tokens.css': join(HERE, 'ui設計規格', 'variables.css'),
  '/agent.svg': join(HERE, 'public', 'agent.svg'),
};

/** 同源檢查:別的網站不准叫會寫東西的端點 */
function sameOrigin(req) {
  const origin = req.headers.origin;
  return !origin || /^http:\/\/(127\.0\.0\.1|localhost):/.test(origin);
}

/** 讀 POST 的內容,超過 4KB 就切斷——這裡收的都是幾十個字的 JSON */
function readBody(req, cb) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
  req.on('end', () => cb(body));
}

/** monitorDir 可以注入,測試才能在自己的暫存資料夾裡跑;預設就是這個資料夾。 */
export function createApp({ monitorDir = HERE } = {}) {
  // 跟 hook.sh／status.mjs／collect.mjs 看同一個地方(同一個環境變數),寫的跟讀的才是同一份(老毛病 P2)。
  // 跟著 monitorDir 走,測試才能在自己的暫存資料夾裡寫,不會碰到真的紀錄。
  const LOG_DIR = process.env.PIPELINE_MONITOR_LOG_DIR ?? join(monitorHome(monitorDir), 'logs');
  return createServer((req, res) => {
    const url = new URL(req.url, `http://${HOST}`);
    const json = (code, obj) => { res.writeHead(code, TYPES['.json']); res.end(JSON.stringify(obj)); };

    if (url.pathname === '/api/status') {
      let body;
      try {
        body = JSON.stringify(collectAll({ monitorDir }));
      } catch (e) {
        // ⚠️ 一個專案讀不到,不該害整頁掛掉。照實回報,讓畫面說「讀不到」。
        return json(500, { error: String(e?.message ?? e), generatedAt: Date.now() });
      }
      res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' });
      return res.end(body);
    }

    // 結案:把「這個對話做完了」記成一筆事件。
    // ⚠️ 這是網頁能寫入的兩個動作之一,而且它是 append-only——
    //    它不刪任何東西,只是多記一行「Oscar 在某時說這個對話結束了」。
    //    真正會刪東西的事(reset/commit/push)一律只給指令,不代跑。
    if (url.pathname === '/api/close' && req.method === 'POST') {
      if (!sameOrigin(req)) return json(403, { error: 'cross-origin' });
      readBody(req, (body) => {
        try {
          const { project, session, cwd, undo } = JSON.parse(body || '{}');
          if (!project || !session) throw new Error('缺 project 或 session');
          // 檔名走 logFileOf(safeName):跟感測器寫的同一個檔;順便把 project 裡的斜線洗掉,
          // 這個端點就不可能被拿來往 logs/ 以外的地方寫東西。
          mkdirSync(LOG_DIR, { recursive: true });
          appendFileSync(logFileOf(LOG_DIR, project), JSON.stringify({
            ts: new Date().toISOString(),
            event: undo ? 'session_reopened' : 'session_closed',
            session, cwd: cwd ?? null, source: 'human',
          }) + '\n');
          json(200, { ok: true });
        } catch (e) {
          json(400, { error: String(e?.message ?? e) });
        }
      });
      return;
    }

    // 調高分級／收回:記一行「你說這次算 T2,因為…」(source:'human'),跟結案同一種 append-only 紀錄。
    // ⚠️ 只准對儀表板列得出來的工作區;只准調到 upgradable 裡的等級(比機器算的高);理由必填——
    //    沒理由的調高跟誤按分不出來,而畫面就是要把理由印給以後的你看。
    if (url.pathname === '/api/tier' && req.method === 'POST') {
      if (!sameOrigin(req)) return json(403, { error: 'cross-origin' });
      readBody(req, (body) => {
        try {
          const { project, cwd, level, why, retract } = JSON.parse(body || '{}');
          const p = collectAll({ monitorDir }).projects.find((x) => x.name === project);
          const card = p?.cards.find((c) => c.path === cwd && !c.gone && !c.notGit);
          if (!card) throw new Error('不認識這個工作區');
          const t = card.tier;
          if (retract) {
            if (!t?.manual) throw new Error('沒有你調高的等級可以收回');
          } else {
            if (!String(why ?? '').trim()) throw new Error('理由必填');
            if (!t?.upgradable?.includes(level)) throw new Error('只能調到比機器算的高的等級');
          }
          mkdirSync(LOG_DIR, { recursive: true });
          appendFileSync(logFileOf(LOG_DIR, project), JSON.stringify({
            ts: new Date().toISOString(),
            event: retract ? 'tier_retracted' : 'tier_set',
            ...(retract ? {} : { level, why: String(why).trim().slice(0, 200) }),
            cwd, head: card.head ?? null, source: 'human',
          }) + '\n');
          json(200, { ok: true });
        } catch (e) {
          json(400, { error: String(e?.message ?? e) });
        }
      });
      return;
    }

    // 「你說處理完了」／「你說驗收過了」:跟 CLI 的 --clear 同一種紀錄(stage_cleared,source:human)。
    // ⚠️ 只准對儀表板認識的工作區、只准那個工作區關卡清單裡有的關。這是人蓋的章,畫面會照實寫「你說的」。
    if (url.pathname === '/api/clear' && req.method === 'POST') {
      if (!sameOrigin(req)) return json(403, { error: 'cross-origin' });
      readBody(req, (body) => {
        try {
          const { project, cwd, stage } = JSON.parse(body || '{}');
          const p = collectAll({ monitorDir }).projects.find((x) => x.name === project);
          const card = p?.cards.find((c) => c.path === cwd && !c.gone && !c.notGit);
          if (!card) throw new Error('不認識這個工作區');
          const st = card.stages?.find((s) => s.id === stage && s.state !== 'main' && s.state !== 'notbuilt');
          if (!st) throw new Error('不認識這一關');
          // 只有驗收那一關由人說;其他關由儀表板自動辨識,按鈕拿掉了(五關自動結案 AC-10)
          if (st.type !== 'browser') throw new Error('這一關由儀表板自動辨識,不用你按;只有驗收由你說');
          mkdirSync(LOG_DIR, { recursive: true });
          appendFileSync(logFileOf(LOG_DIR, project), JSON.stringify({
            ts: new Date().toISOString(), event: 'stage_cleared', stage: st.id, cwd, head: card.head ?? null, source: 'human',
          }) + '\n');
          json(200, { ok: true });
        } catch (e) {
          json(400, { error: String(e?.message ?? e) });
        }
      });
      return;
    }

    // 「不做了」:把 Claude 建議的對話劃掉。append-only,紀錄還在
    if (url.pathname === '/api/suggest-dismiss' && req.method === 'POST') {
      if (!sameOrigin(req)) return json(403, { error: 'cross-origin' });
      readBody(req, (body) => {
        try {
          const { project, id } = JSON.parse(body || '{}');
          const p = collectAll({ monitorDir }).projects.find((x) => x.name === project);
          if (!p?.suggestions?.some((s) => s.id === id)) throw new Error('不認識這張建議');
          mkdirSync(LOG_DIR, { recursive: true });
          appendFileSync(logFileOf(LOG_DIR, project), JSON.stringify({ ts: new Date().toISOString(), event: 'suggestion_dismissed', id, source: 'human' }) + '\n');
          json(200, { ok: true });
        } catch (e) {
          json(400, { error: String(e?.message ?? e) });
        }
      });
      return;
    }

    // 退出記錄／重新加入:在那個專案的主資料夾放（或拿掉）.claude/pipeline-monitor.off。
    // ⚠️ root 是瀏覽器送來的字串,**不能直接拿來當路徑寫檔**——只准對「儀表板現在列得出來的專案」動手。
    //    這是網頁唯一會碰到別的專案資料夾的動作,而它只放一個記號檔,不動任何其他東西。
    if (url.pathname === '/api/optout' && req.method === 'POST') {
      if (!sameOrigin(req)) return json(403, { error: 'cross-origin' });
      readBody(req, (body) => {
        try {
          const { root, undo } = JSON.parse(body || '{}');
          const known = collectAll({ monitorDir }).projects.map((p) => p.mainRoot).filter(Boolean);
          if (!root || !known.includes(root)) throw new Error('不認識這個專案');
          json(200, undo ? { ok: true, removed: optIn(root) } : { ok: true, marker: optOut(root, 'dashboard') });
        } catch (e) {
          json(400, { error: String(e?.message ?? e) });
        }
      });
      return;
    }

    const file = SERVE[url.pathname];
    if (!file || !existsSync(file)) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('沒有這個位址');
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'text/plain', 'cache-control': 'no-store' });
    res.end(readFileSync(file));
  });
}

// 兩邊都解析成真實路徑再比(L1／E1:路徑有空白、透過捷徑執行,字串直接比會永遠 false 而安靜地什麼都不做)
function isMain() {
  try { return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1] ?? ''); } catch { return false; }
}
if (isMain()) {
  const app = createApp();
  // ⚠️ 埠被佔走要講人話再退出——launchd 會每 10 秒再試,看紀錄檔的人要看得懂它為什麼一直起不來
  app.on('error', (e) => {
    if (e?.code === 'EADDRINUSE') {
      console.error(`${PORT} 已經有人在用（你自己 npm start 開的、或背景服務已經在跑）。先關掉那一個,或用 PIPELINE_MONITOR_PORT 換一個埠。`);
      process.exit(1);
    }
    throw e;
  });
  app.listen(PORT, HOST, () => {
    console.log(`產線監視器：http://${HOST}:${PORT}`);
    console.log('（只有這台電腦連得到。Ctrl+C 結束。）');
  });
}
