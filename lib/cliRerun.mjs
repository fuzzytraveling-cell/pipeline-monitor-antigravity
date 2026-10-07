/**
 * cliRerun.mjs —— 結論會過期的關要不要再跑:--round(這一輪第幾次、怎麼跑、第一次之後改了哪些檔;E 照哪份規格走)、--decide(你說這一輪不用再跑)。
 * 規格:D多輪先問人、E自動驗收、skill範圍跟收工hook對齊、終端機照指令拆開(路徑看 CLAUDE.md 的表)
 *
 * 2026-10-07 從 status.mjs 原封不動搬過來。從 cliFacts.mjs 拿事實,從 cliStages.mjs 拿「規格在哪」那句旁白(specNotes)——
 * 只准單向:cliStages 不准回頭拿這裡的東西。
 */
import { readFileSync, appendFileSync, existsSync, statSync } from 'node:fs';
import { join, dirname, relative, isAbsolute } from 'node:path';
import { git, TEST_FILE, ago } from './git.mjs';
import { readEvents, logFileOf } from './events.mjs';
import { loadStages, tookLine, runMode, afterCall, noWords } from './rounds.mjs';
import { readTierConfig, codeFileFn, computeTier, changeTimeOf } from './tier.mjs';
import { changeScope } from './scope.mjs';
import { HERE, LOG_DIR, gatherChange, stageFacts, sessionFromEnv, rerunFacts, cutBytes } from './cliFacts.mjs';
import { specNotes } from './cliStages.mjs';

/* ────────────── 結論會過期的關:要不要再跑(D 多輪先問人) ────────────── */

/** 分不了級的原因,一句白話(給 runMode)。分得了就是 null。 */
function noLevelOf(t) {
  if (!t || t.state === 'ok') return null;
  return t.state === 'unset' ? '這個專案沒設定分級' : t.state === 'broken' ? '這個專案的分級設定讀不懂'
    : t.state === 'off' ? '這個專案設定成不分級' : '這次分不了級';
}

/** 結論會過期的關(給 --round／--decide 的錯誤訊息):認不出、或不是這種關就回一句白話並回 null。 */
function rerunStageOf(ctx, stageId, flag) {
  const { stages } = loadStages(HERE, ctx.root, ctx.mainRoot);
  const st = stages.find((x) => x.id.toLowerCase() === String(stageId ?? '').toLowerCase());
  if (st?.rerunAfterChange) return st;
  // --round 另外也給有指令的關(C):只有範圍(規格:skill 範圍跟收工 hook 對齊 AC-2)
  const list = stages.filter((x) => x.rerunAfterChange || (flag === '--round' && x.skill)).map((x) => `${x.id} ${x.name}`).join('、') || '這個專案沒有';
  console.log(`${st ? `${st.id} ${st.name} 的結論不會因為之後改檔而過期，沒有「${flag === '--round' ? '第幾次' : '要不要再跑'}」可講。` : `認不出關卡「${stageId ?? ''}」。`}能用 ${flag} 的關：${list}`);
  return null;
}

/**
 * --round <關>:這一關(結論會過期的,例如 D)這一輪第幾次、怎麼跑、第一次之後改了哪些檔(D 多輪先問人 AC-10、AC-11、AC-12、AC-3)。
 * skill 開工第一步先跑它,照它說的分路走;要問人「要不要再跑」之前也跑它,拿「改了什麼、上一輪花多久」。
 * 「第一次之後改了誰」= 感測器的改檔 ∪ git 說跟第一次那一刻的版本(那一筆紀錄的 head)有差、而且變動時間在那之後的檔
 *   (Bash 寫檔繞過感測器,L8;新檔也算,L2)。基準是那一刻的 head,不是現在的 HEAD:第一輪之後存過檔的改動才不會消失。
 *   「之後」跟 rerunOf 同一個判斷(lib/rounds.mjs 的 afterCall)。
 * 拿不到清單(那一筆沒有 head、git 問不到)照實講,看整批(R1);時間只從紀錄拿,拿不到就說看不到,不估(R3)。
 */
