# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Start Electron app in development mode (hot-reloads renderer; main process requires restart)
npm run build      # Build for production (electron-vite build)
npm run package    # Build + package as a Windows portable .exe (electron-builder)
```

> **Important:** Changes to `src/main/` or `src/preload/` are **not** hot-reloaded. Stop and restart `npm run dev` after editing those files.

---

## Architecture

This is an **Electron + React** desktop app built with `electron-vite`. It wraps the *OMNI DIRECTOR ENGINE 11.1 9B* prompt system, connecting to any OpenAI-compatible local or cloud API (LM Studio, Ollama, OpenAI, Groq, etc.).

### Process boundary

```
src/main/           ← Node.js / Electron main process
  index.js          ← BrowserWindow creation, app menu, UTF-8 console fix (Win32)
  ipc-handlers.js   ← All IPC channels: file I/O, HTTP fetch, LM Studio SDK calls

src/preload/
  index.js          ← contextBridge — exposes window.electronAPI.* to renderer

src/renderer/       ← React SPA (Vite, no Node access)
  components/App.jsx          ← Root state owner; all business logic lives here
  components/settings/        ← SettingsPanel (server/connection), AppSettingsPanel (UI prefs)
  components/input/           ← Description textarea, image input (URL or file), dual-image toggle
  components/modules/         ← ModuleSelector grid, ModuleCreator (AI-assisted creation)
  components/output/          ← OutputPanel (markdown), RefinementMenu (A–I options)
  lib/modules.js              ← Static array of built-in modules LS + L1–L30 with variants
  lib/imageUtils.js           ← Builds OpenAI content arrays; injects module code + generation target
  lib/lmStudioClient.js       ← Thin wrapper around window.electronAPI calls
  store/conversationStore.js  ← Pure functions: create / appendUser / appendAssistant
```

### Data flow for a generation

1. **System prompt** is lazy-loaded once via `ipc-handlers.js → read-system-prompt`, which reads `../OMNI DIRECTOR ENGINE 11.1 9B.md`, appends Rule 18, and injects any custom module definitions in the same format as L1–L30.
2. **User message** is built by `buildMessageContent()` in `imageUtils.js` — combines the description text, `Apply module: <CODE>`, `Generation Target: <FLUX|Z-Image Turbo|Dual>`, and optional image parts.
3. **Conversation** is immutable plain objects managed by `conversationStore.js`. `App.jsx` owns the `conversation` state.
4. **Streaming** uses a direct `fetch()` in the renderer (not IPC) via `streamCompletion()` in `App.jsx` — this bypasses contextBridge to avoid event-listener limitations.
5. **Non-streaming** routes through IPC: `window.electronAPI.chatCompletion → chat-completion handler → fetch`.

### Custom modules

- Defined and edited in `ModuleCreator.jsx`, auto-saved to `../custom-modules/modules.json` (outside the app directory) via `auto-save-modules` IPC handler.
- On load, `ipc-handlers.js` injects their full definitions (Identity, Optical, Palette, Mood, Scene, SubjectStyling, Forbidden) into the system prompt text so the AI treats them with identical authority to L1–L30. The user message only sends `Apply module: CX01`.
- Changing custom modules invalidates the cached `systemPrompt` state, forcing a re-fetch on the next generate.

### Settings persistence

Two settings objects are saved together to Electron's `userData/config.json` via `save-config` / `load-config` IPC:
- `settings` — server connection: `{ baseUrl, apiKey, model, contextLength, autoLoadModels }`
- `appSettings` — UI preferences: `{ panelWidth, outputFontSize, previewHeight, streaming, autoNewSession, defaultModule, generationTarget }`

On startup, if `settings.autoLoadModels` is true, the app calls `lmsReloadModel` to reload the last-used model into LM Studio with the saved `contextLength` before fetching the model list.

### LM Studio model reload

Uses `@lmstudio/sdk` (WebSocket) in the main process — **not** the REST API, which has no load endpoint. The WebSocket URL is derived from `baseUrl` by stripping `/v1` and replacing `http` with `ws`. SDK errors are sanitized with a regex to strip box-drawing characters before logging.

### Key constraints

- `bufferutil` and `utf-8-validate` (optional deps of `ws` inside `@lmstudio/sdk`) are marked **external** in `electron.vite.config.mjs` — do not remove this or the app will fail to start.
- All image data sent to the API uses the `image_url` content type regardless of whether the source is a URL or a base64 data URI — the value field holds both interchangeably.
- The `max_tokens` field is always sent as `-1` to LM Studio (use full remaining context). Temperature is hardcoded at `0.7`. Neither is user-configurable.
