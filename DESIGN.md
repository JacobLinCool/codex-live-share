---
name: Live Share for Codex
description: A live co-editing pane inside Codex where every person and their agent is a color you can follow.
colors:
  bg: "#171717"
  surface: "#1c1c1c"
  rail: "#202020"
  raised: "#282828"
  hover: "#2c2c2c"
  line: "#2f2f2f"
  line-strong: "#3a3a3a"
  text: "#e9e9e6"
  text-2: "#b4b4ae"
  muted: "#8e8e88"
  accent: "#6d9bff"
  accent-ink: "#0d1626"
  focus: "#8fb1ff"
  danger: "#ff7a6b"
  info-bg: "#1d2638"
  info-text: "#c6d6ff"
  warn-bg: "#3a2f17"
  warn-text: "#f5d99a"
  bad-bg: "#3b1d1a"
  bad-text: "#ffc4bb"
  name-ink: "#111111"
  peer-orange: "#f97316"
  peer-green: "#22c55e"
  peer-blue: "#3b82f6"
  peer-rose: "#e11d48"
  peer-violet: "#a855f7"
  peer-teal: "#14b8a6"
  peer-amber: "#eab308"
  peer-pink: "#ec4899"
  syn-heading: "#f0f0ec"
  syn-keyword: "#c49bff"
  syn-comment: "#7d7d77"
  syn-string: "#9ed29a"
  syn-bracket: "#a3a39c"
  syn-atom: "#f0b072"
  syn-link: "#8fb1ff"
typography:
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang TC', 'Noto Sans TC', system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang TC', 'Noto Sans TC', system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.45
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang TC', 'Noto Sans TC', system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 600
    letterSpacing: "0.04em"
  name-tag:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang TC', 'Noto Sans TC', system-ui, sans-serif"
    fontSize: "10.5px"
    fontWeight: 600
    lineHeight: 1.35
  editor:
    fontFamily: "ui-monospace, 'SF Mono', Menlo, 'Cascadia Mono', 'Noto Sans Mono CJK TC', monospace"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.65
  code-mark:
    fontFamily: "ui-monospace, 'SF Mono', Menlo, 'Cascadia Mono', 'Noto Sans Mono CJK TC', monospace"
    fontSize: "12px"
    fontWeight: 600
    letterSpacing: "0.08em"
  reading:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang TC', 'Noto Sans TC', system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 400
    lineHeight: 1.65
rounded:
  hair: "2px"
  sm: "4px"
  md: "6px"
  pill: "999px"
  round: "50%"
spacing:
  "2": "2px"
  "4": "4px"
  "6": "6px"
  "8": "8px"
  "10": "10px"
  "12": "12px"
components:
  button:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "26px"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.md}"
    padding: "0 10px"
    height: "26px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.md}"
    height: "26px"
  icon-button:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.md}"
    size: "28px"
  icon-button-hover:
    backgroundColor: "{colors.hover}"
    textColor: "{colors.text}"
  room-chip:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    rounded: "{rounded.pill}"
    padding: "0 8px 0 7px"
    height: "24px"
  file-chip:
    backgroundColor: "transparent"
    textColor: "{colors.muted}"
    rounded: "{rounded.sm}"
    padding: "0 6px"
    height: "20px"
  top-bar:
    backgroundColor: "{colors.rail}"
    padding: "0 8px"
    height: "40px"
  plan-ticket:
    backgroundColor: "{colors.surface}"
    rounded: "{rounded.md}"
    padding: "0 10px 0 9px"
    height: "28px"
  tree-row:
    backgroundColor: "transparent"
    textColor: "{colors.text-2}"
    height: "26px"
  tree-row-selected:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text}"
  avatar:
    textColor: "{colors.name-ink}"
    rounded: "{rounded.round}"
    size: "24px"
  segmented-option-selected:
    backgroundColor: "{colors.raised}"
    textColor: "{colors.text}"
    rounded: "{rounded.sm}"
    height: "22px"
---