async function doRound(ctx, ev, stageId) {
  // 有指令、結論不會因為之後改檔而過期的關(C 打掃):只給這一輪的範圍——沒有第幾次、跑法,這一輪跑過就算(規格:skill 範圍跟收工 hook 對齊 AC-2)
  const { stages } = loadStages(HERE, ctx.root, ctx.mainRoot);
  const plain = stages.find((x) => x.id.toLowerCase() === String(stageId ?? '').toLowerCase() && x.skill && !x.rerunAfterChange && x.type !== 'browser');
  if (plain) {
    console.log(`━━ ${plain.id} ${plain.name}：這一輪的範圍 ━━`);
    printScope(ctx, ev, { stage: plain.id });
    return 0;
  }
  const st = rerunStageOf(ctx, stageId, '--round');
  if (!st) return 1;
  const f = await rerunFacts(ctx, ev);
  if (!f) { console.log('這個資料夾讀不到（不在了、或不是 git 專案），答不出第幾次。'); return 1; }
  // E 驗收(瀏覽器那一關)答的是另一組事實:照哪份規格、要驗哪幾條、怎麼跑起來(E 自動驗收 AC-4、AC-5)
  if (st.type === 'browser') return roundOfWalk(ctx, f, st);
  const r = f.view.stages.find((x) => x.id === st.id)?.rerun ?? { state: 'none', count: 0, rounds: 0, unfinished: 0 };
  const name = `${st.id} ${st.name}`;
  // 第幾次只算跑完(記了結論)的:叫了沒跑完不算一輪——不然下一次真的跑會被當成第二輪、只看第一次之後改的檔(魔鬼教官第一輪,R2)。
  // 最後一次叫還沒記結論 → 它就是現在這一次;都記了 → 再跑是下一次。兩種都是「跑完的次數 + 1」
  const inProgress = r.count > 0 && !r.last?.report && !r.concluded;
  const nth = r.rounds + 1;
  const t = f.tier;
  const noLevel = noLevelOf(t);
  const mode = runMode({ nth, levelId: t?.final?.id ?? null, agents: t?.final?.agents === true, noLevel });
  console.log(r.count === 0 ? `━━ ${name}：這一輪還沒有紀錄——這是第一次 ━━`
    : inProgress ? `━━ ${name}：這一輪第 ${nth} 次（${ago(r.last.call.ts)}叫的，還沒記結論——就是現在這一次）━━`
    : `━━ ${name}：這一輪已經跑完 ${r.rounds} 次（記了結論的）；再跑是第 ${nth} 次 ━━`);
  if (r.unfinished > 0) console.log(`   （前面有 ${r.unfinished} 次叫了沒記結論——可能沒跑完，不算一輪）`);
  if (noLevel) console.log(`   分級：${noLevel}`);
  else {
    const dh = t.machine?.hits?.danger ?? [], ch = t.machine?.hits?.code ?? [];
    console.log(`   分級：${t.final.id}（${dh.length ? `碰到危險清單：${dh.slice(0, 3).join('、')}${dh.length > 3 ? ` 等 ${dh.length} 個` : ''}` : ch.length ? `碰到程式區 ${ch.length} 個檔` : '沒碰到程式區'}）`);
  }
  // 第一次:這一輪的範圍(起點與檔案),跟收工 hook、儀表板同一份——skill 照它拿改動,不自己 git diff HEAD(規格:skill 範圍跟收工 hook 對齊 AC-1)
  if (nth === 1) printScope(ctx, ev, { stage: st.id });
  if (nth >= 2) {
    console.log(`   ${r.took ? `${tookLine(r.took)}（紀錄算的：從叫 ${st.id} 到記結論；用了多少 tokens 這裡看不到）` : '上一輪從叫到記結論：紀錄裡看不到（上一次沒記結論、或配不到是哪一次叫的）'}`);
    const files = roundFiles(ctx, f, r);
    if (files.state !== 'ok') {
      console.log(`   拿不到第一次之後改了哪些檔（${files.why}）——這次看整批，回報第一行寫「拿不到第一輪之後的清單，這次看的是整批」。`);
    } else {
      const look = files.list.filter((x) => x.look);
      const other = files.list.filter((x) => !x.look);
      console.log(look.length
        ? `   第一次（${ago(r.first.ts)}，版本 ${r.first.head}）之後改了 ${look.length} 個要看的檔：`
        : `   第一次（${ago(r.first.ts)}，版本 ${r.first.head}）之後沒有改到程式區或測試檔。`);
      for (const x of look) console.log(rowLine(x));
      if (other.length) console.log(`   另外改了 ${other.length} 個不在程式區的檔（文件、設定），這一次不用看：${other.slice(0, 5).map((x) => x.file).join('、')}${other.length > 5 ? ' …' : ''}`);
      if (f.shared) console.log('   ⚠️ 這個工作區有好幾個對話：git 看到的改動可能含別的對話改的，清單照列。');
      if (look.length) console.log(`   回報第一行寫「第 ${nth} 輪只看了第一輪之後改的 ${look.length} 個檔：${look.slice(0, 5).map((x) => x.file).join('、')}${look.length > 5 ? ' …' : ''}」，不准講成全部看過。`);
    }
  }
  const n = f.health?.touchedTests ?? null;
  console.log(`   這一輪有沒有動到測試檔：${n === null ? '問不到' : n > 0 ? `有（${n} 個）` : '沒有'}`);
  console.log(`   跑法：${mode.line}。`);
  console.log(`   修完不要自己再跑這一關；要再跑先問使用者。`);
  if (!inProgress && r.count > 0) {
    // 要問人之前(AC-3、AC-12):每條修法的標記有兩條硬門檻,Claude 只准往上調;最後一行給建議,決定是人的
    const dangerEmpty = t?.state === 'ok' && t.dangerEmpty;
    console.log('   問使用者「要不要再跑」的時候（白話＋舉例）：');
    console.log(`      每條修法標「小修」或「建議再看」——改到上面標「危險清單」的檔、或上面的檔比第一輪 ${st.id} 指出的位置多（修法蔓延到別處），都是建議再看；`);
    console.log('      其餘是小修，照實講有沒有測試守著（上面那一行）。只准往上調，不准往下調。');
    if (dangerEmpty) console.log('      這個專案的危險清單是空的，硬門檻只剩「蔓延」那一條——問的時候講。');
    console.log('      最後一行給建議：全部小修 → 我建議不跑；有任何一條建議再看 → 我建議跑。使用者說跑才跑。');
    console.log(`      使用者說不用：pipeline-status --decide ${st.id} skip "使用者的原話"`);
  }
  return 0;
}

