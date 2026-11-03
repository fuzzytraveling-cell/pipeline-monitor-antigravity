/**
 * skills.test.mjs —— plugin 帶的三關指令(skills/spec、cleanup、chaos-check)。規格:通用三關(路徑看 CLAUDE.md 的表)
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
import { termsTable, RED_LINES_EN, withLang } from '../lib/lang.mjs';
import { runMode } from '../lib/rounds.mjs';
import { noLevelOf } from '../lib/cliRerun.mjs';
import { CJK } from './_zhscan.mjs';

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


/* ════════════ 英文使用者叫得到、Claude 轉述不翻錯(規格:技能與寫給AI的話中英切換 AC-1、AC-2、AC-5) ════════════ */

const ALL = readdirSync(SKILLS).filter((d) => existsSync(join(SKILLS, d, 'SKILL.md')));
const textOf = (d) => readFileSync(join(SKILLS, d, 'SKILL.md'), 'utf8');
/** 說明裡有沒有英文的觸發句:英文寫在 "…" 裡、至少兩個字(write a spec)。中文那一段用「」,只有中文的說明裡的 ASCII(pipeline-monitor、/spec)不算 */
const englishTriggers = (desc) => [...String(desc ?? '').matchAll(/"([A-Za-z][A-Za-z'’ …-]*\s[A-Za-z'’ …-]+)"/g)].map((m) => m[1]);
const bilingual = (desc) => CJK.test(String(desc ?? '')) && englishTriggers(desc).length > 0;

section('AC-1:每一支技能的說明中英兩段——英文使用者講的話(write a spec、clean up、chaos check、walk through it、set up tiers…)寫在說明裡,Claude 才叫得到', 'P4');
{
  // 老毛病 P4:先寫兩個例子——一個必須抓到、一個必須放過
  const zhOnly = 'A 寫規格這一關（產線監視器 pipeline-monitor 帶的通用版）：…使用者說「幫我寫規格」「先列驗收條件」時用；專案自己也有 /spec 時，使用者叫哪個就跑哪個。';
  check('必須抓到:只有中文的說明(裡面的 pipeline-monitor、/spec 不算英文的觸發句)', !bilingual(zhOnly), JSON.stringify(englishTriggers(zhOnly)));
  check('必須放過:中英都有的說明', bilingual(`${zhOnly} English — use it when the user says "write a spec".`));
  const want = { spec: ['write a spec'], cleanup: ['clean up'], 'chaos-check': ['chaos check'], verify: ['walk through it', 'verify'], 'tier-setup': ['set up tiers', 'this project doesn\'t need tiers', 'look at my danger list'],
    director: ['site director', 'what\'s next'] };
  // 不寫死幾支(CLAUDE.md:文件與測試不寫量測值):多一支技能,這裡就要多一列它的英文觸發句,少了就紅
  check('每一支技能都列了要求的英文觸發句、列了的每一支都在(不然下面什麼都沒比到)', ALL.length > 0 && ALL.every((d) => want[d]) && Object.keys(want).every((d) => ALL.includes(d)), ALL.join(','));
  for (const d of ALL) {
    const fm = frontmatter(textOf(d));
    check(`skills/${d}:說明中英兩段(中文那一段、英文的觸發句)`, bilingual(fm?.description), fm?.description);
    const got = englishTriggers(fm?.description).map((x) => x.toLowerCase());
    for (const w of want[d] ?? []) check(`skills/${d}:英文的觸發句有「${w}」`, got.includes(w.toLowerCase()) || (w === 'verify' && /"verify"/.test(fm?.description ?? '')), got.join(' | '));
    if (fm?.['argument-hint']) {
      const parts = fm['argument-hint'].replace(/^"|"$/g, '').split(' / ');
      check(`skills/${d}:argument-hint 中英兩段(用 / 隔開,一段中文、一段英文)`, parts.some((x) => CJK.test(x)) && parts.some((x) => !CJK.test(x) && /[A-Za-z]{3,}/.test(x)), fm['argument-hint']);
    }
    // 技能清單裡每一條說明最多 1,536 個字,超過截掉(Claude Code 文件 code.claude.com/docs/en/skills.md,2026-10-30 讀的;skillListingMaxDescChars 可調)。
    // 英文那一段寫在中文後面,截掉的話先不見的是它——英文使用者就叫不到(安靜壞掉,R1)
    const cutAt = [...String(fm?.description ?? '')].slice(0, 1536).join('');
    check(`skills/${d}:英文的觸發句落在技能清單截掉之前(每條說明前 1,536 個字)`, englishTriggers(cutAt).length === englishTriggers(fm?.description).length && englishTriggers(cutAt).length > 0,
      String([...String(fm?.description ?? '')].length));
  }
  const plugin = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8')).description;
  check('plugin 的說明中英兩段', CJK.test(plugin) && /Pipeline Monitor:/.test(plugin), plugin);
  // R3:單位翻錯,數字就錯。感測器記你說的話的前 200 個「字」(lib/events.mjs 的 PROMPT_CAP 數的是字,不是詞)
  check('……「你說的話的前 200 字」英文寫 characters,不寫 words', /first 200 characters/.test(plugin) && !/200 words/.test(plugin), plugin);
}

