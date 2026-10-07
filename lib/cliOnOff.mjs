/**
 * cliOnOff.mjs —— 這個專案記不記:--on／--off(plugin 裝好時只管退出記號與拆舊接法;沒裝才走舊接法)。
 * 規格:plugin、sensor-install、終端機照指令拆開(路徑看 CLAUDE.md 的表)
 *
 * 2026-10-07 從 status.mjs 原封不動搬過來。真正動設定檔的是 lib/mount.mjs(危險清單上);這裡只決定叫哪一個、怎麼講。
 */
import { mount, unmount, mountState, mountFix, pluginState, optIn, optOut, hookPathsIn } from './mount.mjs';

/**
 * --on / --off。plugin 裝好之後,這兩個指令只管「退出記號」跟「拆舊接法」;沒裝 plugin 才走舊接法(寫進設定檔)。
 * ⚠️ 兩種掛法同時存在會記兩次,所以 plugin 在的時候,--on 跟 --off 都順手把舊接法拆掉。
 */
function doMount(ctx, on) {
  const plugin = pluginState();
  if (!plugin.installed) {
    console.log(`${on ? '掛上' : '拆下'}（舊接法,寫進這個專案的設定檔）：${ctx.root}\n`);
    const r = on ? mount(ctx.root) : unmount(ctx.root);
    for (const line of r.out) console.log(line);
    console.log('\n💡 裝成 plugin 就不用每個專案掛：pipeline-status --install');
    return r.ok ? 0 : 1;
  }
  if (on) {
    // plugin 的捷徑壞了(資料夾搬走了):拿掉退出記號也記不到——不准回「本來就在記錄中」(規格:agent回報與故障記號 AC-6)。
    // 以前網頁叫你跑 --on,照做就收到這句假的安心話。
    // ⚠️ 這時不拆舊接法:捷徑壞了,設定檔裡的舊接法可能是唯一還在記的那一條——以前先拆了、一個字都沒印(魔鬼教官第一輪,R1)
    const m = mountState(ctx.root, ctx.mainRoot);
    if (m.state === 'broken') {
      const removed = optIn(ctx.root, ctx.mainRoot);
      if (removed.length) console.log(`拿掉了退出記號：${removed.join(', ')}`);
      console.log(m.dangling ? '🔴 感測器是壞的：它掛著,但指向的資料夾不在了——紀錄已經停了,拿掉退出記號也不會開始記。'
        : '🔴 感測器是壞的：它掛著,但指向的資料夾不是完整的 pipeline-monitor——紀錄已經停了,拿掉退出記號也不會開始記。');
      console.log(`   捷徑：${m.paths.join(', ')}`);
      console.log(`   ${mountFix(m)}`);
      if (hookPathsIn(ctx.root).length) console.log('   這個專案設定檔裡的舊接法沒拆：捷徑修好之前,它可能是唯一還在記的那一條。');
      return 1;
    }
  }
  const legacy = hookPathsIn(ctx.root).length ? unmount(ctx.root) : null;
  if (on) {
    const removed = optIn(ctx.root, ctx.mainRoot);
    console.log(removed.length
      ? `✅ 重新加入記錄：拿掉了 ${removed.join(', ')}`
      : '✅ 這個專案本來就在記錄中（plugin 每個專案都會記）。');
  } else {
    const p = optOut(ctx.mainRoot ?? ctx.root, 'cli');
    console.log(`✅ 已退出記錄：放了 ${p}`);
    console.log('   從現在起 hook 看到這個檔就不記（不用開新對話）。之前的紀錄還在;想回來就 --on,或按儀表板的按鈕。');
  }
  if (legacy) {
    console.log('\n舊接法（設定檔裡的 hook）一併拆掉,不然會記兩次：');
    for (const line of legacy.out) console.log(`   ${line}`);
  }
  return 0;
}

// 給 status.mjs 拿。函式前面刻意不加 export:搬過來的每一行跟原本一字不差
export {
  doMount,
};