/**
 * --round E:verify(E 驗收)開工第一步——這一輪照哪份規格走、要驗哪幾條、這是第幾趟、專案怎麼跑起來(E 自動驗收 AC-4、AC-5、AC-6)。
 * 要驗哪幾條只在 roundView 算一次(E 那一格的 verify:A 那格的清單,只在主資料夾的照那份讀;分批做的只有這一批),這裡只照印——skill 不自己找(老毛病 P2)。
 * 規格有狀況(搬了家、同名不只一份、只在主資料夾、讀不出條目)講的話跟 A 那格的旁白同一份(specNotes),不另寫一套(魔鬼教官第一輪)。
 * 之後又改了程式(走過一趟之後、或你說驗收過了之後)跟 D 一樣:上一趟花多久(紀錄算的,不估)、那一刻之後改了哪些檔——問使用者要不要再走,要拿這些講。
 */
function roundOfWalk(ctx, f, st) {
  const v = f.view.stages.find((x) => x.id === st.id) ?? null;
  const r = v?.rerun ?? { state: 'none', count: 0, rounds: 0, unfinished: 0 };
  const es = v?.estate ?? r.state;
  const acc = v?.accept?.valid ? v.accept : null;
  const name = `${st.id} ${st.name}`;
  const inProgress = r.count > 0 && !r.last?.report && !r.concluded;
  const nth = r.rounds + 1;
  console.log(r.count === 0 ? `━━ ${name}：這一輪還沒走過——這是第一趟 ━━`
    : inProgress ? `━━ ${name}：這一輪第 ${nth} 趟（${ago(r.last.call.ts)}叫的，還沒記結論——就是現在這一趟）━━`
    : `━━ ${name}：這一輪已經走完 ${r.rounds} 趟（記了結論的）；再走是第 ${nth} 趟 ━━`);
  if (r.unfinished > 0) console.log(`   （前面有 ${r.unfinished} 趟叫了沒記結論——可能沒走完，不算一趟）`);
  if (acc) console.log(`   ${acc.by === 'claude' ? 'Claude 代記：' : ''}使用者說驗收過了（${ago(acc.coverTs ?? acc.ts)}）${acc.stale ? '，之後又改了程式檔' : ''}`);

  // 照哪份規格(AC-4):E 那一格的 verify(A 那格畫的那一份;只在主資料夾的照那份讀)。規格有狀況,講 A 那格的旁白那一句
  const a = f.view.stages.find((x) => x.skill) ?? null;   // 寫規格那一關
  const vl = v?.verify ?? null;
  const cl = f.view.checklist ?? null;
  if (vl?.multi) {
    // 這一輪寫了好幾份規格(規格:多份規格與新資料夾的起點 AC-4):每一份都要驗;兩份都有 AC-1,回報每一行前面加規格名才分得開
    const relOf = (s) => (s.where === 'main' ? s.file : relative(ctx.root, s.file).split('\\').join('/'));
    console.log(`   照這 ${vl.specs.length} 份規格驗（跟儀表板 ${a?.id ?? 'A'} 那格的清單同一組）：`);
    for (const s of vl.specs) {
      console.log(s.file ? `      ${s.name}：${relOf(s)}（${s.total} 條${s.where === 'main' ? '；規格在主資料夾，不在這個工作區——照那份讀，只讀，不在那裡改任何東西' : ''}）`
        : `      ${s.name}：讀不到——不自己編這一份的條目`);
    }
    for (const line of (a ? specNotes(a) : [])) console.log(`   規格：${line}`);
    console.log(`   有 ${vl.specs.length} 份規格：回報每一行前面加規格名，不然分不出是哪一份的 AC——例：${vl.items[0].id} 看到了：「畫面上的原文」`);
    for (const it of vl.items) console.log(`      ${it.id} ${it.title}${it.plain ? ` —— ${it.plain}` : ''}`);
    console.log('   每條在畫面上要看到什麼，寫在那份規格那一條的「會發生的情況」：打開上面那幾份讀，照那段在畫面上找。');
  } else if (vl) {
    const rel = typeof vl.file === 'string' ? (vl.where === 'main' ? vl.file : relative(ctx.root, vl.file).split('\\').join('/')) : '這一輪的規格';
    console.log(vl.where === 'main'
      ? `   照這份規格驗：${rel}（規格在主資料夾，不在這個工作區——照那份讀，只讀，不在那裡改任何東西）`
      : `   照這份規格驗：${rel}（跟儀表板 ${a?.id ?? 'A'} 那格的清單同一份${a?.link ? '；是別的對話寫的、這個對話連上的' : ''}）`);
    if (vl.batch) console.log(`   分批做：這一批只驗 ${vl.batch.join('、')}，其他條不在這一批`);
    for (const it of vl.items) console.log(`      ${it.id} ${it.title}${it.plain ? ` —— ${it.plain}` : ''}`);
    console.log('   每條在畫面上要看到什麼，寫在規格檔那一條的「會發生的情況」：打開上面那份讀，照那段在畫面上找。');
  } else {
    const notes = a ? specNotes(a) : [];
    for (const line of notes) console.log(`   規格：${line}`);
    if (cl?.missing) console.log('   規格：找不到這一輪的規格檔——不自己編一份。');
    else if (cl && !cl.parsed) console.log(`   規格：規格檔在（${String(cl.file ?? '').split('/').slice(-3).join('/')}），但裡面沒有照格式寫的 AC（「**AC-1　標題**」那種）——不自己把它翻成條目。`);
    else if (!notes.length) console.log('   這一輪沒有規格（沒跑過寫規格那一關、也沒連上別的對話寫的）。');
    console.log(v?.args ? `   叫 /${v.calledAs ?? st.skill} 時說：「${v.args}」——照這句驗；一句話拆成幾條要看的，條目用數字編號（1、2、3）。`
      : '   照使用者在對話裡交代的那件事驗（條目用數字編號）；他沒講要看什麼就先問，問不到就回報「沒有東西可以照著驗」，不自己編步驟。');
  }

  // 怎麼跑起來(AC-5):從專案自己讀;讀不懂、沒有,都照實講,不猜
  const li = launchInfo(ctx);
  if (li.broken) console.log(`   怎麼跑起來：${li.rel} 讀不懂（${li.broken}）——不要猜：每條標「驗不了：啟動設定讀不懂」，跟使用者講。`);
  else if (li.configs) {
    console.log(`   怎麼跑起來：${li.rel}${li.from === 'main' ? '（這個工作區沒有，這是主資料夾的——照它在這個工作區補一份，回報講明）' : ''}`);
    for (const c of li.configs) console.log(`      ${c.name ?? '（沒有名字）'}${c.port ? `：埠 ${c.port}` : ''}${c.url ? `：${c.url}` : ''}`);
    if (!li.configs.length) console.log('      （裡面一個設定都沒有——照 package.json 補一個，回報講明；沒有就每條標「驗不了：啟動設定是空的」）');
    console.log('      用 app 的預覽照這個名字開起來；等多久交給預覽工具，它說起不來就照它的話寫「驗不了：專案跑不起來（…）」，不自己編秒數。');
  } else if (li.pkgBroken) {
    console.log('   怎麼跑起來：沒有 .claude/launch.json，package.json 讀不懂——不要猜：每條標「驗不了：啟動設定讀不懂」，跟使用者講。');
  } else if (li.scripts.length) {
    console.log(`   怎麼跑起來：沒有 .claude/launch.json；package.json 有 ${li.scripts.map((x) => `${x.name}（${x.cmd}）`).join('、')}——`
      + '照它補一份 .claude/launch.json（回報第一行講明「我補了 launch.json」），再用 app 的預覽開起來。');
  } else {
    console.log('   怎麼跑起來：沒有 .claude/launch.json，package.json 也沒有 dev／start／preview——這個專案看起來沒有畫面可以開：每條標「驗不了：沒有畫面可以開」，不硬走。');
  }
  console.log('   驗的是你自己開起來的那一份（這個工作區的程式），不是已經在跑的那一份（例如常駐儀表板跑的是主資料夾的程式）；回報寫網址。');

  // 之後又改了程式(AC-6):從哪一刻算——走過一趟就從第一趟;沒走過、使用者說驗收過了就從他的驗收(那一筆記了當時的版本)。要不要再走是使用者決定的
  const since = r.rounds > 0 ? r.first : acc ? { ts: acc.coverTs ?? acc.ts, head: acc.head } : null;
  const staleNow = es === 'ask' || es === 'accepted-stale';
  if (since && (nth >= 2 || staleNow)) {
    if (r.rounds > 0) console.log(`   ${r.took ? `${tookLine(r.took, { unit: '趟' })}（紀錄算的：從叫 /${st.skill} 到記結論；用了多少 tokens 這裡看不到）` : '上一趟從叫到記結論：紀錄裡看不到（上一趟沒記結論、或配不到是哪一次叫的）'}`);
    const from = r.rounds > 0 ? `第一趟（${ago(since.ts)}）` : `使用者說驗收過了（${ago(since.ts)}）`;
    const files = roundFiles(ctx, f, { first: since });
    if (files.state !== 'ok') console.log(`   拿不到${from}之後改了哪些檔（${files.why}）。`);
    else {
      const look = files.list.filter((x) => x.look);
      console.log(look.length ? `   ${from}之後改了 ${look.length} 個程式檔：${look.slice(0, 8).map((x) => x.file).join('、')}${look.length > 8 ? ' …' : ''}`
        : `   ${from}之後沒有改到程式區。`);
      if (f.shared) console.log('   ⚠️ 這個工作區有好幾個對話：git 看到的改動可能含別的對話改的，清單照列。');
    }
    console.log('   再走一趟預設整份再走；使用者說只看哪幾條就只看那幾條——回報第一行寫第幾趟、看了哪幾條。');
  }
  if (staleNow || (!inProgress && r.count > 0 && es !== 'accepted')) {
    console.log('   問使用者「要不要再走一趟」的時候（白話＋舉例）：之後改了什麼（上面那幾個檔）、可能影響哪幾條、上一趟花了多久、不再走的風險，最後一行給建議。');
    console.log(`      使用者說走才走；說不用就 pipeline-status --decide ${st.id} skip "使用者的原話"；說看過了、可以（驗收現在這一版），才照他的原話 pipeline-status --clear ${st.id} "使用者的原話"。`);
    console.log('      「不用再走」不是「驗收過了」——不准記成 --clear。');
  }
  console.log(`   記結論：pipeline-status --report ${st.id} ok|found "第一行摘要" 之後一行一條——AC-1 看到了：「畫面上的原文」／AC-2 沒看到：…／AC-3 驗不了：原因。有任何一條沒看到就記 found。`);
  console.log(`   「驗收過了」只有使用者能說：不准按儀表板的按鈕；使用者親口說了，才照他的原話 pipeline-status --clear ${st.id} "原話"。`);
  console.log('   走完不要自己再走；要再走先問使用者。');
  return 0;
}

