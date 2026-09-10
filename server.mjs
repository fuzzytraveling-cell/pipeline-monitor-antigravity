#!/usr/bin/env node
/**
 * server.mjs —— ③ 畫面的本機伺服器
 * 規格:docs/進行中/pipeline-ui.md
 *
 * ⚠️ AC-7:只綁 127.0.0.1,而且**刻意不提供對外的開關**。
 *    這個畫面看得到你所有專案的路徑、分支、你打過的字。
 *    CCAM 出過一次「預設對整個區網開放」的漏洞——我們連那個選項都不做。
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { collectAll } from './lib/collect.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOST = '127.0.0.1';          // ⚠️ 不要參數化。見上面。
const PORT = Number(process.env.PIPELINE_MONITOR_PORT ?? 4319);

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

export function createApp() {
  return createServer((req, res) => {
    const url = new URL(req.url, `http://${HOST}`);

    if (url.pathname === '/api/status') {
      let body;
      try {
        body = JSON.stringify(collectAll({ monitorDir: HERE }));
      } catch (e) {
        // ⚠️ 一個專案讀不到,不該害整頁掛掉。照實回報,讓畫面說「讀不到」。
        res.writeHead(500, TYPES['.json']);
        return res.end(JSON.stringify({ error: String(e?.message ?? e), generatedAt: Date.now() }));
      }
      res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' });
      return res.end(body);
    }

    // 結案:把「這個對話做完了」記成一筆事件。
    // ⚠️ 這是**唯一**一個網頁能寫入的動作,而且它是 append-only——
    //    它不刪任何東西,只是多記一行「Oscar 在某時說這個對話結束了」。
    //    真正會刪東西的事(reset/commit/push)一律只給指令,不代跑。
    if (url.pathname === '/api/close' && req.method === 'POST') {
      // 同源檢查:別的網站不准叫這個
      const origin = req.headers.origin;
      if (origin && !/^http:\/\/(127\.0\.0\.1|localhost):/.test(origin)) {
        res.writeHead(403, TYPES['.json']);
        return res.end(JSON.stringify({ error: 'cross-origin' }));
      }
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
      req.on('end', () => {
        try {
          const { project, session, cwd, undo } = JSON.parse(body || '{}');
          if (!project || !session) throw new Error('缺 project 或 session');
          mkdirSync(join(HERE, 'logs'), { recursive: true });
          appendFileSync(join(HERE, 'logs', `${project}.jsonl`), JSON.stringify({
            ts: new Date().toISOString(),
            event: undo ? 'session_reopened' : 'session_closed',
            session, cwd: cwd ?? null, source: 'human',
          }) + '\n');
          res.writeHead(200, TYPES['.json']); res.end(JSON.stringify({ ok: true }));
        } catch (e) {
          res.writeHead(400, TYPES['.json']);
          res.end(JSON.stringify({ error: String(e?.message ?? e) }));
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

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  createApp().listen(PORT, HOST, () => {
    console.log(`產線監視器：http://${HOST}:${PORT}`);
    console.log('（只有這台電腦連得到。Ctrl+C 結束。）');
  });
}
