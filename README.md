# Orbital — AI Browser Agent

[![Build](https://img.shields.io/badge/Build-Passing-brightgreen)](#)
[![TypeScript](https://img.shields.io/badge/Language-TypeScript-3178c6)](https://www.typescriptlang.org/)
[![React](https://img.shields.io/badge/Frontend-React%20%2F%20Vite-61dafb)](https://reactjs.org/)
[![Node](https://img.shields.io/badge/Backend-Node%20%2F%20Express-339933)](https://nodejs.org/)
[![OpenAI](https://img.shields.io/badge/AI-GPT--4o-412991)](https://openai.com/)
[![MV3](https://img.shields.io/badge/Extension-Manifest%20V3-4285F4)](https://developer.chrome.com/docs/extensions/mv3/)

Orbital is a Chrome Extension that turns natural language into browser actions. Tell it what you want — it reads the page, reasons about it, and executes. Search, form-fill, CV drops, multi-step workflows. No scripts. No selectors. Just intent.

![Demo](./demo.gif)
*60-second walkthrough: searching Google, filling a multi-field form, and auto-uploading a CV.*

---

## Table of Contents

1. [How It Works](#how-it-works)
2. [System Architecture](#system-architecture)
3. [Architecture & Engineering Decisions](#architecture--engineering-decisions)
4. [Agent Loop Deep Dive](#agent-loop-deep-dive)
5. [Cost Optimization Strategy](#cost-optimization-strategy)
6. [Key Features](#key-features)
7. [Tech Stack](#tech-stack)
8. [Local Setup](#local-setup)

---

## How It Works

1. User types a goal in natural language: *"Find me a chicken curry recipe"*
2. The agent scans the live DOM, stripping it into a compact, semantically meaningful HTML snapshot
3. GPT-4o reasons about the page and returns a typed action plan (click, type, upload)
4. The agent executes each action, watches for DOM mutations and URL changes, and loops until the goal is met

---

## System Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Chrome Extension                   │
│                                                     │
│  ┌──────────────┐       ┌──────────────────────┐   │
│  │  Popup (React│       │   Content Script     │   │
│  │  + Vite)     │◄─────►│   (DOM Scanner +     │   │
│  │              │       │    Action Executor)  │   │
│  │  Agent Loop  │       └──────────────────────┘   │
│  │  SSE Reader  │                                   │
│  └──────┬───────┘                                   │
│         │ fetch (SSE)                               │
└─────────┼───────────────────────────────────────────┘
          │
┌─────────▼───────────────────────────────────────────┐
│              Node / Express Backend                 │
│                                                     │
│   POST /api/plan/stream   POST /api/quickcheck     │
│   (Server-Sent Events)    (goal-met boolean)       │
│                                                     │
│   ┌────────────────────────────────────────────┐   │
│   │              aiService.ts                  │   │
│   │  buildSystemPrompt()  getAiPlanStream()    │   │
│   │  getQuickCheck()                           │   │
│   └────────────────────────────────────────────┘   │
│                     │                              │
└─────────────────────┼──────────────────────────────┘
                      │
          ┌───────────▼───────────┐
          │    OpenAI API         │
          │    GPT-4o (stream)    │
          │    GPT-4o-mini (QC)   │
          └───────────────────────┘
```

**Data flow per agent step:**
`Popup → GET_PAGE_CONTEXT → QuickCheck API → (if needed) SCAN_PAGE → Stream Plan API → EXECUTE_ACTION → repeat`

---

## Architecture & Engineering Decisions

### DOM Representation: Simplified HTML over Raw HTML

Raw page HTML is unworkable at scale — a typical Google search results page is 400-800KB. Sending that verbatim would cost ~$0.80 per step and likely exceed context limits.

Instead, `buildSimplifiedHtml()` in the content script produces a surgical reduction:

- **Strips all noise**: `script`, `style`, `svg`, `iframe`, `img`, `video`, `noscript`, `meta`, `link` tags are excluded
- **Visibility enforcement**: `getComputedStyle()` is called on every element — hidden containers (`display: none`, `visibility: hidden`, `opacity: 0`) are excluded recursively, not just at leaf level. This prevents invisible modals and off-screen menus from polluting the context
- **Interactive element tagging**: Every `button`, `input`, `a`, `select`, `textarea`, `role="button"`, and `role="link"` element receives a deterministic `data-agent-id` attribute (`agent-0`, `agent-1`, ...) and a visible magenta outline
- **Text truncation**: Text nodes longer than 100 characters are truncated unless inside a `button`, `a`, `label`, `option`, or heading tag. Recipe pages, article bodies, and documentation become dramatically smaller
- **Shadow DOM traversal**: The scanner walks `el.shadowRoot` for every element, enabling compatibility with YouTube, Google's Material components, and other modern web apps that isolate UI in shadow trees
- **Agent ID cleanup**: On every scan cycle, all previous `data-agent-id` attributes are stripped before reassignment. Without this, step 2+ would target wrong elements — a silent correctness bug

Result: A 400KB Google results page becomes a ~26KB agent-readable snapshot. A recipe page goes from 800KB to ~38KB.

### Two-Phase Goal Detection (Cost Optimization)

Every agent step begins with a **lightweight context check** before committing to a full DOM scan and expensive GPT-4o call:

1. `GET_PAGE_CONTEXT` — synchronous message to content script, returns URL + title. Zero cost
2. `POST /api/quickcheck` — sends only the URL, title, goal, and history to `gpt-4o-mini`. ~200 tokens, ~$0.0001
3. If `goalMet: true` → skip DOM scan entirely, mark task complete
4. If `goalMet: false` → proceed to full scan + GPT-4o reasoning

On a 3-step task like "find me a chicken curry recipe", this eliminates the final step's full 38,237-char DOM scan entirely. The model can determine completion from the page title alone.

**Why `gpt-4o-mini` for quickcheck?** The decision is binary — yes or no. `gpt-4o-mini` is 20x cheaper per token than `gpt-4o` and produces identical accuracy on simple classification tasks. Routing correctly by task complexity is the most impactful cost lever in agentic systems.

### Streaming Architecture: Popup → SSE → OpenAI

The agent uses **Server-Sent Events (SSE)** for real-time thought streaming, with the popup connecting directly to the Express backend — bypassing the Chrome service worker entirely.

**Why not route through the service worker?** Chrome Manifest V3 service workers are designed for short-lived event processing, not long-held HTTP connections. A streaming fetch inside a service worker's `onMessage` handler will be killed mid-stream as the worker goes dormant — even with an active port connection. The `req.on('close')` event fires immediately when the POST body is consumed (not when the SSE client disconnects), causing an AbortController abort before OpenAI even responds.

The fix: popup fetches directly to `localhost:3000`. The popup is a real browser window with no lifetime constraints. The service worker is retained only for `chrome.tabs.sendMessage` calls (DOM scan, action execution), where short-lived handlers are appropriate.

**SSE event protocol:**
```
data: { type: "thought", data: "I can see a search bar..." }  // streams incrementally
data: { type: "usage",   data: { prompt_tokens: 8420, completion_tokens: 180, total_tokens: 8600 } }
data: { type: "plan",    data: { thought, taskCompleted, actions[] } }
data: { type: "error",   data: "..." }
```

Thought extraction uses an incremental regex (`/"thought"\s*:\s*"((?:[^"\\]|\\.)*)/`) that correctly handles JSON escape sequences mid-stream, allowing character-by-character display of the AI's reasoning without waiting for the full response.

### Page Stability Detection

After every click action, the agent needs to know when to proceed — too early and the DOM is mid-render; too late and it wastes time. Hardcoded sleeps are unreliable across site speeds.

`waitForPageStable()` implements a two-layer check:

1. **`document.readyState` gate**: waits for `'complete'` before starting mutation tracking. Prevents false positives on in-progress page loads
2. **Mutation idle detection**: a `MutationObserver` watches the full DOM tree. Any mutation resets a 500ms debounce timer. When 500ms passes with no further mutations, the page is considered stable
3. **Hard ceiling**: a configurable `timeoutMs` (default 5000ms) guarantees forward progress even on continuously-animated pages (news tickers, live feeds)

This approach correctly handles SPAs (React, Vue, Angular) where URL changes and DOM mutations are decoupled from `readyState` changes.

### Action Execution

Three action types are supported:

**`click`**: Calls `.click()` on the targeted element, then waits for either a DOM mutation or URL change via `waitForDomMutation()`. If neither occurs within 3 seconds, the action is logged as a dead click and the AI is informed to try another approach.

**`type`**: For standard inputs and textareas, sets `.value` and dispatches synthetic `input` and `change` events with `bubbles: true` — required for React/Vue controlled inputs that listen to React's synthetic event system, not native DOM events. For `<select>` elements, iterates options matching by both `.value` and `.text` to handle cases where option values are opaque IDs.

**`upload`**: Retrieves the stored CV from `chrome.storage.local` (stored as base64 on the settings page), reconstructs a `File` object, and injects it into a file input via the `DataTransfer` hack — the only reliable method for programmatically setting file input values, since `<input type="file">` blocks direct `.value` assignment for security reasons.

### Prompt Engineering: System Prompt Architecture

The system prompt is built by `buildSystemPrompt()` and has four sections:

- **GOAL DETECTION**: Instructs the model to check URL + title before planning any action. This prevents the agent from clicking into a page it's already on
- **ANTI-LOOP & FORM RULES**: Guards against the most common failure modes: repeated clicking of the same element, re-filling already-correct form fields, misreading dropdown IDs vs text labels, and scatter-shot form filling (fills field 1, 2, 3 sequentially without reading labels)
- **STATE MACHINE**: Defines explicit completion criteria for the most common task types (search, video, form). Prevents false-positive task completion ("I searched, therefore I'm done") and false-negative loops ("I'm on a recipe page but should I keep clicking?")
- **PERSONA ENGINE + FILE VAULT** (conditional): Injected only when persona/CV data is present, keeping the base prompt lean for simple tasks

### History Management

The agent maintains a rolling `localHistory` string array — a structured log of what happened at each step, from the AI's perspective:

```
[STEP 2] CLICKED "agent-20". SUCCESS: The page URL changed. Assess the new page.
[STEP 2 THOUGHT]: I see search results for chicken curry. I'll click the first recipe link.
```

This gives GPT-4o the context it needs to avoid loops, recognize new pages, and understand why previous actions succeeded or failed. History is capped at 10 entries with a `shift()` rolling window — older entries are discarded to prevent context overflow on long sessions.

---

## Agent Loop Deep Dive

```
runAgent()
  │
  ├── GET_PAGE_CONTEXT (free — no AI)
  │
  ├── /api/quickcheck (gpt-4o-mini, ~200 tokens)
  │     ├── goalMet: true  → MISSION ACCOMPLISHED ✓
  │     └── goalMet: false → continue
  │
  ├── SCAN_PAGE (content script, CPU only)
  │
  ├── /api/plan/stream (gpt-4o, SSE)
  │     ├── streams thought → displayed in real-time
  │     ├── emits usage    → token/cost counter updated
  │     └── emits plan     → { thought, taskCompleted, actions[] }
  │
  ├── [SEMI-AUTO] awaitConfirmation() — user approves/rejects
  │
  ├── for each action:
  │     ├── EXECUTE_ACTION → content script
  │     │     ├── click   → waitForDomMutation(3000)
  │     │     ├── type    → set value + dispatch events
  │     │     └── upload  → DataTransfer hack
  │     │
  │     ├── success → push to history, waitForPageStable()
  │     └── failure → contextual error log, push to history, break
  │
  ├── cap history at 10 entries
  └── loop (max 15 steps)
```

---

## Cost Optimization Strategy

| Optimization | Mechanism | Impact |
|---|---|---|
| Quick context check | `gpt-4o-mini` on URL+title only | Eliminates full scan on obvious completions |
| DOM text truncation | 100-char limit on non-interactive text nodes | ~40-60% DOM size reduction on content pages |
| Hidden element pruning | `getComputedStyle()` recursive filter | Eliminates hidden modal/dropdown noise |
| Rolling history window | `shift()` after 10 entries | Prevents context overflow on long sessions |
| Accurate cost tracking | Separate input/output token pricing ($5/$15 per 1M) | Correct cost display vs blended-rate overestimation |

**Typical costs per task type:**
- Simple search/navigation: $0.05 - $0.10
- Multi-field form fill: $0.08 - $0.15
- CV drop (navigate + upload): $0.10 - $0.20

---

## Key Features

**Semi-Auto & Full-Auto modes** — Semi-Auto pauses before each action batch, displaying the AI's reasoning and planned actions for user review. Full-Auto executes without interruption. Useful for debugging new task types or running on sensitive pages.

**Real-time thought streaming** — The AI's reasoning appears character-by-character as it generates, using SSE and incremental JSON regex extraction. The user sees *why* the agent is doing what it's doing, making the system transparent rather than a black box.

**Persona Engine** — Store name, email, LinkedIn, phone, address and any other personal data in the Settings tab. When the agent encounters a form, it maps persona fields to the correct inputs using HTML context and label analysis — not sequential filling.

**File Vault** — Upload a CV/resume (PDF/DOC, max 10MB) once. It's stored as base64 in `chrome.storage.local`. When the agent encounters a file upload input, it reconstructs the file and injects it programmatically.

**Session Cost Counter** — Live token usage and dollar cost displayed in the header, calculated with separate input ($5/1M) and output ($15/1M) pricing. Color-shifts to a warning state at 50k tokens.

**Graceful STOP** — `AbortController` propagates through the fetch chain from popup to Express to OpenAI. Stopping mid-stream cleanly cancels the API request and terminates the SSE connection without leaving the backend hanging.

---

## Tech Stack

| Category | Technology |
|---|---|
| **Extension** | Chrome MV3, TypeScript |
| **Frontend** | React, Vite, CSS |
| **Backend** | Node.js, Express, TypeScript |
| **AI** | OpenAI GPT-4o (planning), GPT-4o-mini (goal check) |
| **Streaming** | Server-Sent Events (SSE) |
| **Storage** | chrome.storage.local (persona + CV vault) |

---

## Local Setup

**Prerequisites:** Node.js 18+, OpenAI API Key, Chrome browser

**1. Clone the repo**
```bash
git clone https://github.com/your-username/orbital-agent
cd orbital-agent
```

**2. Configure the backend**
```bash
cd backend
cp .env.example .env
# Add your key:
# OPENAI_API_KEY=sk-...
npm install
npm run dev
```
Backend runs on `http://localhost:3000`.

**3. Build the extension**
```bash
cd extension
npm install
npm run build
```

**4. Load in Chrome**
- Open `chrome://extensions`
- Enable **Developer Mode** (top right toggle)
- Click **Load unpacked**
- Select the `extension/dist` folder

**5. Configure your persona** *(optional but recommended)*

Click the extension icon → **SETTINGS** tab → fill in your personal data and upload a CV.

**6. Run your first mission**

Navigate to any website, open the extension, type a goal, and hit **RUN_MISSION**.

---

## Project Structure

```
orbital-agent/
├── extension/
│   ├── src/
│   │   ├── popup/
│   │   │   ├── Popup.tsx          # Agent loop, streaming, UI
│   │   │   └── Popup.css
│   │   ├── content/
│   │   │   └── content.ts         # DOM scanner, action executor
│   │   └── background/
│   │       └── background.ts      # Service worker (minimal relay)
│   ├── manifest.json
│   └── vite.config.ts
│
└── backend/
    ├── src/
    │   ├── index.ts               # Express routes, SSE setup
    │   ├── aiService.ts           # GPT-4o streaming, quickcheck
    │   └── types.ts
    └── .env.example
```