/**
 * 專案怎麼跑起來(E 自動驗收 AC-5):.claude/launch.json——這個工作區沒有就看主資料夾(worktree 常常沒有,.claude/* 多半被 gitignore;跟分級設定同一條規則)。
 * 沒有 launch.json 就看 package.json 的 dev／start／preview。讀不懂要講讀不懂,不當成沒有(R1);例外訊息不給人看(CLAUDE.md:不印程式的內部值)。
 */
function launchInfo(ctx) {
  for (const d of [...new Set([ctx.root, ctx.mainRoot].filter(Boolean))]) {
    const p = join(d, '.claude', 'launch.json');
    if (!existsSync(p)) continue;
    const from = d === ctx.root ? 'here' : 'main';
    const rel = from === 'here' ? '.claude/launch.json' : p;
    let j = null;
    try { j = JSON.parse(readFileSync(p, 'utf8')); } catch { return { from, rel, broken: '不是正確的 JSON' }; }
    if (!Array.isArray(j?.configurations)) return { from, rel, broken: '裡面沒有 configurations' };
    return { from, rel, configs: j.configurations.map((c) => ({
      name: typeof c?.name === 'string' ? c.name : null, port: Number.isFinite(c?.port) ? c.port : null, url: typeof c?.url === 'string' ? c.url : null })) };
  }
  const pk = join(ctx.root, 'package.json');
  if (!existsSync(pk)) return { from: null, rel: null, scripts: [] };
  try {
    const s = JSON.parse(readFileSync(pk, 'utf8'))?.scripts ?? {};
    return { from: null, rel: null, scripts: ['dev', 'start', 'preview'].filter((k) => typeof s[k] === 'string').map((k) => ({ name: k, cmd: s[k] })) };
  } catch { return { from: null, rel: null, scripts: [], pkgBroken: true }; }
}

