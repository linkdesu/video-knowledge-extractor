---
name: Video Notes
description: Dark, Chinese-language desktop editing workspace; documented from the shipped renderer styles.
colors:
  canvas: "#07080d"
  canvas-raised: "#0b0d15"
  panel: "rgba(20, 23, 34, 0.72)"
  panel-raised: "rgba(28, 32, 46, 0.6)"
  border: "rgba(255, 255, 255, 0.08)"
  border-strong: "rgba(255, 255, 255, 0.14)"
  foreground: "#eef0f6"
  muted: "#9aa3b8"
  dim: "#7d87a0"
  violet: "#8b5cf6"
  cyan: "#22d3ee"
  pink: "#f472b6"
  lime: "#a3e635"
  amber: "#fbbf24"
  rb-accent: "oklch(57% 0.195 275)"
  media-black: "#000"
  button-violet: "#7c3aed"
  button-violet-hover: "#6d28d9"
  danger: "#dc2626"
  danger-hover: "#b91c1c"
  error-text: "#fda4af"
  warning-text: "#fcd34d"
  success-text: "#6ee7b7"
  success-border: "rgba(52, 211, 153, 0.3)"
  success-fill: "rgba(52, 211, 153, 0.08)"
  cyan-tag: "#67e8f9"
  lavender-hover: "#c4b5fd"
  thumbnail-indigo: "#1e1b4b"
  thumbnail-slate: "#0f172a"
  aurora-violet: "#4c1d95"
  aurora-cyan: "#0e7490"
  aurora-pink: "#9d174d"
  black-overlay-35: "rgba(0, 0, 0, 0.35)"
  black-overlay-55: "rgba(0,0,0,0.55)"
  black-overlay-55-spaced: "rgba(0, 0, 0, 0.55)"
  black-overlay-60: "rgba(0, 0, 0, 0.6)"
  black-overlay-65: "rgba(0, 0, 0, 0.65)"
  error-border-45: "rgba(248, 113, 113, 0.45)"
  error-border-55: "rgba(248, 113, 113, 0.55)"
  danger-fill: "rgba(244, 63, 94, 0.08)"
  danger-border: "rgba(244, 63, 94, 0.3)"
  focus-violet: "rgba(124, 58, 237, 0.6)"
typography:
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, Hiragino Sans GB, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "14px"
    lineHeight: 1.6
  compact:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, Hiragino Sans GB, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "11px"
  small:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, Hiragino Sans GB, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "12px"
  body-small:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, Hiragino Sans GB, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "13px"
  micro:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, Hiragino Sans GB, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "10px"
  compact-fractional:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, Hiragino Sans GB, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "10.5px"
  brand:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, Hiragino Sans GB, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "15px"
  section-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, Hiragino Sans GB, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "16px"
  modal-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, Hiragino Sans GB, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "17px"
  notes-page-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, Hiragino Sans GB, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "24px"
  page-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, Hiragino Sans GB, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "26px"
    lineHeight: 1.25
  player-frame:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, Hiragino Sans GB, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "26px"
  notes-page-title:
    fontFamily: "-apple-system, BlinkMacSystemFont, SF Pro Text, PingFang SC, Hiragino Sans GB, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "24px"
  mono-log:
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "11px"
    lineHeight: 1.5
rounded:
  tight: "6px"
  compact: "8px"
  small: "9px"
  rb-base: "10px"
  control: "11px"
  popup: "12px"
  card: "18px"
  pill: "99px"
spacing:
  content: "26px 28px 40px"
  card: "18px 20px"
components:
  button-primary:
    backgroundColor: "{colors.button-violet}"
    textColor: "#fff"
    rounded: "{rounded.control}"
    padding: "9px 16px"
  card:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.card}"
---

# Design System: Video Notes

## Overview

**Creative North Star: "Dark Editing Desk"**

Video Notes is a Chinese-language desktop workspace for video libraries, transcript and topic editing, notes, glossary, and settings. Its implemented visual language combines a near-black canvas, translucent layered surfaces, restrained violet/cyan/pink accents, compact system typography, and a soft three-glow aurora backdrop. This is a single dark theme; it is not a light/dark theme system.

