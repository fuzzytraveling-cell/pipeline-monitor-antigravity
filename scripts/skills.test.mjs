/**
 * skills.test.mjs —— Antigravity plugin 帶的 8 支技能、rules/AGENTS.md 與根目錄 plugin.json。
 *
 * 釘四件會安靜壞掉的事：
 *   ① stages.json 說這一關有 skill，plugin 卻沒帶 → 別的專案這一關永遠「找不到這個指令」（老毛病 P2）
 *   ② SKILL.md 指向 TutorPod 的路徑 → 「通用版」其實綁著另一個專案（老毛病 P4）
 *   ③ 讀取端（lib/skills.mjs）找得到 ~/.gemini/config/plugins/agy-pipeline 裡的技能
 *   ④ rules/AGENTS.md 存在、不含 frontmatter、小於 24000 bytes；8 支技能的中英用語與 lib/lang.mjs 及 CLI 英文輸出逐字同步
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
const PLUGIN_JSON = JSON.parse(readFileSync(join(ROOT, 'plugin.json'), 'utf8'));
const PLUGIN = PLUGIN_JSON.name;
const stages = JSON.parse(readFileSync(join(ROOT, 'stages.json'), 'utf8')).stages.filter((s) => s.skill);

/** 只讀最上面那段 `--- … ---`，一行一個鍵。 */
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

section('Antigravity plugin 結構：根目錄 plugin.json、hooks.json、rules/AGENTS.md', 'P2');
{
  eq('plugin.json name 是 agy-pipeline', PLUGIN, 'agy-pipeline');
  check('根目錄 hooks.json 存在', existsSync(join(ROOT, 'hooks.json')));
  const rulesPath = join(ROOT, 'rules', 'AGENTS.md');
  check('rules/AGENTS.md 存在', existsSync(rulesPath));
  if (existsSync(rulesPath)) {
    const rules = readFileSync(rulesPath, 'utf8');
    check('rules/AGENTS.md 不含 YAML frontmatter（始終載入）', !rules.startsWith('---\n'));
    const bytes = Buffer.byteLength(rules, 'utf8');
    check(`rules/AGENTS.md 小於 24000 bytes（目前 ${bytes} bytes）`, bytes > 100 && bytes < 24000);
    check('rules/AGENTS.md 含三條紅線 R1/R2/R3 與 agy-pipeline 指令', rules.includes('R1') && rules.includes('R2') && rules.includes('R3') && rules.includes('agy-pipeline'));
  }
}

section('stages.json 每一個有 skill 的關，plugin 都帶了對應的 SKILL.md（且 8 支技能 frontmatter 符合 Antigravity 規範）', 'P2');
check('內建關卡裡至少有一關是 skill 關', stages.length > 0);
for (const s of stages) {
  const file = join(SKILLS, s.skill, 'SKILL.md');
  check(`${s.id} ${s.name} → skills/${s.skill}/SKILL.md 存在`, existsSync(file));
}
const ALL = readdirSync(SKILLS).filter((d) => existsSync(join(SKILLS, d, 'SKILL.md'))).sort();
eq('共有 8 支技能', ALL.length, 8);
for (const d of ALL) {
  const fm = frontmatter(readFileSync(join(SKILLS, d, 'SKILL.md'), 'utf8'));
  check(`skills/${d}: 有 frontmatter`, fm !== null);
  eq(`skills/${d}: name 跟資料夾同名`, fm?.name, d);
  check(`skills/${d}: description 不是空的`, !!fm?.description);
  check(`skills/${d}: 不含 Claude 專有的 allowed-tools / argument-hint`, !('allowed-tools' in (fm ?? {})) && !('argument-hint' in (fm ?? {})));
}

const POINTS_AT = [
  /ai-english-course\//i,
  /TutorPod(?:[A-Za-z0-9 ._-]*[A-Za-z0-9._-])?\//,
];
section('SKILL.md 不准指向 TutorPod（提到沒關係，指向才有關係）', 'P4');
const offenders = [];
for (const dir of ALL) {
  const file = join(SKILLS, dir, 'SKILL.md');
  readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (POINTS_AT.some((re) => re.test(line))) offenders.push(`skills/${dir}/SKILL.md:${i + 1}  ${line.trim().slice(0, 90)}`);
  });
}
check('沒有任何 SKILL.md 指向 TutorPod／ai-english-course', offenders.length === 0, offenders.join('\n      '));
const hit = (s) => POINTS_AT.some((re) => re.test(s));
check('一條寫死的絕對路徑會被抓到', hit('/Users/x/Desktop/' + 'Tutor' + 'Pod AI/v4/thing'));
check('一條相對路徑會被抓到', hit('ai-english-' + 'course/docs/x.md'));
check('提到「TutorPod 版」不算違規', !hit('這是 TutorPod 版的通用版'));
check('提到「TutorPod 的 spec」不算違規', !hit('TutorPod 的 ' + '/spec 是它自己的'));