/**
 * 第一輪(第一次跑完的那一次)被叫之後改了哪些檔(給 --round)。look:要看的(程式區、測試檔);danger／test／gone 是標記。
 * 感測器那一半照呼叫端的範圍(這個對話,或這個工作區),git 那一半是整個工作區——共用時照列、講明(AC-12 的併發)。
 */
function roundFiles(ctx, f, r) {
  const first = r.first;
  if (!first) return { state: 'none', why: '這一輪還沒有跑完的一次' };
  const head = typeof first.head === 'string' ? first.head.trim() : '';
  if (!head) return { state: 'none', why: '那一次的紀錄沒有記版本' };
  const tracked = git(['diff', '--name-status', '--no-renames', head], ctx.root);
  const untracked = git(['ls-files', '--others', '--exclude-standard'], ctx.root);
  if (tracked === null || untracked === null) return { state: 'none', why: 'git 問不到跟那個版本差了什麼' };
  // 「那個版本之後才出現的檔」(新增、還沒追蹤的):搬家(git mv／mv)不會改檔案的修改時間,只看它自己的時間,搬進來的新位置會被篩掉——
  // 搬進危險清單的檔就不會標出來(魔鬼教官第一輪,老毛病 P1)。所以這種檔再看它所在資料夾的時間:搬進來、新建都會更新它。只會多列,不會少列
  const rows = tracked.split('\n').filter(Boolean).map((l) => l.split('\t'));
  const added = new Set([...rows.filter((x) => x[0] === 'A').map((x) => x[1]), ...untracked.split('\n').filter(Boolean)]);
  const dirTime = (p) => { try { return statSync(join(ctx.root, dirname(p))).mtimeMs; } catch { return null; } };
  const inRoot = (p) => { const rel = isAbsolute(p) ? relative(ctx.root, p) : p; return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split('\\').join('/') : null; };
  const fromSensor = f.events.filter((e) => e.hook === 'PostToolUse' && typeof e.file === 'string'
      && (f.sid ? e.session === f.sid : e.cwd === ctx.root) && afterCall(Date.parse(e.ts), first.ts))
    .map((e) => inRoot(e.file)).filter(Boolean);
  const fromGit = [...rows.map((x) => x[1]), ...untracked.split('\n')].filter(Boolean)
    .filter((p) => { const t = changeTimeOf(ctx.root, p); return (t !== null && afterCall(t, first.ts)) || (added.has(p) && afterCall(dirTime(p), first.ts)); });
  return { state: 'ok', list: fileRows(ctx, [...new Set([...fromGit, ...fromSensor])], added) };
}

