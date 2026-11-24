# Monad — Style Reference
> editorial tech journal on warm parchment

**Theme:** light

Monad renders its entire interface on a warm parchment canvas (#f6f3f1) that immediately separates it from the typical pure-white SaaS template. Headlines carry editorial weight in Untitled Serif at weight 400 — never bold — while every body, nav, and UI string runs in ABC Diatype Mono, giving the site the texture of a technical manual typeset for a literary magazine. A single vivid Lake Blue (#2b59d1) is the only chromatic accent for primary actions; everything else lives in a warm grayscale, so a periwinkle card surface (#cfdaf5) and soft pastel gradient washes (coral, sky, mint, gold) read as deliberate punctuation rather than noise. Components lean on hairline borders and 100px pill containers rather than shadows, and the rhythm stays calm and spacious with 40px card padding and generous vertical breathing room between sections.

## Tokens — Colors

| Name | Value | Token | Role |
|------|-------|-------|------|
| Parchment | `#f6f3f1` | `--color-parchment` | Page canvas and the majority of surface fills — this warm off-white IS the brand's signature surface, immediately distinguishing the site from pure-white SaaS templates |
| Lake Blue | `#2b59d1` | `--color-lake-blue` | Violet wash for highlight backgrounds, decorative bands, and soft emphasis behind content. Do not promote it to the primary CTA color |
| Periwinkle Mist | `#cfdaf5` | `--color-periwinkle-mist` | Muted UI surface for disabled controls, low-emphasis panels, and placeholder blocks. |
| Sky Blue | `#a0b5eb` | `--color-sky-blue` | Decorative gradient stop — appears in atmospheric washes and the pipeline diagram's flow lines, never as a UI fill |
| Mint | `#a7fccd` | `--color-mint` | Supporting palette color for small decorative accents when the core palette needs contrast. |
| Coral | `#ff9473` | `--color-coral` | Supporting palette color for small decorative accents when the core palette needs contrast. |
| Gold | `#ecda98` | `--color-gold` | Decorative gradient stop — warm accent in gradient washes, never used in functional UI |
| Crimson | `#f37a0a` | `--color-crimson` | Decorative gradient stop — deep warm tone in gradient washes alongside gold and coral |
| Off-Black | `#242424` | `--color-off-black` | High-contrast neutral action fill for primary buttons on light surfaces. |
| Ink | `#000000` | `--color-ink` | Announcement bar surface and certain heading fills — the black band at the top of the page and select heading contexts |
| Graphite | `#4e4d4d` | `--color-graphite` | Secondary text — body copy and sub-headings that need less weight than primary headlines |
| Smoke | `#797776` | `--color-smoke` | Muted helper text and tertiary links |
| Ash | `#cecac8` | `--color-ash` | Hairline borders — 1px solid lines separating sections, outlining pipeline diagram nodes, and defining card edges |

## Tokens — Typography

### ABC Diatype Mono — Body text, navigation, buttons, badges, tags, and ALL UI strings. The monospace choice across every functional element gives the interface its technical-manual character — body copy at 16-20px reads as data, not marketing. Nav labels and badges use 18px uppercase with tighter tracking; small print and meta text use 12px uppercase. Weight 500 is reserved for emphasized UI labels. · `--font-abc-diatype-mono`
- **Substitute:** JetBrains Mono, IBM Plex Mono, or Space Mono
- **Weights:** 400, 500
- **Sizes:** 12px, 14px, 16px, 18px, 20px, 28px
- **Line height:** 1.0–1.35 (varies by size)
- **Letter spacing:** -0.033em at 12px, -0.025em at 16px, -0.022em at 18px, -0.02em at 14px and 20px, -0.014em at 28px
- **Role:** Body text, navigation, buttons, badges, tags, and ALL UI strings. The monospace choice across every functional element gives the interface its technical-manual character — body copy at 16-20px reads as data, not marketing. Nav labels and badges use 18px uppercase with tighter tracking; small print and meta text use 12px uppercase. Weight 500 is reserved for emphasized UI labels.

### Untitled Serif — Display and heading type only — used at 80px (hero), 48px (section), 40px and 32px (sub-section), 24px (feature card titles). Weight is locked at 400 across all sizes; the serif's natural contrast and the -0.02em letter-spacing do the heavy lifting instead of bold weight. This is the editorial confidence signature: headlines whisper through typographic refinement rather than shout through weight. · `--font-untitled-serif`
- **Substitute:** Times New Roman, Georgia, or any editorial serif with similar stroke contrast
- **Weights:** 400
- **Sizes:** 24px, 32px, 40px, 48px, 80px
- **Line height:** 1.2
- **Letter spacing:** -0.02em at all sizes (-1.6px at 80px, -0.96px at 48px, -0.8px at 40px, -0.64px at 32px, -0.48px at 24px)
- **Role:** Display and heading type only — used at 80px (hero), 48px (section), 40px and 32px (sub-section), 24px (feature card titles). Weight is locked at 400 across all sizes; the serif's natural contrast and the -0.02em letter-spacing do the heavy lifting instead of bold weight. This is the editorial confidence signature: headlines whisper through typographic refinement rather than shout through weight.

### Untitled Sans — Untitled Sans — detected in extracted data but not described by AI · `--font-untitled-sans`
- **Weights:** 400
- **Sizes:** 16px
- **Line height:** 1.35
- **Letter spacing:** -0.02
- **Role:** Untitled Sans — detected in extracted data but not described by AI

### Type Scale

| Role | Size | Line Height | Letter Spacing | Token |
|------|------|-------------|----------------|-------|
| caption | 12px | 1.2 | -0.4px | `--text-caption` |
| body-sm | 14px | 1.35 | -0.28px | `--text-body-sm` |
| body | 16px | 1.35 | -0.4px | `--text-body` |
| label | 18px | 1.2 | -0.4px | `--text-label` |
| body-lg | 20px | 1.35 | -0.4px | `--text-body-lg` |
| subheading | 24px | 1.2 | -0.48px | `--text-subheading` |
| heading-sm | 32px | 1.2 | -0.64px | `--text-heading-sm` |
| heading | 40px | 1.2 | -0.8px | `--text-heading` |
| heading-lg | 48px | 1.2 | -0.96px | `--text-heading-lg` |
| display | 80px | 1.2 | -1.6px | `--text-display` |

## Tokens — Spacing & Shapes

**Base unit:** 8px

**Density:** comfortable

### Spacing Scale

| Name | Value | Token |
|------|-------|-------|
| 8 | 8px | `--spacing-8` |
| 16 | 16px | `--spacing-16` |
| 24 | 24px | `--spacing-24` |
| 32 | 32px | `--spacing-32` |
| 40 | 40px | `--spacing-40` |
| 64 | 64px | `--spacing-64` |
| 72 | 72px | `--spacing-72` |
| 80 | 80px | `--spacing-80` |
| 200 | 200px | `--spacing-200` |
| 216 | 216px | `--spacing-216` |

### Border Radius

| Element | Value |
|---------|-------|
| tags | 9999px |
| cards | 40px |
| pills | 9999px |
| buttons | 100px |

### Shadows

| Name | Value | Token |
|------|-------|-------|
| md | `rgba(0, 0, 0, 0.1) 0px 0px 10px 0px` | `--shadow-md` |

### Layout

- **Page max-width:** 1432px
- **Section gap:** 64px
- **Card padding:** 40px
- **Element gap:** 16px

## Components

### Announcement Bar
**Role:** Top-of-page notification strip

Full-width black (#000000) bar, ~40px tall, containing mono text in white (#f6f3f1) at 14px and a small white pill button (9999px radius, white border, 12px uppercase text) anchored right. Close icon (×) in white at far right.

### Primary Pill Button (Blue)
**Role:** Primary conversion action

Lake Blue (#2b59d1) fill, white text in ABC Diatype Mono at 14px uppercase, 100px border-radius, 16px 32px padding, with a trailing arrow (▸) glyph in white. Height ~48px. This is the only saturated fill in the system.

### Primary Pill Button (Black)
**Role:** Secondary conversion action

Off-Black (#242424) fill, white text in ABC Diatype Mono at 14px uppercase, 100px border-radius, 16px 32px padding, no arrow. Height ~48px.

### Ghost Pill Button
**Role:** Tertiary navigation action

Transparent fill, 1px Off-Black (#242424) border, Off-Black text in ABC Diatype Mono at 14px uppercase, 100px border-radius, 16px 32px padding. Height ~48px.

### Text Link with Arrow
**Role:** Navigation link with directional indicator

Transparent fill, Off-Black (#242424) text in ABC Diatype Mono at 14px, trailing rightward arrow (→) in Off-Black. No background or border. Uppercase tracking.

### Pipeline Node Tag
**Role:** Labeled node in the data pipeline diagram

Parchment (#f6f3f1) fill, 1px Ash (#cecac8) border, 9999px border-radius (full pill), small mono icon (12px) + 14px mono uppercase text, 12px 20px padding. Connected by thin curved Ash lines to adjacent nodes.

### Feature Card
**Role:** Product capability card with icon, title, description

Transparent or Parchment fill, 1px Ash (#cecac8) border, 40px border-radius, 40px padding. Small mono icon (20px) in top-left at 16px padding offset. Title in Untitled Serif at 24px weight 400, Off-Black. Body in ABC Diatype Mono at 16px weight 400, Graphite (#4e4d4d). No shadow.

### Elevated Feature Card (Periwinkle)
**Role:** Hero feature card with gradient illustration

Periwinkle Mist (#cfdaf5) fill, 40px border-radius, 40px padding. Contains a large gradient illustration on the right side using Coral → Sky Blue → Mint washes. Title in Untitled Serif 24px, body in mono 16px. This is the one card that uses a colored surface to draw the eye.

### FAQ Accordion Item
**Role:** Expandable question/answer row

Full-width row, 40px vertical padding, 1px Ash (#cecac8) bottom border (no top border). Question text in Untitled Serif at 24px weight 400, Off-Black. Trailing chevron icon (↓) in Off-Black, 20px, right-aligned. No background fill change on hover.

### Logo Strip
**Role:** Social proof partner logo row

Single horizontal row of 6-7 partner logos in grayscale (desaturated from original brand colors), evenly spaced with ~32px gaps, left-aligned within max-width container. No logo lockup borders or cards.

### Gradient Atmospheric Wash
**Role:** Decorative background gradient blob

Large blurred radial/linear gradient using Coral (#ff9473 80% opacity) → Sky Blue (#a0b5eb 80% opacity) or Sky Blue → Mint (#a7fccd), rendered with blur(50-75px) filter, positioned behind hero or feature content. Never sharp-edged, always softly diffused.

### Navigation Bar
**Role:** Primary site navigation

Transparent or Parchment background, logo on far left (monad wordmark + circular dot mark), 4-5 nav text links centered or left-grouped in ABC Diatype Mono 18px uppercase Off-Black, action buttons (Login ghost + Get a Demo blue pill) right-aligned. ~80px height, no visible border.

### Hero Section
**Role:** First-screen headline and subtext

Full-width Parchment background, centered content stack: Untitled Serif headline at 80px weight 400 Off-Black, monospace subtext at 20px Graphite (#4e4d4d) at 1.35 line-height, two pill buttons centered below. No background image — pure typographic hero.

## Do's and Don'ts

### Do
- Use Untitled Serif at weight 400 for all headings — never go bold; the serif's stroke contrast and -0.02em tracking carry the weight visually
- Use ABC Diatype Mono for all body copy, buttons, nav labels, badges, and functional UI text — the monospace IS the brand voice
- Set all button and tag border-radius to 100px or 9999px — pill shapes are the container language of this system
- Use Parchment (#f6f3f1) as the page canvas — never substitute pure white (#ffffff); the warm tint is signature
- Reserve Lake Blue (#2b59d1) exclusively for the single primary action per screen; all other buttons use Off-Black or ghost variants
- Use 1px solid Ash (#cecac8) for all borders and dividers — avoid thicker weights or darker border colors
- Apply uppercase + tight tracking to all nav labels, buttons, and tag text via the monospace family

### Don't
- Never set headings in bold or 600+ weight — Untitled Serif headlines stay at 400 across all sizes
- Never use pure white (#ffffff) as a page background — always use Parchment (#f6f3f1) to preserve the warm surface
- Never use Lake Blue (#2b59d1) for anything other than the single primary action fill — it loses meaning if scattered
- Never substitute a sans-serif for the monospace body font — the mono/serif pairing is the defining typographic gesture
- Never apply drop shadows to cards — use 1px Ash borders and surface color contrast (Parchment → Periwinkle) for elevation instead
- Never use corner radii below 16px on cards or below 100px on buttons — the system is pill-and-soft-rect, never sharp
- Never introduce additional accent colors for UI elements — the pastel palette (Sky, Mint, Coral, Gold) is decorative-only and belongs in illustrations and gradient washes

## Surfaces

| Level | Name | Value | Purpose |
|-------|------|-------|---------|
| 1 | Parchment | `#f6f3f1` | Page canvas — the base warm off-white that fills the entire viewport |
| 2 | Periwinkle Mist | `#cfdaf5` | Elevated card surface — the one colored card that breaks the monochrome to draw the eye |
| 3 | Off-Black | `#242424` | Dark surface for secondary buttons and inverted UI contexts |
| 4 | Ink | `#000000` | Announcement bar — the darkest surface, used for the top notification strip |

## Elevation

- **Subtle ambient elevation:** `rgba(0, 0, 0, 0.1) 0px 0px 10px 0px`

## Imagery

The visual language is dominated by a custom data pipeline diagram: pill-shaped bordered nodes connected by thin curved lines, with small icons inside each node representing data sources (Any Source, Cloud Logs, Vulnerabilities) and destinations (SIEM, Cloud Storage, Data Lake). The diagram uses a soft green radial glow at the center hub to suggest data normalization. Gradient atmospheric washes (Coral → Sky Blue, Sky Blue → Mint) with heavy blur filters create soft color halos behind hero and feature content. Partner logos appear desaturated in a single social-proof row. The 'In-flight Data Transforms' card features a large gradient illustration with overlapping translucent geometric shapes. No photography is used — the brand communicates through typography, diagram, and color wash alone.

## Agent Prompt Guide

Quick Color Reference:
- text: #242424 (Off-Black)
- background: #f6f3f1 (Parchment)
- border: #cecac8 (Ash)
- accent: #2b59d1 (Lake Blue)
- primary action: no distinct CTA color

Example Component Prompts:

1. Create a hero section on Parchment (#f6f3f1) background. Centered headline in Untitled Serif at 80px weight 400, color #242424, letter-spacing -1.6px. Subtext below in ABC Diatype Mono at 20px weight 400, color #4e4d4d, line-height 1.35. Two centered pill buttons: primary Lake Blue (#2b59d1) with white text, and ghost (1px #242424 border, transparent fill, #242424 text), both 100px border-radius, 16px 32px padding, ABC Diatype Mono 14px uppercase.

2. Create a feature card on Parchment background. 1px solid #cecac8 border, 40px border-radius, 40px padding. Small 20px mono icon top-left at #242424. Title in Untitled Serif 24px weight 400, #242424. Body in ABC Diatype Mono 16px weight 400, #4e4d4d. No shadow.

3. Create a secondary pill button: Off-Black (#242424) fill, white text in ABC Diatype Mono 14px uppercase, 100px border-radius, 16px 32px padding, no arrow.

4. Create an FAQ accordion row: full-width, 40px vertical padding, 1px solid #cecac8 bottom border only. Question in Untitled Serif 24px weight 400, #242424. Trailing down-chevron icon (↓) in #242424 at 20px, right-aligned. No background fill.

5. Create a pipeline diagram node tag: Parchment (#f6f3f1) fill, 1px solid #cecac8 border, 9999px border-radius, 12px 20px padding. Small 12px icon + 14px text in ABC Diatype Mono uppercase, #242424.

## Typography Pairing Philosophy

The serif-mono pairing is the single most distinctive design choice in this system. Untitled Serif handles all hierarchical display text (headlines, section titles, feature card titles, FAQ questions) — it carries editorial authority through its stroke contrast and refined letterforms, not through weight (always 400). ABC Diatype Mono handles everything functional: body paragraphs, navigation, button labels, badges, tags, and inline UI text. This creates a consistent voice: the serif announces, the mono instructs. A page that swapped in a sans-serif for body would lose its identity immediately.

## Similar Brands

- **Linear** — Shares the restrained monochrome palette and minimal-elevation card approach, though Monad's warm Parchment canvas and serif headlines set it apart from Linear's cooler white surface
- **Stripe** — Both use custom editorial serif typefaces for headlines with tight letter-spacing and -0.02em tracking, treating the homepage as a typographic composition rather than a product screenshot
- **Vercel** — Shares the comfortable-density spacing, generous section gaps, and pill-shaped button language, though Monad adds the warm canvas and mono body twist
- **Railway** — Both target developer audiences with a monospace-leaning UI vocabulary and minimal decoration, but Monad layers in the editorial serif for a more literary feel
- **Arc Browser** — Both use warm off-white surfaces rather than pure white, and both treat the page as a designed editorial artifact rather than a typical SaaS template

## Quick Start

數值只住一份：`ui設計規格/variables.css`。畫面經由伺服器的 `/tokens.css` 直接吃那個檔，`ui/ui.css` 裡不准出現任何色碼（pipeline-ui AC-9）。

這裡以前抄了兩塊：一塊 CSS 變數、一塊 Tailwind 的 `@theme`，跟 `ui設計規格/` 裡的 `theme.css`、`tokens.json` 一樣停在 2026-09-10，之後加的顏色都沒有。
改它們不會改到畫面，只會讓人以為改了（LESSONS L9）。2026-10-28 連同那兩個檔一起拿掉；要找舊的，翻 git 歷史。

## 工地工班風（2026-10-27 起，規格：工地工班風畫面）

上面是 Monad 的原始風格參考；產線監視器從這一天起換成清新的工地工班風。**跟上面不一樣的只有這幾條**，其餘照舊（暖白紙底、襯線標題不加粗、藥丸形狀、Lake Blue 當連結色）：

| 上面寫的 | 現在 | 為什麼 |
|---|---|---|
| 所有 UI 字都用等寬 | 一般的句子用系統的無襯線字（中文是蘋方），等寬只留給指令、檔名、分支名、檢查項目 | 等寬字沒有中文：中文本來就落到蘋方、英數是等寬，混在一起字寬不齊 |
| 卡片不准有陰影、圓角不小於卡片的下限 | 便條紙與案件卡：淡淡的影子、圓角小一點、上緣一條紙膠帶、紙上有施工圖的淡方格 | 要像釘在工地看板上的便條紙 |
| 裝飾色不准進功能 UI | 對話頁四張便條紙各一種淡水彩（天藍、薰衣草紫、奶油黃、蜜桃），固定代表「這是哪一張」，不跟狀態變 | 四張卡要一眼分得出誰是誰 |
| — | 有事要處理的那張，紙膠帶換成珊瑚白斜紋的警示膠帶 | 底色不跟狀態變之後，要有一個不只靠顏色的記號，不然又是「字說有問題、顏色說沒事」（LESSONS L40） |
| — | 五個工班：五種形狀（墨水滴、圓球、雲朵、六角螺帽、小房子）加兩隻黑色的直立長條眼睛，戴一頂跟身體同色系的工地帽（身體的淺一號），不畫人、不畫嘴；身分色固定（A 藍、B 深灰、C 淡薄荷、D 鮭魚珊瑚、E 橘）；B 的身體很深，眼睛加一圈淡淡的亮邊。這一輪走到的那一關身後有藍色光暈 | 帽子、顏色、黑眼睛照 Oscar 2026-11-04 給的校色參考圖（規格：主任條列與工地帽；取代以前的「白眼睛、不戴帽子」）。光暈一律藍色：會跟著狀態變的顏色不准是薄荷綠（pipeline-ui AC-3）；帽子顏色只跟著是哪一個角色，不跟狀態變 |
| — | 第六個角色工地主任（規格：還差什麼總表）：金黃色的圓角等腰三角形，尖的朝上、戴同色系的黃色工地帽，帽子正面小小的「AI」；不畫嘴，眼睛跟五個工班一樣是黑色的直立長條。它不是一關，只出現在白板與工作流最後那一列 | 樣子照 Oscar 2026-11-03 給的參考圖、顏色照 11-04 的校色參考圖（規格：主任條列與工地帽；以前是 11-02 指定的檸檬黃直角三角形、不戴帽子）。E 換成橘之後，兩個並排照樣分得開 |
| 裝飾色不准進功能 UI | 案件頁的「還差什麼」白板：四色馬克筆——圈照最急的那一件，圈旁的件數、展開後每一件一種一色（紅等你決定、藍還差、灰看不到、黃只差按結案——工地主任的黃）；下緣筆槽四支筆跟它的意思排在一起，白板上畫到哪一色，那一支的筆頭就亮；圈旁一定有字講同一件事 | 顏色有意思，就一定要有字；沒有還差的事是黃筆（Oscar 指定，跟主任同一個色票），不准是綠色（老毛病 P10），看不到不准跟沒事同色（P5）；筆頭只看圈的顏色會漏掉紅圈裡的還差——把「有」講成「沒有」（R1） |

新的顏色、字型都在 `ui設計規格/variables.css` 最後那一段；畫面照舊直接 import，不抄數值進程式碼。

## 夜間工班風（2026-11-23 起，Antigravity 專用版，規格：night-shift-ui-theme）

Antigravity 專用版（4320）自這一天起將上面的「白天工地風」轉為**夜間工班風**，藉此與原版 Claude 看板（4319）一眼分開；**不一樣的只有下面這幾條**，其餘結構、形狀、表情語意與防說謊紅線照舊：

| 白天工地風 | 夜間工班風 | 為什麼 |
|---|---|---|
| 暖白紙底（`#f6f3f1`）＋淡藍方格 | 深夜空底（`#070b14`）＋電青藍圖方格，柔和冷白／淺銀灰文字；頂列加 `Antigravity` 小霓虹標籤、分頁標題帶 `Antigravity` | 放第二螢幕長看不刺眼又能一眼分辨與 Claude 版的差別（識別靠 `Antigravity` 標籤與分頁標題保留） |
| 四張淡水彩便條紙＋紙膠帶 | 高飽和夜間賽博工作卡＋四色固定霓虹框與外發光（有事要處理時換成高對比夜間斜紋警戒帶）；三階梯完成那格亮電紫霓虹框 | 維持「顏色只區分哪一張、警戒看斜紋」與「三階梯只有 done 上色」 |
| 實心角色＋黑眼睛 | 維持原形狀、身分色與工地帽（B 調亮為藍銀深灰）；身體帶微霓虹描邊、帽頂稜條變成夜間反光條；A–E 醒著發溫暖黃光眼、F 金黃主任採粗黑框黃光眼（閉眼改粗黑線），其餘角色閉眼（`sleep`／`rest`）改低亮度線條不發強光 | 暗底維持可愛輪廓與表情辨識度，避免 B 融進背景、F 黃眼吃進黃臉，也不讓還沒跑看起來像在亮燈 |
| Overview 粉彩球與 A→E 灰線 | Overview 中央改為四色高飽和漸層流動＋微閃爍核心（青／洋紅／紫／金橘，不用綠）；工作流左軌改為高亮度賽博彩虹漸層霓虹燈管（外暈＋燈芯＋無縫向下漸層流動，不用綠） | 強化 Antigravity 夜間賽博識別；匯流虛線維持統一速率與顏色，不暗示「哪一個對話在忙」 |
| 白底鋁框白板＋四色馬克筆 | 夜間毛玻璃霓虹看板（深炭毛玻璃底板＋暗金屬框＋四色霧面毛玻璃霓虹廣告招牌）；紅／藍／黃發光並模擬霓虹微閃爍，灰（看不到）維持靜止不發光也不閃爍，下緣改為四色招牌燈號說明列（`紅燈／藍燈／灰（不亮燈）／黃燈`） | 暗底留白板或傾斜橢圓套圈會刺眼或切過長標題；改為毛玻璃霓虹招牌與燈號說明兼顧閱讀清晰與夜景氛圍，四色語意與「沒事不上綠」照舊 |
| 狀態光暈用藍色、斷線整頁變灰 | 狀態光暈維持電光藍（絕不用賽博綠）、文字／卡片維持靜止微光不閃爍；宣告 `color-scheme: dark` 防原生表單跳白框，斷線頂列改高對比反白 | 霓虹風不把安全帶拆掉（R2／P10），也不在暗底漏掉斷線與系統控制項 |

## 白天／夜間／自動三模式切換（2026-11-24 起，規格：dashboard-theme-toggle）

- **三段切換與快捷鍵**：頂列提供「白天工班／夜間工班／自動切換」（英文：`Day`／`Night`／`Auto`）三段小膠囊與快捷鍵 `T`（循環切換），偏好存在瀏覽器 `localStorage`（`<html data-theme="day|night" data-theme-mode="day|night|auto">`），不重整頁面、不洗掉輸入中文字、跨分頁即時同步；`<head>` 內放純 ASCII 同步腳本避免重新整理閃底色。
- **預設與離線自動換班**：全新分頁預設「自動切換」，依瀏覽器本機時區代表座標與今日日期用 NOAA 公式離線推算日出日落（零權限彈窗、不連外部 API）；查不到座標時誠實退回系統深淺色（問不到則暫用夜間），極晝極夜與無法寫入偏好皆明講原因。
- **雙風格單一色票來源**：夜間工班色票維持 `ui設計規格/variables.css` 的 `:root` 預設；原版白天工地風（`526e0e4`）色票集中於 `:root[data-theme="day"]`，`ui/ui.css` 維持零硬編碼色碼並以 `[data-theme="day"]` 分流結構差異（含灰線左軌、白底鋁框手畫馬克筆圈與下緣「紅筆／藍筆／灰筆／黃筆」筆槽、工班黑眼、Lake Blue 樣式 `Antigravity` 識別標籤）。