# Design System: Live Share for Codex

## Overview

**Creative North Star: "Colored Ink in Graphite Chrome"**

The interface is a guest inside Codex's side pane, so its chrome borrows the host: neutral graphite in dark, paper-grey in light, hairline dividers, 6px corners, the system sans for UI, and monospace only for the text being edited. The editor fills the pane; coordination (presence, agent plans, transcript, file list) rides in thin rails and drawers around it, never in cards stacked over it.

All identity color comes from people. Each peer gets one of eight colors, carried through a per-element `--who` variable onto their avatar, cursor flag, plan ticket, transcript name, file-tree dot, and the fading ink their agent leaves in the text. The chrome itself stays colorless except for one quiet blue that marks primary actions, focus, and links.

Density is IDE-tight: 13px body, 22–28px controls, 26px tree rows, 40px top bar. Motion is short and eased (150–250ms on `cubic-bezier(0.16, 1, 0.3, 1)`) for state changes, with slower, longer loops reserved for things that are live: a working agent, a hot mic, ink drying over nine seconds.

**Key Characteristics:**
- Host-native graphite / paper-grey chrome, tonal layers separated by 1px hairlines.
- People are the only palette; the chrome is achromatic plus one blue.
- Thin rails, not panels of cards; side panels become overlay drawers below 760px.
- Signature: plan tickets with live segment tracks, and agent ink that glows in its owner's color and dries.
- Full light theme via `prefers-color-scheme`; every chrome token is redefined, peer colors are not.

## Colors

An achromatic graphite ladder with one blue for action, and eight saturated peer hues that belong to people, not to the UI.

### Primary
- **Quiet Action Blue** (`accent`): the primary button fill, link color in Markdown preview, and the tint of search matches. Lighter sibling **Focus Blue** (`focus`) draws the 2px focus ring and the editor's focused-edge bar. In light mode it deepens (#2f63e0) and white `accent-ink` sits on it.

### Peer identity (the people palette)
- **Orange, Green, Blue, Rose, Violet, Teal, Amber, Pink** (`peer-*`, assigned in order by the protocol): applied only through `--who` / `--mark` on elements that belong to one person or their agent. Text on a peer fill is always near-black `name-ink`, in both themes.

### Neutral
- **Pane Graphite** (`bg`): the page behind everything.
- **Editor Surface** (`surface`): the editing and reading area, and plan tickets.
- **Rail Graphite** (`rail`): top bar, plan rail, file and transcript panels, segmented-control trough.
- **Raised** (`raised`) and **Hover** (`hover`): selected rows, pressed toggles, secondary buttons; transient hover.
- **Hairline** (`line`) and **Strong Hairline** (`line-strong`): dividers, control borders, scrollbar thumb.
- **Ink, Secondary Ink, Muted** (`text`, `text-2`, `muted`): primary text, de-emphasized content (inactive tree rows, live transcript), labels, metadata and idle icons.

### Status
- **Danger** (`danger`): hot microphone, destructive hover, mic error. Banners use paired tinted grounds: **Info** (`info-bg`/`info-text`), **Warn** (`warn-bg`/`warn-text`), **Bad** (`bad-bg`/`bad-text`).

### Editor syntax
- `syn-*` tokens color CodeMirror highlighting (headings brighter and 600, keywords violet, comments muted italic, strings green, atoms amber, links underlined blue). Each has a light-mode counterpart.

### Named Rules
**The People-Are-the-Palette Rule.** Saturated color in the chrome means a person. Never use a peer hue for decoration, status, or category; never put the accent blue on something that belongs to a person.

**The One Blue Rule.** The accent appears only on the primary action in view, links, focus, and search matches. Secondary actions are neutral (`raised` with a `line-strong` border) or quiet (transparent, `muted`).

## Typography

**UI Font:** the system sans stack (-apple-system / Segoe UI) with PingFang TC and Noto Sans TC for Traditional Chinese.
**Editor Font:** the system monospace stack (ui-monospace / SF Mono / Menlo) with Noto Sans Mono CJK TC.

