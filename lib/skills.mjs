/**
 * skills.mjs —— 這一關的指令(/spec 之類)在這個專案裡**有沒有**
 *
 * ⚠️ 2026-09-15 Oscar 問「My Agent work flow 什麼情況會觸發」——它不會觸發任何東西,它只看紀錄。
 *    A／C／D 是 TutorPod 自己的 slash command(.claude/commands/spec.md …),別的專案沒有這些檔案,
 *    那幾關就永遠「沒有紀錄」。畫面上「沒有紀錄」跟「這裡根本沒有這個指令」是兩件事,要分開講(R1)。
 * ⚠️ 2026-09-15 起 plugin 自己帶了通用版(skills/spec、cleanup、chaos-check,規格 通用三關,路徑看 CLAUDE.md 的表):
 *    裝了 plugin 的專案走最後那條「捷徑型 plugin」的路就找得到。找到的是「檔案在」,不是「Claude Code 載入了」——
 *    後者要新對話才知道,跟感測器一樣。
 *
 * 只看得到這幾個地方:專案(與主資料夾)的 .claude/commands、.claude/skills;帳號層級 ~/.claude 的同兩處;
 * 捷徑型 plugin(~/.claude/skills/<plugin>/skills|commands)。找不到只代表「這幾個地方沒有」,文案要照這樣講。
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function skillAvailable(skill, root, mainRoot = null, home = homedir()) {
  if (!skill) return { found: null, where: null };
  const places = [];
  for (const d of new Set([root, mainRoot].filter(Boolean))) {
    places.push(join(d, '.claude', 'commands', `${skill}.md`), join(d, '.claude', 'skills', skill, 'SKILL.md'));
  }
  places.push(join(home, '.claude', 'commands', `${skill}.md`), join(home, '.claude', 'skills', skill, 'SKILL.md'));
  let plugins = [];
  try { plugins = readdirSync(join(home, '.claude', 'skills')); } catch { plugins = []; }
  for (const p of plugins) {
    places.push(join(home, '.claude', 'skills', p, 'skills', skill, 'SKILL.md'), join(home, '.claude', 'skills', p, 'commands', `${skill}.md`));
  }
  const hit = places.find((p) => existsSync(p));
  return { found: !!hit, where: hit ?? null };
}

/**
 * 這一關要叫哪個指令:專案自己有同名指令就叫它的,沒有才叫 plugin 的;兩邊都沒有回 null(要求不了)。
 * 收工 hook(要 Claude 補跑哪一關)與 --spec(被擋下來時指路)共用這一份,不各寫一次(老毛病 P2)。
 * plugin 是 plugin.json 的名字(pluginName 讀)。
 */
export function commandFor(skill, root, mainRoot, plugin, home = homedir()) {
  if (!skill) return null;
  for (const d of new Set([root, mainRoot].filter(Boolean))) {
    if (existsSync(join(d, '.claude', 'commands', `${skill}.md`)) || existsSync(join(d, '.claude', 'skills', skill, 'SKILL.md'))) return `/${skill}`;
  }
  return skillAvailable(skill, root, mainRoot, home).found ? `/${plugin}:${skill}` : null;
}

/** plugin 叫什麼(.claude-plugin/plugin.json 的 name)。讀不到就用資料夾本來的名字——收工 hook 與 --spec 共用這一份。 */
export function pluginName(monitorDir) {
  try { return JSON.parse(readFileSync(join(monitorDir, '.claude-plugin', 'plugin.json'), 'utf8')).name || 'pipeline-monitor'; } catch { return 'pipeline-monitor'; }
}
