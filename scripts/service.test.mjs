/**
 * service.test.mjs —— 背景服務只釘 plist 的內容與預設值（純函式）。launchctl 不在測試裡跑：它會動真的系統。
 */
import process from 'node:process';
import { plistXml, LABEL, URL } from '../lib/service.mjs';
import { section, check, eq, summary } from './_harness.mjs';

section('Antigravity 版背景服務常數與原版完全隔離');
{
  eq('Label 是 com.pipeline-monitor-agy.dashboard（不與原版衝突）', LABEL, 'com.pipeline-monitor-agy.dashboard');
  eq('預設網址是 http://127.0.0.1:4320/（不與原版 4319 衝突）', URL, 'http://127.0.0.1:4320/');
}

section('launchd 的 plist：路徑要進去、KeepAlive 要開、特殊字元要跳脫');
{
  const xml = plistXml({ node: '/usr/local/bin/node', script: '/Users/o/Desktop/pipeline-monitor for antigravty/server.mjs',
    cwd: '/Users/o/Desktop/pipeline-monitor for antigravty', log: '/Users/o/Library/Logs/pipeline-monitor-agy/dashboard.log', path: '/usr/local/bin:/usr/bin', port: 4320 });
  check('有 Label', xml.includes(`<string>${LABEL}</string>`));
  check('node 與 server.mjs 都在 ProgramArguments', xml.includes('<string>/usr/local/bin/node</string>') && xml.includes('server.mjs</string>'));
  check('KeepAlive 與 RunAtLoad 都開', xml.includes('<key>KeepAlive</key><true/>') && xml.includes('<key>RunAtLoad</key><true/>'));
  check('PATH 有寫進去（launchd 的 PATH 很短，不寫 node/git 會找不到）', xml.includes('<key>PATH</key><string>/usr/local/bin:/usr/bin</string>'));
  eq('埠寫進 AGY_PIPELINE_PORT 環境變數', xml.includes('<key>AGY_PIPELINE_PORT</key><string>4320</string>'), true);
  const weird = plistXml({ node: '/n', script: '/a & b/<x>.mjs', cwd: '/a & b', log: '/l', path: '/p', port: 1 });
  check('& 與 < > 有跳脫（不然 plist 讀不懂，服務安靜地起不來）', weird.includes('/a &amp; b/&lt;x&gt;.mjs') && !weird.includes('& b/<x>'));
}

process.exit(summary());