The app shell keeps navigation in a 236px side rail and scrollable work in a centered content region. Job progress is presented as a separate fixed card at the lower right rather than as a panel that resizes the shell. The source establishes colors and styles but contains no measured WCAG contrast results; do not claim numerical contrast guarantees from these tokens alone.

**Key Characteristics:**
- **Dark-only:** `html` remains `.dark`, and `color-scheme` is `dark` (`apps/desktop/src/renderer/index.html:2`; `styles.css:3-4, 28`).
- **Chinese-only UI:** the document language is `zh-CN` and the main navigation labels are Chinese (`index.html:2`; `rbp/blocks/app-shell-1.tsx:8-14`).
- **Translucent layered surfaces:** panels use alpha backgrounds, fine borders, and blur (`styles.css:273-278`).
- **Window-height shell, fixed job overlay:** the shell is `100vh`; the job card is fixed and content gets a bottom safety inset (`styles.css:119-140, 248-253`; `rbp/blocks/monitoring-9.tsx:206-212`).

## Colors

The palette combines the `--vn-*` dark canvas/surface/text family and violet–cyan–pink accents (`styles.css:31-49`) with literal semantic/UI colors catalogued below; values are sourced from renderer CSS/components, not inferred swatches.

| Token | Value | Use in shipped UI (source) |
|---|---|---|
| `canvas` / `canvas-raised` | `#07080d` / `#0b0d15` | Base and raised canvas (`styles.css:33-34`). |
| `panel` / `panel-raised` | `rgba(20, 23, 34, 0.72)` / `rgba(28, 32, 46, 0.6)` | Translucent panel fills (`styles.css:35-36`). |
| `border` / `border-strong` | `rgba(255, 255, 255, 0.08)` / `rgba(255, 255, 255, 0.14)` | Subtle and stronger rules (`styles.css:37-38`). |
| `foreground` / `muted` / `dim` | `#eef0f6` / `#9aa3b8` / `#7d87a0` | Main, secondary, and subdued text (`styles.css:39-41`). |
| `violet` / `cyan` / `pink` / `lime` / `amber` | `#8b5cf6` / `#22d3ee` / `#f472b6` / `#a3e635` / `#fbbf24` | Palette accents and status/highlight hues (`styles.css:42-46`). |
| `rb-accent` | `oklch(57% 0.195 275)` | React Bits theme accent; foreground is `oklch(98.5% 0.005 275)` (`styles.css:26-27`). |
| `media-black` | `#000` | Background behind actual video playback (`components/Player.tsx:163-165`). |
| `button-violet` / `button-violet-hover` | `#7c3aed` / `#6d28d9` | Logo and primary button fill / primary hover fill (`styles.css:148-153, 320-329`). |
| `danger` / `danger-hover` | `#dc2626` / `#b91c1c` | Destructive button fill / hover fill (`styles.css:335-344`). |
| `error-text` | `#fda4af` | Error tags, model logs, failed-note text, and glossary remove hover (`styles.css:371-375, 652-657, 787-789`; `components/NoteList.tsx:52-54`). |
| `warning-text` | `#fcd34d` | Warning tag and warning log text (`styles.css:366-369, 652-654`). |
| `success-text` / `success-border` / `success-fill` | `#6ee7b7` / `rgba(52, 211, 153, 0.3)` / `rgba(52, 211, 153, 0.08)` | Success tag foreground, border, and fill (`styles.css:361-365`). |
| `cyan-tag` | `#67e8f9` | Accent tag text (`styles.css:376-379`). |
| `lavender-hover` | `#c4b5fd` | Hover color for video title and completed job step (`styles.css:476-482`; `rbp/blocks/app-shell-6.tsx:64-68`). |
| `thumbnail-indigo` / `thumbnail-slate` | `#1e1b4b` / `#0f172a` | Video-thumbnail background gradient stops (`styles.css:415-421`). |
| `aurora-violet` / `aurora-cyan` / `aurora-pink` | `#4c1d95` / `#0e7490` / `#9d174d` | Three separately animated aurora glow colors (`styles.css:88-111`). |
| `black-overlay-35` | `rgba(0, 0, 0, 0.35)` | Dark translucent model/job log background (`styles.css:628-638`). |
| `black-overlay-55` | `rgba(0,0,0,0.55)` and `rgba(0, 0, 0, 0.55)` | Dark backing for topic segment resize handles; two exact whitespace spellings in source (`pages/TopicsPage.tsx:273-279`; Tailwind shadow form in `pages/NotesPage.tsx:9-12`). |
| `black-overlay-60` | `rgba(0, 0, 0, 0.6)` | Gradient overlay on video thumbnail and modal shadow (`styles.css:430-435, 708-714`). |
| `black-overlay-65` | `rgba(0, 0, 0, 0.65)` | Video duration badge backing (`styles.css:436-446`). |
| `error-border-45` / `error-border-55` | `rgba(248, 113, 113, 0.45)` / `rgba(248, 113, 113, 0.55)` | Error toast button border / error toast border (`styles.css:685-690`). |
| `danger-fill` / `danger-border` | `rgba(244, 63, 94, 0.08)` / `rgba(244, 63, 94, 0.3)` | Error tag fill / border (`styles.css:371-375`). |
| `focus-violet` | `rgba(124, 58, 237, 0.6)` | Focused glossary input border (`styles.css:770-780`). |

