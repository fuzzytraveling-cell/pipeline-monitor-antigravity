# 功能：`--install` —— 把感測器裝到一個新專案

分級：小。**還沒開工。**

## 這是為了解決什麼

現在要讓一個新專案有五關時間戳，得**手動編輯**那個專案的
`.claude/settings.local.json`。第二個專案就會卡在這裡。

## 大致的樣子

```sh
cd ~/some-other-project
pipeline-status --install     # 把 4 個 hook 裝進 .claude/settings.local.json
pipeline-status --uninstall   # 拆掉
```

## 動手前一定要想清楚的（尚未寫成 AC）

- ⚠️ **那個檔案可能已經有別人的 hook。** 必須**合併**，不是覆蓋。
  弄丟使用者原本的 hook 是不可接受的失敗。
- ⚠️ **`.claude/` 在別的專案不一定有 gitignore。** 裝之前要檢查，
  如果沒有就明白告訴他「這個檔案會被 commit 進去」——**不要默默裝下去**。
- 已經裝過了要說「已經裝好了」，不要裝第二份。
- 裝完要**驗證它真的會動**（例如提示使用者跑一個指令看看有沒有紀錄），
  不是印一句「安裝成功」就算——那是 R1 的假成功。
