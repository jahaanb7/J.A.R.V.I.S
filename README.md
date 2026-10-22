# Buffy

Personal AI assistant. Electron + TypeScript, local-first, free models only.

## Run

```bash
npm install
npm run typecheck   # build and test typechecks
npm test            # vitest unit tests
npm start           # builds, then launches the desktop app
```

## Cloud model (Anthropic)

Set `ANTHROPIC_API_KEY` and Buffy uses Claude instead of Ollama. The key stays in the main process and is never sent to the renderer or phone page.

```bash
ANTHROPIC_API_KEY=sk-ant-... npm start
```

Override the model with `JARVIS_CLOUD_MODEL` (default `claude-sonnet-4-5`). This is a paid API, billed per token, so check your Anthropic usage limits first.

## Coding agent (project folder)

Set `JARVIS_PROJECT_DIR` to a folder and Buffy can work in it:

- Reads, listing, and text search run automatically (`code.read`, `code.list`, `code.search`). Paths outside the folder are refused, and `node_modules`, `.git`, and `dist` are skipped.
- Writing or overwriting a file (`code.write`) waits for approval in the Approvals panel.
- Running a shell command (`code.run`, for example `npm test`) always waits for approval, and it runs with your user's permissions, not in a sandbox. Read each command before approving it.

```bash
ANTHROPIC_API_KEY=sk-ant-... JARVIS_PROJECT_DIR="$HOME/Coding/MyApp" npm start
```

Without `JARVIS_PROJECT_DIR`, the code tools are not registered and the assistant has no file or command access.

## Deploy

Buffy is a desktop app, not a hosted service. To use it on another Mac, build a package with `npx electron-builder` (not yet configured here), or run from source with `npm install && npm start` on that machine. There is no server to deploy. The phone companion runs inside the desktop app and is reachable only on the same Wi-Fi.

## Local model (free)

Install [Ollama](https://ollama.com), then pull a model:

```bash
ollama pull llama3.2
```

Override with `JARVIS_MODEL` and `OLLAMA_URL`. Without Ollama the app still runs; chat reports that the model is unavailable.

Buffy uses Ollama's native tool calling. Set `JARVIS_NUM_CTX` (for example `8192`) to enlarge the context window for longer work.

Tested on an Apple M1 with 16 GB RAM:

- `llama3.2` (default): about 7 seconds per reply. Gets most requests right, but sometimes gets an event end time wrong, so check the confirmation (it prints the times it used).
- `qwen3.5:4b`: more accurate on times, but about 30 to 45 seconds per reply, so it is slower. Set `JARVIS_MODEL=qwen3.5:4b` to try it.

Times without an offset are your computer's local time. Times may also include an offset, such as `2026-10-15T16:00:00-04:00`.

## Phone companion

The desktop app serves a token-protected page on port 7777 (`JARVIS_COMPANION_PORT` to change it).
Open the address shown in the app's Phone companion panel on a phone on the same Wi-Fi, then paste the pairing token.
It is plain HTTP on the local network. Do not expose it to the internet.

## Demo checklist (all free)

1. Install Ollama and run `ollama pull llama3.2`. Make sure Ollama is running (`curl http://127.0.0.1:11434/api/tags` should list the model).
2. `npm install`, then `npm start`. Allow incoming connections if macOS asks; the phone page needs them.
3. In the desktop chat, try: "Add physics review tomorrow 4pm to 5pm", "Add a task to buy resistors, priority 2", "Remember I'm applying to Ivy League schools next year", then "What tasks do I have?".
4. Try "Delete my physics review". It should wait in the Approvals panel until you approve it.
5. On a phone on the same Wi-Fi, open the companion address from the app and paste the token. Send the same chat messages.
6. Press the kill switch, then send a message. Everything should be blocked until you resume.

Voice input uses the browser speech API in the orb (see below). It has not been verified end to end yet.

## Orb

A small always-on-top orb floats over your other apps. Click it to open a compact panel for typing or speaking to Buffy. Replies appear in the panel and are read aloud (turn this off with VOICE ON / OFF).

- `Option+Space` (Alt+Space) shows or hides the orb. The menu bar item "Buffy" has the same toggle and opens the main window.
- Esc collapses the panel, then hides the orb.
- Only the orb page may use the microphone. Speech input needs the browser speech service, which can fail offline with a `network` error. Typing always works.
- Replies cleaned for speech drop code blocks and markdown and are cut at about 400 characters, so long answers are not read in full. The full reply stays in the chat history.

## What works now

- Permission gate: reads and local writes run automatically. Deletes and anything external or system-level wait for approval. A kill switch blocks everything.
- Audit log of every tool call and decision.
- Calendar with conflict detection and a suggested free slot. Changes push live to the desktop UI.
- Tasks with priority and due dates.
- Memory with keyword recall, plus forget.
- Assistant chat with tool calls (for example, "add physics review Thursday 4pm").
- Phone companion: chat, schedule, tasks, approvals, pause and resume, and a daily briefing.
- Daily briefing (`briefing.today`): today's events, top tasks, and deadlines in the next 3 days. No model call needed.

## Widgets and sticky notes

Buffy can draw small windows that float above every app, including full-screen ones.

- **Sticky notes:** ask “sticky note: call the lab at 3pm”, or type in the Today page. A note shows for the number of seconds you ask for (25 by default), then hides. Press `⌘⇧S` anywhere to bring back the last one or hide them all. Press Esc or × inside a note to hide it. Notes keep their text.
- **Custom widgets:** ask Buffy to build one, for example “make a pomodoro timer widget”. The model writes the HTML, CSS, and JavaScript; Buffy saves it under your app data folder (`widgets/`) and shows it. Manage them on the Widgets page.
- **Sandbox:** widgets run with no network access, no Node.js, and no file access. Buffy blocks iframes, external scripts, and network calls in the HTML before saving, and the window enforces a Content Security Policy at runtime. A widget can only hide itself and read or write its own data.
- **Permissions:** creating and showing widgets runs automatically, because it only changes Buffy's own folder. Deleting a widget asks for approval.

## Not yet built

Wake word, offline speech-to-text and text-to-speech, screen awareness, computer control, the coding agent that edits your projects, semantic memory, Google Calendar sync, the learning, maker, and career modules. See the plan for the full phase list.

Known model limits (llama3.2 on a 16 GB Mac):

- Generated widgets sometimes miss features or set an auto-hide you didn't ask for. Check what it made on the Widgets page.
- A slow reply can time out after two minutes. Buffy reports that the model is unavailable, and you can ask again.
- Event end times are sometimes wrong. Replies print the times used, so check them.