### Primary
- **Violet** (`--vn-violet`, `#8b5cf6`): named palette primary and gradient start (`styles.css:42, 47`).
- **RBP accent** (`--rb-accent`, `oklch(57% 0.195 275)`): React Bits theme accent (`styles.css:26-27`).

### Secondary
- **Cyan** (`--vn-cyan`, `#22d3ee`) and **pink** (`--vn-pink`, `#f472b6`): gradient mid/end stops (`styles.css:43-47`).
- **Lime** (`--vn-lime`, `#a3e635`) and **amber** (`--vn-amber`, `#fbbf24`): auxiliary semantic accents (`styles.css:45-46`).

### Neutral
- **Near-black canvases, translucent panels, foreground/muted/dim text, and two border strengths** are the core dark palette (`styles.css:33-41`).
- The semantic color table records additional literal UI colors at their observed use; entries are not assertions of additional theme variants.

### Named Rules
**The Single Dark Theme Rule.** Keep the renderer in its implemented dark-only state; do not add an unimplemented light theme or theme switch (`index.html:2`; `styles.css:3-4, 28`).
## Typography

**Display Font:** System UI stack (`-apple-system`, `BlinkMacSystemFont`, `"SF Pro Text"`, `system-ui`, `sans-serif`), with Chinese fallbacks `"PingFang SC"`, `"Hiragino Sans GB"`, and `"Microsoft YaHei"` (`styles.css:6-10`).

**Body Font:** The same `--font-sans` stack (`styles.css:59-65`); model/job logs use `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace` (`styles.css:628-638`).

**Character:** Compact system UI typography supports the dense desktop workspace; Chinese platform fallbacks serve the Chinese-only UI. No separate display family is declared.

### Font-size scale
Every renderer type size in the observed requested scale is listed with actual use; `11px` also serves mono logs (`styles.css:628-638`).

| Size | Use in shipped UI (source) |
|---|---|
| `11px` | Brand version, card duration, metadata/field labels, tags, hints, player time labels, subtitle timestamps/speaker chips, log text, and modal supporting labels (`styles.css:165-168, 436-446, 485-499, 522-523, 628-638, 748-751`; `components/Player.tsx:126-132, 170-176`; `components/SubtitleList.tsx:94-118`). |
| `12px` | Breadcrumb, small controls, dropzone description, modal/log header copy, glossary controls, transcript/topic detail copy, note status/output path, and glossary table input (`styles.css:219-223, 330-334, 401-405, 721-725, 754-777`; `pages/TranscriptPage.tsx:137-151`; `pages/TopicsPage.tsx:293-307, 337-376`; `pages/NotesPage.tsx:55-59`; `components/NoteList.tsx:47-50`; `rbp/blocks/data-table-3.tsx:16-17`). |
| `13px` | Supporting text, standard button labels, form fields, radio labels, and notes-page supporting copy (`styles.css:267-270, 295-309, 498-510, 743-746`; `pages/NotesPage.tsx:66-80, 128-130`; `pages/TopicsPage.tsx:182-185`; `VideoWorkspace.tsx:24-26`). |
| `14px` | Renderer body default, unsupported-player message, topic/note titles, and note action controls (`styles.css:59-65`; `components/Player.tsx:105-120`; `components/TopicList.tsx:74-82`; `components/NoteList.tsx:47-49`). |
| `15px` | Brand name and sidebar icon glyphs (`styles.css:160-163, 196-200`). |
| `16px` | Dropzone heading, selected note title, and job overlay title (`styles.css:396-400`; `pages/NotesPage.tsx:86-89`; `rbp/blocks/monitoring-9.tsx:213-216`). |
| `17px` | Modal heading (`styles.css:708-720`). |
| `24px` | Notes-page title (`pages/NotesPage.tsx:52-56`). |
| `26px` | `.vn-h1` page heading and dropzone upload glyph (`styles.css:254-260`; `rbp/blocks/empty-state-5.tsx:59-64`). |