section('讀取端找得到 ~/.gemini/config/plugins/agy-pipeline 帶的 skill');
{
  const r = makeRepo({ files: { 'a.js': '1\n' } });
  const home = mkdtempSync(join(tmpdir(), 'pm-home-'));
  eq('空的 home：找不到（false）', skillAvailable('spec', r.dir, null, home).found, false);
  mkdirSync(join(home, '.gemini', 'config', 'plugins'), { recursive: true });
  symlinkSync(ROOT, join(home, '.gemini', 'config', 'plugins', PLUGIN));
  for (const s of stages) {
    const av = skillAvailable(s.skill, r.dir, null, home);
    check(`裝了 Antigravity plugin → ${s.skill} 找得到`, av.found === true, `where: ${av.where}`);
  }
  rmSync(home, { recursive: true, force: true });
  r.cleanup();
}

/* ════════════ 英文使用者叫得到、AI 轉述不翻錯 ════════════ */

const textOf = (d) => readFileSync(join(SKILLS, d, 'SKILL.md'), 'utf8');
const englishTriggers = (desc) => [...String(desc ?? '').matchAll(/"([A-Za-z][A-Za-z'’ …-]*\s[A-Za-z'’ …-]+)"/g)].map((m) => m[1]);
const bilingual = (desc) => CJK.test(String(desc ?? '')) && englishTriggers(desc).length > 0;

section('AC-1：每一支技能的說明中英兩段——英文觸發句完整且在前 1,536 字以內', 'P4');
{
  const zhOnly = 'A 寫規格這一關（產線監視器 agy-pipeline 帶的通用版）：使用者說「幫我寫規格」時用。';
  check('必須抓到：只有中文的說明', !bilingual(zhOnly), JSON.stringify(englishTriggers(zhOnly)));
  check('必須放過：中英都有的說明', bilingual(`${zhOnly} English — use it when the user says "write a spec".`));
  const want = {
    spec: ['write a spec'],
    'spec-precheck': ['spec precheck', 'precheck the spec', 'chaos check the spec'],
    cleanup: ['clean up'],
    'chaos-check': ['chaos check'],
    verify: ['walk through it', 'verify'],
    'tier-setup': ['set up tiers', 'this project doesn\'t need tiers', 'look at my danger list'],
    director: ['site director', 'what\'s next'],
    retrospect: ['run a retrospect', 'site retrospect', 'pitfall retrospect', 'retrospect'],
  };
  check('每一支技能都列了要求的英文觸發句', ALL.length > 0 && ALL.every((d) => want[d]) && Object.keys(want).every((d) => ALL.includes(d)), ALL.join(','));
  for (const d of ALL) {
    const fm = frontmatter(textOf(d));
    check(`skills/${d}：說明中英兩段`, bilingual(fm?.description), fm?.description);
    const fullDesc = String(fm?.description ?? '');
    const cutAt = [...fullDesc].slice(0, 1536).join('');
    const descLen = [...fullDesc].length;
    check(`skills/${d}：說明總長小於 1,536 字元（目前 ${descLen} 字）`, descLen > 0 && descLen < 1536, String(descLen));
    const got = englishTriggers(fullDesc).map((x) => x.toLowerCase());
    const gotCut = englishTriggers(cutAt).map((x) => x.toLowerCase());
    for (const w of want[d] ?? []) {
      const quotedWordRe = new RegExp(`"${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`, 'i');
      const hasTrigger = /\s/.test(w)
        ? (got.includes(w.toLowerCase()) && gotCut.includes(w.toLowerCase()))
        : (quotedWordRe.test(fullDesc) && quotedWordRe.test(cutAt));
      check(`skills/${d}：英文觸發句有「${w}」且落在前 1,536 字元內`, hasTrigger, got.join(' | '));
    }
    check(`skills/${d}：英文觸發句在前 1,536 字內`, englishTriggers(cutAt).length === englishTriggers(fullDesc).length && englishTriggers(cutAt).length > 0,
      String(descLen));
  }
  const pluginDesc = PLUGIN_JSON.description;
  check('plugin.json 的說明中英兩段', CJK.test(pluginDesc) && /Pipeline Monitor/.test(pluginDesc), pluginDesc);
  check('……「前 200 字」英文寫 characters，不寫 words', /first 200 characters/.test(pluginDesc) && !/200 words/.test(pluginDesc), pluginDesc);
}