section('AC-2:每一支技能的用語對照、三條通用判準的英文那一份,跟 lib/lang.mjs 那一份逐字一樣(兩份就要有測試真的對兩邊)', 'P2');
{
  const table = termsTable().join('\n'), red = RED_LINES_EN.join('\n');
  check('lib 那一份不是空的(不然下面一定綠)', termsTable().length > 10 && RED_LINES_EN.length === 3);
  for (const d of ALL) {
    const t = textOf(d);
    check(`skills/${d}:有用語對照表,而且跟 lib 那一份逐字一樣`, t.includes(table), '改了 lib/lang.mjs 的 TERMS,這支技能裡那張表要一起改(或反過來)');
    check(`skills/${d}:有三條通用判準的英文那一份,而且跟 lib 那一份逐字一樣`, t.includes(red));
    check(`skills/${d}:講明用使用者講的語言回、引號裡的中文是意思不是照抄的字`, /用使用者講的語言回/.test(t) && /Reply in the language the user writes in/.test(t) && /is the meaning, not words to copy/.test(t));
  }
  // 「不准說」那一欄:每一列都要有東西(空的那一列等於沒有紅線)
  check('對照表每一列都有「不准說」', termsTable().slice(2).every((l) => l.split('|')[3]?.trim()), table);
  const chaos = textOf('chaos-check'), verify = textOf('verify');
  check('魔鬼教官:英文的結論是 didn\'t match any known failure pattern,固定結尾講 looked 不是 passed', /This change didn't match any known failure pattern\./.test(chaos) && /This is "looked", not "passed"/.test(chaos), '');
  check('驗收:英文的固定結尾是 This is a walk-through, not an acceptance.', verify.includes('**This is a walk-through, not an acceptance.**'));
  check('驗收:英文的三種結果(seen／not seen／can\'t verify)寫在格式裡', /AC-3 seen: "the original text on the screen"/.test(verify) && /AC-4 not seen:/.test(verify) && /AC-5 can't verify: reason/.test(verify));
}

section('AC-5:技能裡照指令英文分路的那幾句,真的是指令印的字——指令的英文改了、技能沒跟上,這裡紅', 'P2');
{
  // 程式碼裡的字串把撇號寫成 \'(can\'t):還原成印出來的樣子再找
  const src = (['lib/cliRerun.mjs', 'lib/rounds.mjs', 'lib/tier.mjs'].map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n') + readFileSync(join(ROOT, 'remind.sh'), 'utf8')).replace(/\\'/g, '\'');
  const chaos = textOf('chaos-check'), verify = textOf('verify'), tier = textOf('tier-setup');
  // 魔鬼教官的跑法那張表:照 runMode 英文那一份分路(收工 hook、--round D 印的)
  const modes = withLang('en', () => [runMode({ nth: 1, levelId: 'T2', agents: true }), runMode({ nth: 1, levelId: 'T1' }), runMode({ nth: 1, noLevel: 'this project hasn\'t set up tiers' }), runMode({ nth: 2 })].map((m) => m.line));
  const keys = ['you may send independent agents', 'look yourself, don\'t send agents', 'run it the cheapest way', 'whatever the tier, look yourself'];
  keys.forEach((k, i) => {
    check(`魔鬼教官的表有「${k}」`, chaos.includes(k));
    check(`……那是 runMode 英文真的會印的字`, modes[i].includes(k), modes[i]);
  });
  for (const k of ['Can\'t get which files changed after the first time', 'Couldn\'t get the list after the first round, so this time I looked at the whole batch', 'This round\'s scope']) {
    check(`魔鬼教官的表有「${k}」,而且是 --round D 英文真的會印的字`, chaos.includes(k) && src.includes(k), k);
  }
  // 驗收的「它說／你怎麼做」:照 --round E 英文那一份分路
  for (const k of ['Verify against this spec: ', 'Verify against these ', 'Done in batches: this batch only verifies', 'the spec is in the main folder', 'This round has no spec', 'can\'t find this round\'s spec file', 'walking through it again would be number', 'There\'s nothing to verify against']) {
    check(`驗收的表有「${k.trim()}」,而且是 --round E 英文真的會印的字`, verify.includes(k.trim()) && src.includes(k), k);
  }
  // 分級:使用者會照畫面、對話開始那一行講的英文說,skill 要認得
  for (const k of ['set up tiers', 'this project doesn\'t need tiers', 'look at my danger list', 'that nobody has judged yet']) {
    check(`分級那一支有「${k}」,而且是收工 hook、分級卡、對話開始那一行真的會印的字`, tier.includes(k) && src.includes(k), k);
  }
}

section('魔鬼教官照最省的方式跑:--round D 給得出幾種原因,技能的表就列幾種,回報照它給的那句——以前寫死「沒設定分級」,讀不懂、設定成不分級也照那句回報(魔鬼教官 2026-10-30)', 'P2');
{
  const chaos = textOf('chaos-check');
  // lib/tier.mjs 給得出的狀態:沒設定、讀不懂、設定成不分級;其他(沒有存檔、git 問不到、沒有改動…)都是「這次分不了級」
  for (const lang of ['zh', 'en']) {
    for (const state of ['unset', 'broken', 'off', 'unknown']) {
      const why = withLang(lang, () => noLevelOf({ state }));
      check(`魔鬼教官的表列了「${why}」(${state}、${lang})`, chaos.includes(why), why);
    }
  }
  // 必須抓到:舊的那一句(一律回報沒設定);必須放過:照它給的原因寫的那一句
  check('表上不再叫 Claude 一律回報「這個專案沒設定分級，我照最省的方式跑」', !chaos.includes('回報明講「這個專案沒設定分級，我照最省的方式跑」'));
  check('英文第一行那幾句照它給的原因寫(<the reason it gives>, so I ran it the cheapest way)', chaos.includes('<the reason it gives>, so I ran it the cheapest way')
    && !chaos.includes('`This project hasn\'t set up tiers, so I ran it the cheapest way`'));
}

process.exit(summary());