**Character:** host-native and unbranded; the type should read as part of Codex. Monospace is reserved for file text and for codes and paths (room code, file chips).

### Hierarchy
- **Title** (600, 13px): folder name, people's names in tickets, plans and transcript. Hierarchy comes from weight and color, not size.
- **Body** (400, 13px, 1.45): all chrome text. 500 marks a current item (active plan step, current breadcrumb, button labels).
- **Label** (600, 11px, 0.04em, uppercase): panel titles only ("Files", "Transcript"). 11–12px plain text carries metadata: counts, timestamps, footers, with `tabular-nums` for numbers.
- **Name tag** (600, 10.5px): the remote-cursor name and the agent-ink flag, set on the owner's color.
- **Editor** (400, 13.5px, 1.65): CodeMirror text, capped at 92ch.
- **Code mark** (600, 12px mono, 0.08em): the six-character room code.
- **Reading** (400, 15px, 1.65): Markdown preview, max 76ch; h1/h2/h3 at 1.6/1.3/1.1rem, line-height 1.25, balanced.

### Named Rules
**The Weight-Not-Size Rule.** Inside the chrome nothing is larger than 14px. Emphasis is 500/600 and `text` vs `text-2`/`muted`; display sizes exist only in the Markdown preview.

## Layout

A full-height flex column: 40px top bar, optional banners, an optional plan rail (one 28px ticket row, expanding to a detail grid of `minmax(260px, 1fr)` columns capped at 40vh), then a row of file panel (220px), main editor (flex), and transcript panel (300px). The page never scrolls; each region scrolls itself with thin scrollbars.

Spacing runs on a 2px-step rhythm, mostly 4 / 6 / 8 / 12px: 8px gaps and bar padding, 12px inset for panel content, 2–6px between tight siblings. Tree indentation is 14px per depth level.

Responsive behavior is pane-driven, not device-driven: below 760px the file and transcript panels become absolute overlay drawers (260px / 320px, capped at 82–88vw) over a 45% black scrim, and the room's "copy link" label hides. At 1180px and up the transcript opens by default. Below 520px the face pile shows four people and the folder name truncates at 28vw.

## Elevation & Depth

Flat by default. Depth is tonal (`bg` → `rail` → `surface` → `raised`) and drawn with 1px hairlines; the only resting shadows are 2px rings that separate stacked avatars from the bar and a 1px inset ring on the selected tree row.