/**
 * 一份檔案清單怎麼標:要看的(程式區或測試檔)、危險清單、測試檔、新檔、已刪。第一輪的範圍(printScope)與第二輪以後(roundFiles)同一個——
 * 兩份各寫一套,遲早一邊標危險、一邊不標(老毛病 P2)。added:這一輪新加的(還沒追蹤的、跟起點比是新增的)。
 */
function fileRows(ctx, paths, added = new Set()) {
  const cfg = readTierConfig(ctx.root, ctx.mainRoot, HERE);
  const isCode = codeFileFn(ctx.root, cfg.state === 'ok' ? cfg.config : null);
  const inDanger = (p) => cfg.state === 'ok' && computeTier([p], cfg.config).rank === 2;
  return [...paths].sort().map((p) => {
    const test = TEST_FILE.test(p);
    const gone = !existsSync(join(ctx.root, p));
    return { file: p, test, danger: inDanger(p), gone, fresh: !gone && added.has(p), look: test || isCode(p) };
  });
}

/** 一行一個檔,後面掛標記(第一輪與第二輪以後同一種樣子)。 */
const rowLine = (x) => `      ${x.file}${x.danger ? '　危險清單' : ''}${x.test ? '　測試檔' : ''}${x.fresh ? '　新檔' : ''}${x.gone ? '　已刪' : ''}`;

