/**
 * cliOnOff.mjs —— 這個專案記不記:--on／--off(plugin 裝好時只管退出記號與拆舊接法;沒裝才走舊接法)。
 * 規格:plugin、sensor-install、終端機照指令拆開(路徑看 CLAUDE.md 的表)
 *
 * 2026-10-07 從 status.mjs 原封不動搬過來。真正動設定檔的是 lib/mount.mjs(危險清單上);這裡只決定叫哪一個、怎麼講。
 */
import { mount, unmount, mountState, mountFix, pluginState, optIn, optOut, hookPathsIn } from './mount.mjs';
import { zhEn } from './lang.mjs';

/**
 * --on / --off。plugin 裝好之後,這兩個指令只管「退出記號」跟「拆舊接法」;沒裝 plugin 才走舊接法(寫進設定檔)。
 * ⚠️ 兩種掛法同時存在會記兩次,所以 plugin 在的時候,--on 跟 --off 都順手把舊接法拆掉。
 */
function doMount(ctx, on) {
  const plugin = pluginState();
  if (!plugin.installed) {
    console.log(zhEn(`${on ? '掛上' : '拆下'}（舊接法,寫進這個專案的設定檔）：${ctx.root}\n`, `${on ? 'Hooking up' : 'Removing'} (the old way, written into this project's settings file): ${ctx.root}\n`));
    const r = on ? mount(ctx.root) : unmount(ctx.root);
    for (const line of r.out) console.log(line);
    console.log(zhEn('\n💡 裝成 plugin 就不用每個專案掛：agy-pipeline --install', '\n💡 Install it as a plugin and you won\'t need to hook up each project: agy-pipeline --install'));
    return r.ok ? 0 : 1;
  }
  if (on) {
    const m = mountState(ctx.root, ctx.mainRoot);
    if (m.state === 'broken') {
      const removed = optIn(ctx.root, ctx.mainRoot);
      if (removed.length) console.log(zhEn(`拿掉了退出記號：${removed.join(', ')}`, `Removed the opt-out marker: ${removed.join(', ')}`));
      console.log(m.dangling ? zhEn('🔴 感測器是壞的：它掛著,但指向的資料夾不在了——紀錄已經停了,拿掉退出記號也不會開始記。',
        '🔴 The sensor is broken: it\'s hooked up, but the folder it points to is gone — recording has stopped, and removing the opt-out marker won\'t start it again.')
        : zhEn('🔴 感測器是壞的：它掛著,但指向的資料夾不是完整的 agy-pipeline——紀錄已經停了,拿掉退出記號也不會開始記。',
          '🔴 The sensor is broken: it\'s hooked up, but the folder it points to isn\'t a complete agy-pipeline — recording has stopped, and removing the opt-out marker won\'t start it again.'));
      console.log(zhEn(`   捷徑：${m.paths.join(', ')}`, `   Link: ${m.paths.join(', ')}`));
      console.log(`   ${mountFix(m)}`);
      if (hookPathsIn(ctx.root).length) console.log(zhEn('   這個專案設定檔裡的舊接法沒拆：捷徑修好之前,它可能是唯一還在記的那一條。', '   The old hookup in this project\'s settings wasn\'t removed: until the link is fixed, it might be the only one still recording.'));
      return 1;
    }
  }
  const legacy = hookPathsIn(ctx.root).length ? unmount(ctx.root) : null;
  if (on) {
    const removed = optIn(ctx.root, ctx.mainRoot);
    console.log(removed.length
      ? zhEn(`✅ 重新加入記錄：拿掉了 ${removed.join(', ')}`, `✅ Recording again: removed ${removed.join(', ')}`)
      : zhEn('✅ 這個專案本來就在記錄中（plugin 每個專案都會記）。', '✅ This project was already being recorded (the plugin records every project).'));
  } else {
    const p = optOut(ctx.mainRoot ?? ctx.root, 'cli');
    console.log(zhEn(`✅ 已退出記錄：放了 ${p}`, `✅ Opted out of recording: placed ${p}`));
    console.log(zhEn('   從現在起 hook 看到這個檔就不記（不用開新對話）。之前的紀錄還在;想回來就 --on,或按儀表板的按鈕。',
      '   From now on the hook doesn\'t record when it sees this file (no new conversation needed). The earlier records are still there; to come back, use --on or the button on the dashboard.'));
  }
  if (legacy) {
    console.log(zhEn('\n舊接法（設定檔裡的 hook）一併拆掉,不然會記兩次：', '\nAlso removing the old hookup (the hook in the settings file), otherwise things get recorded twice:'));
    for (const line of legacy.out) console.log(`   ${line}`);
  }
  return 0;
}

// 給 status.mjs 拿。函式前面刻意不加 export:搬過來的每一行跟原本一字不差
export {
  doMount,
};