The `26px` `.vn-h1` uses `line-height: 1.25`; base body is `14px / 1.6`, and log copy is `11px / 1.5` (`styles.css:59-65, 254-260, 628-638`).

## Layout

`.vn-shell` is a full-window grid with a 236px navigation column and a flexible main column, one constrained grid row, hidden outer overflow, and `height: 100vh`; `.vn-aside` occupies that row and scrolls vertically when needed (`styles.css:119-140`). Thus the shell and aside fill the viewport/window height; the job overlay is fixed-positioned and never changes that height.

The top bar is 62px high with 24px horizontal padding (`.vn-topbar`, `styles.css:209-218`). The main content scrolls inside `.vn-content` with `padding: 26px 28px 40px`; when `.vn-shell[data-has-job="true"]`, its bottom padding becomes `var(--vn-job-inset, 360px)` (`styles.css:240-249`). `JobProgress` measures itself with a `ResizeObserver` and sets `--vn-job-inset = max(floor, ceil(bannerHeight) + 32)` on `document.documentElement`, where `floor` is 360px normally and 240px when the viewport is 700px tall or shorter (`rbp/blocks/monitoring-9.tsx:136-137,184-197`). A taller banner (long failure copy, wrapped header) still clears the last card at full scroll, and a short window does not lose all of its content area to a 360px floor. `verify.ts doctor` asserts the real relation: `padding-bottom >= bannerHeight + 32` and `>= 240`. `.vn-wrap` is centered and capped at 1160px (`styles.css:250-253`).

The job overlay is `[data-testid="job-banner"]`, a fixed lower-right card with `bottom-4 right-4 z-40 w-[440px]`, a viewport-width maximum, and 16px inset from the edge (`rbp/blocks/monitoring-9.tsx:206-212`). It overlays rather than compresses the main shell; the additional content bottom padding is the scroll-safe space beneath it, not a layout-height change (`styles.css:124-129, 248-249`). The aside uses 14px horizontal padding, while the content inset is 28px (`styles.css:135-140, 240-245`); both exceed the 12–16px minimum inset floor.

## Elevation & Depth

Depth is primarily tonal and translucent: panel fills and thin borders sit over the base canvas, with backdrop blur on the card and aside (`styles.css:35-38, 131-140, 273-278`). Explicit shadows also occur on selected elements, including the logo, primary/danger buttons, and select list (`styles.css:148-154, 320-340, 849-864`). The `.vn-aurora` backdrop consists of three blurred, colored light spots and `vn-drift` animations (`styles.css:75-117`).

## Shapes
The documented rendered radius scale is the eight distinct literal values below; the separate RBP radius variables derive component radii from `--rb-radius: 10px` (`styles.css:14-25`).

| Radius | Use in shipped UI (source) |
|---|---|
| `6px` | Video-duration badge, title focus outline corners, password visibility button, note action controls, and topic resize handle (`styles.css:436-444, 476-482, 937-948`; `components/NoteList.tsx:60-70`; `pages/TopicsPage.tsx:273-279`). |
| `8px` | RBP small scale derives from the 10px base; glossary inputs and select-option corners (`styles.css:14-17, 770-781, 875-895`; `rbp/blocks/data-table-3.tsx:16-17`). |
| `9px` | Logo and small button corners (`styles.css:148-153, 330-334`). |
| `10px` | RBP base radius, model surfaces/logs, and notes card/clip-list panels (`styles.css:14-18, 592-594, 628-638`; `pages/NotesPage.tsx:9-13, 128-142`). |
| `11px` | Sidebar navigation, standard buttons, and radio options (`styles.css:171-195, 295-309, 726-735`). |
| `12px` | Toasts and select-list popovers (`styles.css:672-680, 849-864`). |
| `18px` | Main `.vn-card`, modal, and video player frame (`styles.css:48, 273-278, 708-714`; `components/Player.tsx:67-85`). |
| `99px` | Fully rounded tags and progress tracks (`styles.css:345-360, 551-565`). |

