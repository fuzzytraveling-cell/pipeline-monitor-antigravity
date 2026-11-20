/**
 * skills.mjs —— 這一關的技能（spec／cleanup／chaos-check／verify）在這個專案裡有沒有
 *
 * Antigravity 搜尋順序：
 *   1. 專案（與主資料夾）的 .agents/skills/<skill>/SKILL.md、.agent/skills/<skill>/SKILL.md
 *   2. 舊專案相容：.claude/skills/<skill>/SKILL.md、.claude/commands/<skill>.md
 *   3. 使用者層級：~/.gemini/config/skills/<skill>/SKILL.md、~/.gemini/config/plugins/<plugin>/skills/<skill>/SKILL.md
 *
 * 找到代表「檔案在」，不是「Antigravity 載入了」——後者要下一個回合才知道。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function skillAvailable(skill, root, mainRoot = null, home = homedir()) {
  if (!skill) return { found: null, where: null };
  const places = [];
  for (const d of new Set([root, mainRoot].filter(Boolean))) {
    places.push(
      join(d, '.agents', 'skills', skill, 'SKILL.md'),
      join(d, '.agent', 'skills', skill, 'SKILL.md'),
      join(d, '.claude', 'skills', skill, 'SKILL.md'),
      join(d, '.claude', 'commands', `${skill}.md`),
    );
  }
  places.push(join(home, '.gemini', 'config', 'skills', skill, 'SKILL.md'));
  let plugins = [];
  try { plugins = readdirSync(join(home, '.gemini', 'config', 'plugins')); } catch { plugins = []; }
  for (const p of plugins) {
    places.push(join(home, '.gemini', 'config', 'plugins', p, 'skills', skill, 'SKILL.md'));
  }
  const hit = places.find((p) => existsSync(p));
  return { found: !!hit, where: hit ?? null };
}

/**
 * 這一關要叫哪個指令：專案自己有就叫 /<skill>，plugin 有也叫 /<skill>（或說明讀技能）；
 * 兩邊都沒有回 null（要求不了）。收工門禁與 --spec 共用這一份（老毛病 P2）。
 */
export function commandFor(skill, root, mainRoot, plugin, home = homedir()) {
  if (!skill) return null;
  for (const d of new Set([root, mainRoot].filter(Boolean))) {
    if (
      existsSync(join(d, '.agents', 'skills', skill, 'SKILL.md'))
      || existsSync(join(d, '.agent', 'skills', skill, 'SKILL.md'))
      || existsSync(join(d, '.claude', 'skills', skill, 'SKILL.md'))
      || existsSync(join(d, '.claude', 'commands', `${skill}.md`))
    ) return `/${skill}`;
  }
  if (existsSync(join(home, '.gemini', 'config', 'skills', skill, 'SKILL.md'))) return `/${skill}`;
  if (plugin && existsSync(join(home, '.gemini', 'config', 'plugins', plugin, 'skills', skill, 'SKILL.md'))) return `/${plugin}:${skill}`;
  return skillAvailable(skill, root, mainRoot, home).found ? `/${skill}` : null;
}

/** plugin 叫什麼（根目錄 plugin.json 的 name）。讀不到就退回 agy-pipeline。 */
export function pluginName(monitorDir) {
  try { return JSON.parse(readFileSync(join(monitorDir, 'plugin.json'), 'utf8')).name || 'agy-pipeline'; } catch { return 'agy-pipeline'; }
}
