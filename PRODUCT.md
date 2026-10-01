# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

Delegated: distributed as a Codex plugin (this repo is its marketplace). Vite + React + CodeMirror 6 with y-codemirror.next for the editor UI (`apps/web`), served by a local Node daemon (`apps/daemon`) running on Codex's bundled Node. Signaling is either the host's own room behind a Cloudflare quick tunnel (direct mode, default) or a Cloudflare Worker (`apps/signal`, hosted mode).

## Users

Small groups (2–8) co-editing a folder in the OpenAI Codex desktop app, first of all researchers polishing a Markdown or LaTeX paper together. Each person has their own Codex agent in the chat on the left; this UI sits in the in-app browser pane on the right (roughly 700–1000px wide). Collaborators may be in different countries, so the interface follows the browser language (English and Traditional Chinese).

## Product Purpose

Live Share for Codex: the whole working folder is shared over WebRTC, people edit it together with live cursors, and every person's Codex agent can edit it too. Spoken discussion is transcribed per speaker so an agent can act on "what we just discussed". Success: people can talk, edit, and direct their agents in one place without stepping on each other.

## Positioning

Agents are first-class participants. Before an agent edits, it publishes a short plan (1–5 one-line items) that everyone sees, labelled with whose agent it is ("Alice's Codex"), and checks items off live. A PreToolUse hook enforces plan-before-edit. The meeting transcript is readable by the agents.

## Operating Context

- The UI lives in a narrow side pane next to the agent chat; the editor is the primary surface. Agent plans stay visible as a compact strip and expand for detail; the transcript lives in a collapsible side panel.
- Joining: the host shares an invite link (`https://….trycloudflare.com/j/CODE` in direct mode). Guests install the plugin, open an empty folder in Codex, tell their agent "Join live share <link>", and the host admits them (edit or view-only) from this UI.
- First run happens in the UI, not an installer: confirming the display name, and adding an OpenAI or Gemini key when the microphone is first used.
- Each person transcribes only their own microphone with their own API key; there is no built-in voice call (people use their usual call or sit in one room).

## Capabilities and Constraints

- Text files are CRDT-merged character by character; binaries are last-writer-wins; `.git`, `node_modules`, `.env*`, `.gitignore` entries, and TeX build products are never shared.
- Room membership, plans, transcript, and agent edits are shared state; signaling (the host's own room in direct mode, the Worker in hosted mode) only relays WebRTC negotiation and admissions.
- Two connection modes: direct (no central server, STUN only, may fail behind strict NAT) and hosted (adds Cloudflare TURN relay). Direct is the default; hosted is the managed-service path.
- Up to 8 peers per room.

## Product Principles

1. The editor comes first; coordination surfaces never crowd the text.
2. Every change is attributable: people and their agents are always named and colored consistently.
3. Agents announce before they act; plans are short enough to read at a glance.
4. Nothing leaves the group except what WebRTC and the user's own transcription provider need.