## Components

### Buttons
- **Base (`.vn-btn`):** inline-flex, 9px 16px padding, 11px radius, a `--vn-line2` border, translucent white fill, and 13px foreground text (`styles.css:295-309`).
- **Primary:** violet `#7c3aed`, white text, weight 600, with a restrained violet shadow; hover background is `#6d28d9` (`styles.css:320-329`).
- **Small:** 6px 11px padding, 12px type, 9px radius (`styles.css:330-334`). **Danger:** red `#dc2626` with red shadow; hover is `#b91c1c` (`styles.css:335-344`).
- **Interaction:** base buttons and nav use 0.18s transitions and hover states (`styles.css:171-195, 295-314`). Do not describe this shipped UI as motion-free; see Do's and Don'ts and drift.

### Chips / Tags
`.vn-tag` is a compact, non-wrapping pill: 11px text, 3px 9px padding, 99px radius, subtle border and fill (`styles.css:345-360`). `.ok`, `.warn`, `.err`, and `.accent` supply semantic status colors (`styles.css:361-379`).

### Cards / Containers
`.vn-card` uses `--vn-panel`, a `--vn-line` border, `--vn-radius` (18px), and `backdrop-filter: blur(16px)`; `.vn-pad` adds 18px 20px internal padding (`styles.css:273-281`).

### Navigation
The app shell has three navigation keys—`library`, `glossary`, and `settings`—rendered with Chinese labels (视频库、术语表、设置) as `.vn-nav-btn` buttons (`rbp/blocks/app-shell-1.tsx:8-14, 52-67`). Inactive items use muted text; hover brightens, and `.on` uses a violet/cyan gradient and inset violet border (`styles.css:171-195`). The top breadcrumb is `.vn-crumb` in the 62px top bar (`styles.css:209-228`; `app-shell-1.tsx:69-97`).

### Progress and Job Dock
`.vn-progress` is a 6px rounded track whose fill uses `--vn-grad`; determinate width transitions over 0.4s (`styles.css:551-570`). The job overlay is fixed at the lower-right, shows task state, an expandable log, and state-dependent cancel/close actions (`rbp/blocks/monitoring-9.tsx:206-286`). `.vn-model-log` is a compact, independently scrollable monospace surface (`styles.css:628-660`).

### Dropzone and Player
`.vn-drop` is a dashed 1.5px, 18px-radius drop surface with 34px padding and a violet radial highlight; hover and drag states strengthen the highlight (`styles.css:382-405`; `rbp/blocks/empty-state-5.tsx:38-70`). The player uses a 16px-radius, clipped, bordered dark frame and a 16:10 placeholder (`components/Player.tsx:67-85`).

## Do's and Don'ts

### Do:
- **Do** preserve the single `.dark` renderer theme and `color-scheme: dark` (`index.html:2`; `styles.css:3-4, 28`).
- **Do** preserve the 100vh shell/aside, the fixed lower-right job overlay, and the job-open content bottom inset (`--vn-job-inset = max(360 | 240 at <=700px tall, bannerHeight + 32)`) (`styles.css:119-140, 248-249`; `monitoring-9.tsx:136-137,184-197`).
- **Do** use the CSS-defined `--vn-*` palette and cite selector/token sources when extending it (`styles.css:31-49`).
- **Do** retain the Chinese-only interface and current system font fallbacks (`index.html:2`; `app-shell-1.tsx:8-14`; `styles.css:6-10`).