section('AC-2：每一支技能的用語對照、三條通用判準的英文那一份，跟 lib/lang.mjs 逐字一樣', 'P2');
{
  const table = termsTable().join('\n'), red = RED_LINES_EN.join('\n');
  check('lib 那一份不是空的', termsTable().length > 10 && RED_LINES_EN.length === 3);
  for (const d of ALL) {
    const t = textOf(d);
    check(`skills/${d}：有用語對照表，而且跟 lib/lang.mjs 逐字一樣`, t.includes(table), '改了 lib/lang.mjs 的 TERMS，這支技能裡那張表要一起改');
    check(`skills/${d}：有三條通用判準的英文那一份，而且跟 lib/lang.mjs 逐字一樣`, t.includes(red));
    check(`skills/${d}：講明用使用者講的語言回`, /用使用者講的語言回/.test(t) && /Reply in the language the user writes in/.test(t) && /is the meaning, not words to copy/.test(t));
  }
  check('對照表每一列都有「不准說」', termsTable().slice(2).every((l) => l.split('|')[3]?.trim()), table);
  const chaos = textOf('chaos-check'), verify = textOf('verify'), precheck = textOf('spec-precheck');
  check('魔鬼教官：英文結論是 didn\'t match any known failure pattern，固定結尾講 looked 不是 passed', /This change didn't match any known failure pattern\./.test(chaos) && /This is "looked", not "passed"/.test(chaos));
  check('規格預審：英文結論是 didn\'t match any known failure pattern，固定結尾講 looked 不是 passed', /This spec didn't match any known failure pattern\./.test(precheck) && /This is "looked", not "passed"/.test(precheck));
  check('驗收：英文固定結尾是 This is a walk-through, not an acceptance.', verify.includes('**This is a walk-through, not an acceptance.**'));
  check('驗收：英文三種結果（seen／not seen／can\'t verify）寫在格式裡', /AC-3 seen: "the original text on the screen"/.test(verify) && /AC-4 not seen:/.test(verify) && /AC-5 can't verify: reason/.test(verify));
}

section('AC-5：技能裡照指令英文分路的那幾句，真的是指令印的字', 'P2');
{
  const src = (['lib/cliRerun.mjs', 'lib/rounds.mjs', 'lib/tier.mjs'].map((f) => readFileSync(join(ROOT, f), 'utf8')).join('\n') + readFileSync(join(ROOT, 'remind.sh'), 'utf8')).replace(/\\'/g, '\'');
  const chaos = textOf('chaos-check'), verify = textOf('verify'), tier = textOf('tier-setup');
  const modes = withLang('en', () => [runMode({ nth: 1, levelId: 'T2', agents: true }), runMode({ nth: 1, levelId: 'T1' }), runMode({ nth: 1, noLevel: 'this project hasn\'t set up tiers' }), runMode({ nth: 2 })].map((m) => m.line));
  const keys = ['you may send independent agents', 'look yourself, don\'t send agents', 'run it the cheapest way', 'whatever the tier, look yourself'];
  keys.forEach((k, i) => {
    check(`魔鬼教官的表有「${k}」`, chaos.includes(k));
    check('……那是 runMode 英文真的會印的字', modes[i].includes(k), modes[i]);
  });
  for (const k of ['Can\'t get which files changed after the first time', 'Couldn\'t get the list after the first round, so this time I looked at the whole batch', 'This round\'s scope', 'Split reminder']) {
    check(`魔鬼教官的表有「${k}」，而且是 --round D 英文真的會印的字`, chaos.includes(k) && src.includes(k), k);
  }
  for (const k of ['Verify against this spec: ', 'Verify against these ', 'Done in batches: this batch only verifies', 'the spec is in the main folder', 'This round has no spec', 'can\'t find this round\'s spec file', 'walking through it again would be number', 'There\'s nothing to verify against']) {
    check(`驗收的表有「${k.trim()}」，而且是 --round E 英文真的會印的字`, verify.includes(k.trim()) && src.includes(k), k);
  }
  for (const k of ['set up tiers', 'this project doesn\'t need tiers', 'look at my danger list', 'that nobody has judged yet']) {
    check(`分級那一支有「${k}」，而且是收工 hook、分級卡、對話開始那一行真的會印的字`, tier.includes(k) && src.includes(k), k);
  }
}

section('魔鬼教官照最省的方式跑：--round D 給得出幾種原因，技能的表就列幾種', 'P2');
{
  const chaos = textOf('chaos-check');
  for (const lang of ['zh', 'en']) {
    for (const state of ['unset', 'broken', 'off', 'unknown']) {
      const why = withLang(lang, () => noLevelOf({ state }));
      check(`魔鬼教官的表列了「${why}」（${state}、${lang}）`, chaos.includes(why), why);
    }
  }
  check('表上不再叫 AI 一律回報「這個專案沒設定分級，我照最省的方式跑」', !chaos.includes('回報明講「這個專案沒設定分級，我照最省的方式跑」'));
  check('英文第一行那幾句照它給的原因寫', chaos.includes('<the reason it gives>, so I ran it the cheapest way')
    && !chaos.includes('`This project hasn\'t set up tiers, so I ran it the cheapest way`'));
}

section('三支技能指引歷史反查與誠實邊界（legacy-spec-lookup AC-4）', 'P2');
{
  const specMd = textOf('spec');
  const precheckMd = textOf('spec-precheck');
  const chaosMd = textOf('chaos-check');
  check('skills/spec/SKILL.md 指引使用 --context 速讀歷史決定並標明邊界',
    specMd.includes('--context') && specMd.includes('沒列到的不代表無關'));
  check('skills/spec-precheck/SKILL.md 指引把 --round precheck 的歷史反查交給子 agent 並標明邊界',
    precheckMd.includes('--round precheck') && precheckMd.includes('歷史反查') && precheckMd.includes('沒列到的不代表無關'));
  check('skills/chaos-check/SKILL.md 指引速讀 --round D 的歷史反查並標明邊界',
    chaosMd.includes('--round D') && chaosMd.includes('相關舊規格') && chaosMd.includes('沒列到的不代表無關'));
}

section('工地復盤官技能契約與常駐規則同步（retrospect-skill AC-1/AC-3/AC-4/AC-5）', 'P2');
{
  const allStages = JSON.parse(readFileSync(join(ROOT, 'stages.json'), 'utf8')).stages;
  check('retrospect 不在 stages.json 裡（非關卡技能）', !allStages.some((s) => s.skill === 'retrospect' || s.id === 'retrospect'));
  const retro = textOf('retrospect');
  for (const token of [
    'agy-pipeline --retrospect',
    '--all',
    'FAILURE-PATTERNS.md',
    'tiers.danger',
    'ask_question',
    '(Recommended)',
    'agy-pipeline --suggest',
    "<<'EOF'",
    'agy-pipeline --cards',
    'agy-pipeline --todo',
    'agy-pipeline --tier-review',
    '--tier-checked',
    '這只代表讀得到的紀錄裡沒看到，不代表專案沒有隱患',
    'In the records I could read, I didn\'t see repeated pitfalls or friction items meeting the evidence bar',
    'This is a retrospect review, not a pass or safety endorsement',
  ]) {
    check(`skills/retrospect/SKILL.md 含「${token}」`, retro.includes(token), token);
  }
  const rules = readFileSync(join(ROOT, 'rules', 'AGENTS.md'), 'utf8');
  const rulesBytes = Buffer.byteLength(rules, 'utf8');
  check(`rules/AGENTS.md 含 retrospect 與 --retrospect 且 < 24,000 bytes（${rulesBytes} bytes）`,
    !rules.startsWith('---\n') && rulesBytes < 24000 && rules.includes('retrospect') && rules.includes('--retrospect'));
  const director = textOf('director');
  check('director 與 rules/AGENTS.md 含 --tasks 與 --wrap dispatch/clean-worktree/archive',
    director.includes('agy-pipeline --tasks')
    && director.includes('agy-pipeline --wrap dispatch <taskId> "<原話>"')
    && director.includes('agy-pipeline --wrap clean-worktree <path|branch> "<原話>"')
    && director.includes('agy-pipeline --wrap archive <conversationId> "<原話>"')
    && rules.includes('--tasks') && rules.includes('--wrap dispatch'));
  const pDesc = PLUGIN_JSON.description;
  check('plugin.json 說明同步為 8 支技能並含 retrospect',
    pDesc.includes('8 支技能') && pDesc.includes('Includes 8 skills') && pDesc.includes('retrospect'), pDesc);

  // 軟整併 AC-3：retrospect 同步採任務板單軌三路分流，rules/AGENTS.md 同步載明
  for (const token of [
    'agy-pipeline --tasks',
    '1 task total:',
    'tasks total:',
    'The task list is currently empty',
    '還沒建立 .agents/pipeline-tasks.json',
    'hasn\'t set up .agents/pipeline-tasks.json yet',
    '沒有權限存取',
    'No permission to access',
    'No permission to read task list',
    'Can\'t find the main folder',
    'doesn\'t look like a git project',
    '不跑 `agy-pipeline --suggest`',
  ]) {
    check(`skills/retrospect/SKILL.md 含任務板單軌字樣「${token}」`, retro.includes(token), token);
  }
  check('rules/AGENTS.md 載明任務板單軌運作', rules.includes('任務板單軌'));
}

section('結案升版改動危險版本檔與 D 順序提醒（中英一致，chaos-check 與 director 兩處同步且無英文禁語）', 'P2');
{
  const chaos = textOf('chaos-check');
  const director = textOf('director');
  const chaosSec = chaos.match(/### 結案升版與 D 的順序提醒[\s\S]*?(?=\n這一輪從哪算起)/)?.[0] ?? '';
  const dirStep3 = director.match(/## 第三步：[\s\S]*?(?=\n## 第四步：)/)?.[0] ?? '';
  const dirAfter = director.match(/## 使用者回答之後[\s\S]*?(?=\n## 邊界)/)?.[0] ?? '';

  for (const token of [
    'tiers.danger',
    'plugin.json',
    '先完成升版與規格搬移',
    '使用者說話（或點選項卡）那一刻之前',
    'D 尚無紀錄時不可 `--decide`',
    'D:ask',
    'finish the version bump and spec move **before** running the final D round or asking the user for `--decide D skip`',
    'before the user spoke or replied',
    're-triggers the `D:ask` stop gate',
  ]) {
    check(`chaos-check 順序提醒含「${token}」`, chaosSec.includes(token), token);
  }
  for (const token of [
    '結案升版先於最後一輪 D／問使用者 `--decide D skip`',
    'tiers.danger',
    'plugin.json',
    '使用者說話那一刻之前',
    'D 尚無紀錄時不可 `--decide`',
    '由低級升為最高級',
    'D:ask',
    '--wrap stamp',
    'before the user spoke',
    'asking the user for `--decide D skip`',
    're-triggering the `D:ask` stop gate and stopping `--wrap stamp`',
  ]) {
    check(`director 第三步含「${token}」`, dirStep3.includes(token), token);
  }
  for (const token of [
    '不得拿升版前使用者的那句話去記 `--decide D skip`',
    '先完成升版與規格搬移',
    'T1 升 T2',
    '升版後再停下來請使用者重新回覆決定 `--decide D skip`',
    '--wrap stamp',
  ]) {
    check(`director 使用者回答之後含「${token}」`, dirAfter.includes(token), token);
  }

  const forbidden = /\b(passed|all clear|no problems|safe|verified|accepted|done|skipped|blocked|will)\b/i;
  const enChaos = chaosSec.match(/^- English:.*$/m)?.[0] ?? '';
  const enDir = dirStep3.match(/[（(]English:[^)）]*`--wrap stamp`\.[)）]/)?.[0] ?? '';
  check('兩處英文順序提醒段落都存在且不含紅線禁語', Boolean(enChaos && enDir) && !forbidden.test(`${enChaos}\n${enDir}`), `${enChaos}\n${enDir}`);
  check('禁語檢查對「passed」必抓到（P4 反向驗證）', forbidden.test('must be passed before stamp'));
}

process.exit(summary());