### Shadow Vocabulary
- **Drawer** (`box-shadow: 0 8px 28px rgba(0, 0, 0, 0.35)`): side panels when they overlay the editor in the narrow layout.
- **Avatar cutout** (`box-shadow: 0 0 0 2px var(--rail)`): separates overlapping faces.
- **Agent glow** (`0 1px 6px 1px` of the owner's color at 45%): pulses on the agent badge while that agent works.

### Named Rules
**The Hairline Rule.** Regions are separated by a 1px `line` border, never by a gap plus a shadow. Shadows appear only when something floats over the editor.

## Shapes

Small, consistent corners: 6px on controls, tickets, segmented trough and preview code blocks; 4px on chips, inner segmented options, name tags and the focus ring; 2px on plan-track segments, agent ink and an agent's square presence dot. Circles are for people (avatars, presence dots, plan-step marks); the room code is the one pill. A person's dot is round, their agent's dot is a 2px-cornered square.

## Components

### Buttons
- **Shape:** gently rounded (6px), 26px tall, 0 10px padding, weight 500.
- **Default:** `raised` fill, `line-strong` border; hover lifts the border to `muted`.
- **Primary:** `accent` fill and border, `accent-ink` text; hover brightens 8%.
- **Quiet:** transparent, `muted` text, hover to `text`.
- **Icon button:** 28px (22px small) transparent square, `muted` icon; hover gets `hover` fill and `text`; pressed toggles sit on `raised`. Destructive icons hover to `danger`. Icons are Lucide outlines at 13–16px, stroke 1.75 (2 for checks and chevrons).
- **Focus:** global 2px `focus` outline, 1px offset, 4px radius.

### Chips
- **Room chip:** pill, `line-strong` border, transparent, mono room code plus a 12px action label.
- **File chip:** 20px, 4px corners, `line` border, 11px mono path in `muted`; hover to `text` and `line-strong`.

### Inputs / Fields
- **Segmented control** (Edit / Preview): `rail` trough with `line` border and 2px padding; options 22px, 4px corners; selected option on `raised` with `text`.

### Navigation
- **Top bar:** `rail`, 40px, 8px gaps; folder name (600, ellipsized), room chip, a right-aligned face pile, then icon actions.
- **File tree:** 26px rows in `text-2`; hover `hover`; selected `raised` with an inset `line-strong` ring; rotating 13px chevron; up to a few peer dots on the right showing who is in each file.
- **Breadcrumbs:** `muted` segments separated by a `line-strong` slash; current segment `text`, 500.

### Banners
Full-width 34px+ strips under the top bar with a bottom hairline, dropping in over 220ms. Tones: info (default), warn, bad, and knock (`raised`, with the guest's colored avatar and admit actions).

### Presence face pile
24px circular avatars in the peer color with `name-ink` initials (700, 11px), overlapping by 4px with a 2px `rail` cutout. Offline faces drop to 45% opacity and half saturation. A working agent adds a 14px badge (bot icon in the owner's color, 1.5px ring) that pulses every 1.8s.

### Plan ticket (signature)
A 28px `surface` ticket with a `line-strong` border: owner name in their color (600), a track of 14×6px segments (one per plan item), then the current step in `text-2`, ellipsized. Segments fill left-to-right in the owner's color: done fills fully over 500ms, in-progress oscillates, dropped is hatched. Hover tints the border toward the owner's color; finished plans fade to 60%. The expanded detail lists items with 14px circular marks (spinner ring in progress, filled with a popped check when done), and done or dropped text gets a strike line that draws across over 450ms.

### Agent ink (signature)
Text an agent just wrote is highlighted in its owner's color (55% fading to 30% to clear) with a 1px underline in that color, drying over 9s. A small name flag ("Alice's Codex") sits just past the end of the inserted text and fades out after about 3s. Remote human carets show a name tag in the same style that fades after 2.4s and reappears on hover.

### Transcript turns
Turns separated by hairlines: speaker name in their color (600), an 11px tabular timestamp, then the text. A live, still-transcribing turn shows in `text-2` with a breathing dot in the speaker's color.

### Microphone
A 30×28px icon control. On: `danger` icon on an 18% danger tint, with a 1.5px ring that scales and brightens with the input level. Starting: breathes. Error: `danger` icon.

## Do's and Don'ts

### Do:
- **Do** pass a person's color through `--who` (or `--mark` in the editor) and derive tints with `color-mix(in srgb, var(--who) N%, …)`.
- **Do** separate regions with 1px `line` hairlines and tonal steps between `bg`, `rail`, `surface`, and `raised`.
- **Do** keep chrome text at 11–14px and get emphasis from weight 500/600 and the `text` / `text-2` / `muted` ladder.
- **Do** keep every live indicator in the owner's color and every state change on `cubic-bezier(0.16, 1, 0.3, 1)` at 150–250ms; respect `prefers-reduced-motion` (ink then rests at a static 25% tint).
- **Do** redefine every new chrome token for the light theme; peer colors stay the same in both themes.

### Don't:
- **Don't** give coordination features card grids, floating panels, or anything that overlays the editor in the wide layout; they belong in the top bar, plan rail, or side rails.
- **Don't** use a peer hue for anything that is not a person or their agent, and don't use the accent blue for a person.
- **Don't** put white text on a peer fill; name tags and avatars use `name-ink`.
- **Don't** use monospace for UI labels; it is for file text, paths and the room code.
- **Don't** add a second accent or a gradient; the only color beyond the neutral ladder comes from status tones and people.