### Don't:
- **Don't** invent light/dark or language switches; neither is implemented (`index.html:2`; `app-shell-1.tsx:8-14`).
- **Don't** lower `--vn-dim` (`#7d87a0`) back toward `#6f7890`: the shipped value is measured at 5.16:1 on `#10131c` and 5.45:1 on `#0b0b14`, while `#6f7890` measured 4.2–4.4:1 and failed WCAG AA for body text.
- **Don't** render `.vn-mask` dialogs inside `.vn-shell`: it creates a `z-index: 1` stacking context, so the fixed job overlay (`z-40`) would paint above a `z-50` mask. The three dialogs (rerun range, delete video, merge speakers) are `createPortal(..., document.body)`.
- **Don't** make the job overlay participate in shell sizing (no flex row, no `.vn-job-dock` slot — that was r43 and it truncated the window) and don't remove `--vn-job-inset` (`styles.css:124-129, 248-249`; `monitoring-9.tsx:184-197,206-212`).
- **Don't** claim that interaction animations are limited to `:focus-visible`: existing CSS includes nav/button/dropzone hover transitions, progress movement, toast entrance, and aurora drift (`styles.css:88-117, 171-195, 295-314, 382-395, 559-570, 672-696`). This is an observed mismatch with the requested interaction-motion constraint, not a new motion prescription.

## Selectors

Stable `data-testid` hooks observed in the renderer:

| Selector | Source |
|---|---|
| `app-version` | `rbp/blocks/app-shell-1.tsx:45-49` |
| `nav-library` / `nav-glossary` / `nav-settings` | `rbp/blocks/app-shell-1.tsx:8-14, 52-65` (keys map to `nav-${item.key}`) |
| `breadcrumb` | `rbp/blocks/app-shell-1.tsx:69-97` |
| `job-banner` | `rbp/blocks/monitoring-9.tsx:206-212` |
| `job-state` | `rbp/blocks/monitoring-9.tsx:218-231` |
| `job-toggle-log` | `rbp/blocks/monitoring-9.tsx:233-245` |
| `job-log-tail` | `rbp/blocks/monitoring-9.tsx:248-263` |
| `job-cancel` / `job-close` | `rbp/blocks/monitoring-9.tsx:270-286` |
| `player` / `player-unsupported-format` | `components/Player.tsx:67-70, 105-108` |
| `dropzone` | `rbp/blocks/empty-state-5.tsx:38-44` |
| `settings-page` | `pages/SettingsPage.tsx:481-484` |

## Drift

- Shipped CSS animates more than `:focus-visible`: hover transitions, progress movement, toast entrance and the aurora drift (`styles.css:88-117, 171-195, 295-314, 382-395, 559-570, 672-696`). New work should still avoid decorative motion that carries no state.
- `--vn-violet` is `#8b5cf6`, while the primary button and logo use `#7c3aed` and the primary hover uses `#6d28d9`; these are implemented values, not aliases for the token (`styles.css:42, 148-154, 320-329`).
- `job-banner` is `bottom-4 right-4 z-40 w-[440px]` **and** `max-w-[calc(100vw-2rem)] p-4`, so the card narrows on narrow windows; below 700px of viewport height the log collapses by default (`COMPACT_VIEWPORT_MAX_HEIGHT`, `monitoring-9.tsx:136`).
- Contrast is measured only for the values recorded above (`--vn-dim`); the remaining translucent panels have no recorded measurements, so do not claim AA for them (`styles.css:28, 31-49`).

## Detector waivers

`.impeccable/config.json` waives three `impeccable detect` rules that this product violates on purpose. They are brand decisions, not regressions; a new violation of the same rule elsewhere is also exempt, so review any change to this file as a change to the brand:

| Rule | Why it is waived |
|---|---|
| `ai-color-palette` | Violet is the product accent (`--vn-violet`, `--rb-accent`, `#7c3aed` primary button). The rule flags any purple accent palette. |
| `gradient-text` | The page title uses `.vn-gtext` (`--vn-grad`, `styles.css:268-273`) as the single gradient headline in the app. |
| `dark-glow` | The logo carries a zero-offset violet glow (`styles.css:148-154`) as the app's only outer glow. |

`low-contrast`, `nested-cards`, `skipped-heading` and every other rule stay **unwaived** and are gated: `bun run verify:detect` must report `primary 0`. The r45 round fixed the real findings instead of waiving them (h1→h2 heading chain, `--vn-dim` contrast, flat `.vn-model-log.flat` inside the overlay card).
