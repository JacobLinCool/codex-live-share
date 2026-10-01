---
name: live-share
description: Work in a folder shared live with other people and their Codex agents (Codex Live Share). Use to start, join, open, or end a live share; whenever the workspace is in a live share session and you are about to edit files; and when the user refers to what was said in the meeting ("apply what we discussed", "照剛剛討論的改").
---

# Codex Live Share

The workspace folder can be shared live with other people. Each person edits in the shared editor in the in-app browser, and each person's Codex (you are one of them) can edit too. Other people see your plan and your edits immediately, labelled as your user's Codex.

Tools come from the `live_share` MCP server. Always pass `folder` as the absolute path of the current workspace.

## Starting or joining

- "Start live share" / "share this folder": call `live_share_start`. Then open the returned editor URL in the in-app browser (@Browser), and give the user the invite link to send. Collaborators install the Live Share plugin, open an empty folder in Codex, and say "Join live share <invite link>". The user admits them in the editor.
  - The default mode is **direct**: signaling runs on this machine through a free Cloudflare quick tunnel and peers connect to each other, with no server of ours in between. The first start may take up to a minute while cloudflared downloads.
  - Use `mode: "hosted"` only if the user asks, or if direct mode fails or a collaborator cannot connect (strict corporate or campus networks). Hosted mode adds a relay through the Live Share service.
- "Join live share https://….trycloudflare.com/j/K7QF2M": the folder must be empty. Call `live_share_join` with the full invite link (a bare code only works for hosted rooms), then open the returned editor URL in the in-app browser. If the host must approve, tell the user and stop; files arrive once approved.
- If the host restarted and sent a new link, join again with the new link from the same folder; your copy resumes.
- "Let Bob in": the user admits people in the editor; you cannot.
- "End live share": call `live_share_end`. For the host this ends it for everyone; everyone keeps their files.

## Before you edit a shared folder

Editing tools are blocked until you publish a plan. Do this every time you are asked to change files:

1. Call `live_share_status`: see who is here, which files each person has open, and every other agent's active plan. Do not edit regions another agent's plan is working on; pick other files or sections, or ask the user.
2. If the request refers to the discussion, call `read_transcript` (use `since_minutes`, e.g. 15, or page with `after`). Base your work on what was actually said, and attribute decisions to the speaker when you report back.
3. Call `plan_publish` with 1-5 items. Each item is one line, at most 30 words or CJK characters, written for the humans watching ("Tighten abstract to 150 words", "依討論改寫 intro 第二段"), with `files` set to the paths it touches.
4. Work item by item. Call `plan_update` with `in_progress` when you start an item and `done` when it is finished (`dropped` if you skip it). Keep the plan honest: if the work changes, publish a new plan instead of silently diverging.
5. When everything is done, the last `done` closes the plan. If you stop early, call `plan_finish` with `abandoned`.

Make edits small and local. People may be typing in the same file; the sync merges character by character, so rewriting a whole file to change one paragraph destroys their concurrent work. Prefer targeted patches.

## Tone

Report in one or two sentences what you changed and which plan items are done. Do not paste the transcript back to the user.
