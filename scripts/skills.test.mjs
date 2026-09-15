/**
 * skills.test.mjs —— plugin 帶的三關指令(skills/spec、cleanup、chaos-check)。規格:docs/進行中/通用三關.md
 *
 * 釘三件會安靜說謊的事:
 *   ① stages.json 說這一關有 skill,plugin 卻沒帶 → 別的專案這一關永遠「找不到這個指令」(老毛病 P2:兩份清單各說各話)
 *   ② SKILL.md 指向 TutorPod 的路徑 → 「通用版」其實綁著另一個專案(老毛病 P4:抓指向,不抓提到)
 *   ③ 讀取端找不找得到 plugin 帶的 skill → 五關從「找不到這個指令」變成「這一輪還沒跑」靠的就是這條
 */
import { existsSync, readFileSync, readdirSync, mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { section, check, eq, summary, makeRepo } from './_harness.mjs';
import { skillAvailable } from '../lib/skills.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = join(ROOT, 'skills');
const PLUGIN = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).name;
// 內建關卡裡每一個有 skill 的關——清單只住 stages.json,這裡不准另外列一份
const stages = JSON.parse(readFileSync(join(ROOT, 'stages.json'), 'utf8')).stages.filter((s) => s.skill);

/** 只讀最上面那段 `--- … ---`,一行一個鍵。夠用就好,不引入 YAML 相依。 */
function frontmatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

section('stages.json 每一個有 skill 的關,plugin 都帶了對應的 SKILL.md', 'P2');
check('內建關卡裡至少有一關是 skill 關(不然這一段什麼都沒釘)', stages.length > 0);
for (const s of stages) {
  const file = join(SKILLS, s.skill, 'SKILL.md');
  check(`${s.id} ${s.name} → skills/${s.skill}/SKILL.md 存在`, existsSync(file), '別的專案這一關會永遠「找不到這個指令」');
  if (!existsSync(file)) continue;
  const fm = frontmatter(readFileSync(file, 'utf8'));
  check(`skills/${s.skill}: 有 frontmatter`, fm !== null);
  check(`skills/${s.skill}: description 不是空的`, !!fm?.description, 'Claude Code 靠 description 決定什麼時候用它');
  eq(`skills/${s.skill}: name 跟資料夾同名(叫法才穩定:/${PLUGIN}:${s.skill})`, fm?.name, s.skill);
}

/** 「指向」的形狀:名字後面直接接路徑分隔(中間可以隔著 ASCII 的資料夾名,例如「TutorPod AI v4」再接斜線),
 *  或 ai-english-course 後面接斜線。中文、括號、「空白再斜線」都不算——那是「提到」,提到是好事。 */
const POINTS_AT = [
  /ai-english-course\//i,
  /TutorPod(?:[A-Za-z0-9 ._-]*[A-Za-z0-9._-])?\//,
];
section('SKILL.md 不准指向 TutorPod(提到沒關係,指向才有關係)', 'P4');
const offenders = [];
for (const dir of readdirSync(SKILLS)) {
  const file = join(SKILLS, dir, 'SKILL.md');
  if (!existsSync(file)) continue;
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (POINTS_AT.some((re) => re.test(line))) offenders.push(`skills/${dir}/SKILL.md:${i + 1}  ${line.trim().slice(0, 90)}`);
  });
}
check('沒有任何 SKILL.md 指向 TutorPod／ai-english-course', offenders.length === 0, offenders.join('\n      '));
// 反向:抓得到真的、放得過假的(L10:沒有反向測試的檢查只是會週期性亂叫的裝飾品)。
// ⚠️ 例子用拼接寫——independence.test.mjs 掃的就是「引號裡的 TutorPod 路徑」,寫成一整串它會把這支測試自己當成違規。
const hit = (s) => POINTS_AT.some((re) => re.test(s));
check('一條寫死的絕對路徑會被抓到', hit('/Users/x/Desktop/' + 'Tutor' + 'Pod AI/v4/thing'));
check('一條相對路徑會被抓到', hit('ai-english-' + 'course/docs/x.md'));
check('提到「TutorPod 版」不算違規', !hit('這是 TutorPod 版的通用版'));
check('提到「TutorPod 的 spec」不算違規(斜線前面隔著空白與中文)', !hit('TutorPod 的 ' + '/spec 是它自己的'));

section('讀取端找得到 plugin 帶的 skill:五關才會從「找不到這個指令」變成「這一輪還沒跑」');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });   // 一個沒有任何 .claude/commands 的專案
  const home = mkdtempSync(join(tmpdir(), 'pm-home-'));   // 假 home:這台機器真的裝了什麼不能影響結果
  eq('空的 home:找不到(false,不是 null——B 那種沒有指令的關才是 null)', skillAvailable('spec', r.dir, null, home).found, false);
  mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
  symlinkSync(ROOT, join(home, '.claude', 'skills', PLUGIN));   // 跟 --install 放的一樣:捷徑指向這個 repo
  for (const s of stages) {
    const av = skillAvailable(s.skill, r.dir, null, home);
    check(`裝了 plugin → /${s.skill} 找得到`, av.found === true, `where: ${av.where}`);
  }
  rmSync(home, { recursive: true, force: true });
  r.cleanup();
}

process.exit(summary());