/**
 * 這一輪的範圍:從哪算起、改過哪些檔(規格:skill 範圍跟收工 hook 對齊 AC-1、AC-2)。C 打掃、D 魔鬼教官第一輪照這裡給的版本與檔案拿改動——
 * 以前它們自己用 git diff HEAD,這一輪中途存過檔就只看到還沒存檔的那一半,照樣回報「跑過」(R2,老毛病 P1、P2)。
 * 起點與清單跟改動體檢、分級、收工 hook 同一份(stageFacts → changeFacts 的 base 與那份清單),講法用 lib/scope.mjs 那句——這裡不另算起點。
 */
function printScope(ctx, ev, { stage }) {
  const info = gatherChange(ctx, ev);
  const facts = stageFacts(ctx, ev, info);
  const base = facts.base ?? null;
  const list = facts.health?.list ?? null;
  if (list === null) {
    console.log(`   這一輪的範圍：拿不到（git 問不到改了哪些檔）——回報第一行寫「拿不到這一輪的範圍」，不准講成沒有改動。`);
    return;
  }
  const sc = changeScope(base, ago);
  const ver = base?.since ? base.since.slice(0, 7) : null;
  // 新檔:還沒追蹤的＋跟起點比是新增的——git diff 看不到還沒追蹤的,要整份讀(L2)
  const status = git(['diff', '--name-status', '--no-renames', ver ?? 'HEAD'], ctx.root);
  const untracked = git(['ls-files', '--others', '--exclude-standard'], ctx.root);
  const added = new Set([...(status ?? '').split('\n').filter((l) => l.startsWith('A\t')).map((l) => l.slice(2)), ...(untracked ?? '').split('\n').filter(Boolean)]);
  const rows = fileRows(ctx, list, added);
  const look = rows.filter((x) => x.look), other = rows.filter((x) => !x.look);
  console.log(ver && !sc.blind
    ? `   這一輪的範圍：${sc.note ?? sc.title}（版本 ${ver}）——跟收工 hook、儀表板說的「這一輪」同一份。`
    : `   這一輪的範圍：${sc.short}。`);
  console.log(look.length ? `   這一輪改過的 ${look.length} 個要看的檔：` : '   這一輪沒有改到程式區或測試檔。');
  for (const x of look) console.log(rowLine(x));
  if (other.length) console.log(`   另外改了 ${other.length} 個不在程式區的檔（文件、設定），${stage} 不用看：${other.slice(0, 5).map((x) => x.file).join('、')}${other.length > 5 ? ' …' : ''}`);
  const shared = new Set(facts.events.filter((e) => e.cwd === ctx.root && e.hook && e.session).map((e) => e.session)).size > 1;
  if (shared) console.log('   ⚠️ 這個工作區有好幾個對話：git 看到的改動可能含別的對話改的，清單照列。');
  if (!look.length) return;
  if (ver && !sc.blind) console.log(`   拿改動：git diff ${ver} -- <上面那幾個檔>；標「新檔」的整份讀。一輪中途存過檔的也在裡面。`);
  else console.log('   拿改動：git diff HEAD -- <上面那幾個檔>；標「新檔」的整份讀。回報第一行寫「這一輪的起點找不到，只看了還沒存檔的改動」。');
}

/**
 * --decide <關> skip "<你的原話>":Claude 記下「你說這一輪不用再跑這一關」(D 多輪先問人 AC-4)。事件 stage_decision。
 * ⚠️ 標 source:'human'、via:'claude'——是你的決定,Claude 代記。畫面附的**不是這裡給的字**,是感測器記的、
 *    這一關被叫之後你說的最後一句(記這一筆的那個對話的);這裡給的字只留著對照(quote)。擋得住「根本沒問你」,擋不住「記錯」——
 *    那要靠畫面上你的原話讓你自己對得出來(R2:證據只有這麼大)。
 * 只准結論會過期的關、只有 skip 一種、一定要附你的話;這一輪還沒跑過就沒有東西可以蓋。記不了檔 → 大聲失敗(跟 --report 一樣)。
 */
async function doDecide(ctx, ev, args) {
  const [stageId, verb, ...words] = args;
  const st = rerunStageOf(ctx, stageId, '--decide');
  if (!st) return 1;
  const name = `${st.id} ${st.name}`;
  const vb = st.type === 'browser' ? '走' : '跑';   // D 是再跑一輪,E 驗收是再走一趟
  if (verb !== 'skip') { console.log(`只有一種決定：skip（這一輪不用再${vb}）。例：  pipeline-status --decide ${st.id} skip "不用${vb}了"`); return 1; }
  const quote = words.join(' ').trim();
  if (!quote) { console.log(`要附上使用者說的話（原話）。例：  pipeline-status --decide ${st.id} skip "不用${vb}了"`); return 1; }
  const f = await rerunFacts(ctx, ev);
  const v0 = f?.view.stages.find((x) => x.id === st.id) ?? null;
  const r = v0?.rerun ?? null;
  // E:沒走過一趟、使用者說驗收過了之後又改了程式,也收得下「不用再走」——錨在他的驗收(魔鬼教官第一輪:以前拒收,
  // 剩下的路只有把「不用再走」記成「驗收過了」)
  const onAccept = st.type === 'browser' && v0?.accept?.valid && v0.accept.stale;
  if ((!r || r.state === 'none') && !onAccept) {
    console.log(st.type === 'browser'
      ? `這一輪 ${name} 還沒走過一趟，使用者也還沒說驗收過了——這個決定沒有東西可以蓋。使用者看過、說可以（驗收現在這一版）的話，照他的原話 pipeline-status --clear ${st.id} "使用者的原話"；「不用再走」不是「驗收過了」。`
      : `這一輪還沒有 ${name} 的紀錄——這個決定沒有一次 ${st.id} 可以蓋。`);
    return 1;
  }
  const sid = sessionFromEnv();
  try {
    appendFileSync(logFileOf(LOG_DIR, ctx.project), JSON.stringify({
      ts: new Date().toISOString(), event: 'stage_decision', stage: st.id, decision: 'skip', quote: cutBytes(quote, 600),
      ...(sid ? { by_session: sid } : {}), cwd: ctx.root, head: ctx.head?.slice(0, 7), source: 'human', via: 'claude',
    }) + '\n');
  } catch (e) {
    console.log(`❌ 沒記成功：${e.message}`);
    return 1;
  }
  // 記完再算一次:講清楚這筆算不算數、畫面會附哪一句。E 錨在使用者驗收的那一種,決定掛在那一格(acceptDecision),不在走一趟那邊
  const v2 = (await rerunFacts(ctx, readEvents(LOG_DIR, ctx.project)))?.view.stages.find((x) => x.id === st.id) ?? null;
  const r2 = onAccept ? { state: v2?.estate === 'skipped' ? 'skipped' : 'ask', decision: v2?.acceptDecision ?? null } : v2?.rerun ?? null;
  console.log(`✅ 記下了：你說 ${name} 這一輪不用再${vb}（Claude 代記）。`);
  const d = r2?.decision;
  if (r2?.state === 'skipped') console.log(`   儀表板附的是你在 ${onAccept ? '說驗收過了' : `${st.id} 被叫`}之後說的最後一句：「${String(d.said.text).replace(/\s+/g, ' ').slice(0, 60)}${d.said.text.length > 60 || d.said.cut ? '…' : ''}」——對得上就是你說的。`);
  else if (d?.why === 'no-words') console.log(`   ⚠️ 這筆不算數：${onAccept ? '你說驗收過了' : `${st.id} 被叫`}之後，${noWords(d.odd)}——分不出是不是你說的。儀表板照實這樣講，收工 hook 也不認。`);
  else if (d?.why === 'owner') console.log('   ⚠️ 這筆不算數：分不出是哪個對話記的（拿不到對話代號，而這個工作區有別的對話；或不是叫這一次的那個對話）。');
  else if (r2?.state === 'ask') console.log(`   ⚠️ 你那句話之後又改了程式檔——那次改動不算在這個決定裡，儀表板還是「要不要再${vb}由你決定」。`);
  else console.log(`   （${name} 已經有結論、之後沒再改程式檔——這個決定只在「之後又改了程式檔」時才用得上。）`);
  console.log('   ⚠️ 這是「你說的、Claude 代記的」，不是驗過了——儀表板照實這樣寫，不打勾。');
  return 0;
}

// 給 status.mjs 拿。函式前面刻意不加 export:搬過來的每一行跟原本一字不差
export {
  doRound, doDecide,
};
