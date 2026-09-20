import {
  createVillageClient,
  extractCurrentMemories,
  snapshotToMarkdown,
} from "./src/village-api.js";

const form = document.querySelector("#extract-form");
const slugInput = document.querySelector("#village-slug");
const concurrencyInput = document.querySelector("#concurrency");
const extractButton = document.querySelector("#extract-button");
const progressWrap = document.querySelector("#progress-wrap");
const progress = document.querySelector("#progress");
const progressLabel = document.querySelector("#progress-label");
const progressCount = document.querySelector("#progress-count");
const status = document.querySelector("#status");
const results = document.querySelector("#results");
const agentList = document.querySelector("#agent-list");
const cardTemplate = document.querySelector("#agent-card-template");
const searchInput = document.querySelector("#search");

let currentSnapshot = null;
let currentController = null;

const params = new URLSearchParams(location.search);
if (params.get("village")) slugInput.value = params.get("village");

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  currentController?.abort();
  currentController = new AbortController();
  const slug = slugInput.value.trim();
  if (!slug) return;

  setBusy(true);
  status.className = "status";
  status.textContent = "Resolving village…";
  progressWrap.hidden = false;
  progress.max = 1;
  progress.value = 0;
  progressLabel.textContent = "Resolving village…";
  progressCount.textContent = "0 / 0";

  const nextUrl = new URL(location.href);
  nextUrl.searchParams.set("village", slug);
  history.replaceState(null, "", nextUrl);

  try {
    const client = createVillageClient({ transport: "relay", retryCount: 2 });
    currentSnapshot = await extractCurrentMemories({
      slug,
      concurrency: Number(concurrencyInput.value),
      client,
      signal: currentController.signal,
      onProgress: ({ phase, completed, total, agent, village }) => {
        progress.max = Math.max(total, 1);
        progress.value = completed;
        progressCount.textContent = `${completed} / ${total}`;
        progressLabel.textContent = phase === "agents"
          ? `Found ${total} active agents in ${village.name}.`
          : `Reading ${agent?.name || "agent"}…`;
      },
    });
    renderSnapshot(currentSnapshot);
    status.textContent = `Finished. ${currentSnapshot.totals.withMemory} current memories extracted.`;
  } catch (error) {
    if (error?.name === "AbortError") return;
    status.className = "status error";
    status.textContent = error instanceof Error ? error.message : "Extraction failed.";
  } finally {
    setBusy(false);
  }
});

searchInput.addEventListener("input", () => renderAgentCards(currentSnapshot));

document.querySelector("#download-json").addEventListener("click", () => {
  if (!currentSnapshot) return;
  downloadText(
    `${safeFileName(currentSnapshot.source.villageSlug)}-current-memories.json`,
    JSON.stringify(currentSnapshot, null, 2),
    "application/json",
  );
});

document.querySelector("#download-markdown").addEventListener("click", () => {
  if (!currentSnapshot) return;
  downloadText(
    `${safeFileName(currentSnapshot.source.villageSlug)}-current-memories.md`,
    snapshotToMarkdown(currentSnapshot),
    "text/markdown",
  );
});

document.querySelector("#copy-all").addEventListener("click", async (event) => {
  if (!currentSnapshot) return;
  await navigator.clipboard.writeText(snapshotToMarkdown(currentSnapshot));
  flashButton(event.currentTarget, "Copied!");
});

function setBusy(busy) {
  extractButton.disabled = busy;
  slugInput.disabled = busy;
  concurrencyInput.disabled = busy;
  extractButton.textContent = busy ? "Extracting…" : "Extract current memories";
}

function renderSnapshot(snapshot) {
  results.hidden = false;
  document.querySelector("#stat-agents").textContent = snapshot.totals.agents;
  document.querySelector("#stat-memories").textContent = snapshot.totals.withMemory;
  document.querySelector("#stat-empty").textContent = snapshot.totals.withoutMemory;
  document.querySelector("#stat-errors").textContent = snapshot.totals.errors;
  document.querySelector("#village-title").textContent = `${snapshot.source.villageName} · current memories`;
  document.querySelector("#snapshot-meta").textContent = `${snapshot.source.villageSlug} · ${snapshot.totals.excludedInactive ?? 0} inactive/historical excluded · exported ${formatTimestamp(snapshot.exportedAt)}`;
  renderAgentCards(snapshot);
}

function renderAgentCards(snapshot) {
  agentList.textContent = "";
  if (!snapshot) return;
  const query = searchInput.value.trim().toLowerCase();
  const entries = snapshot.agents.filter((entry) => {
    if (!query) return true;
    return [
      entry.agent.name,
      entry.agent.modelString,
      entry.agent.statusMessage,
      entry.agent.goal,
      entry.memory?.content,
      entry.error,
    ].some((value) => String(value || "").toLowerCase().includes(query));
  });

  for (const entry of entries) {
    const fragment = cardTemplate.content.cloneNode(true);
    const card = fragment.querySelector(".memory-card");
    fragment.querySelector(".agent-name").textContent = `${entry.agent.emoji ? `${entry.agent.emoji} ` : ""}${entry.agent.name}`;
    fragment.querySelector(".agent-meta").textContent = [entry.agent.modelString, entry.agent.id].filter(Boolean).join(" · ");
    const state = fragment.querySelector(".memory-state");
    const content = fragment.querySelector(".memory-content");
    const copyButton = fragment.querySelector(".copy-memory");

    if (entry.memory) {
      state.textContent = `Latest saved ${formatTimestamp(entry.memory.createdAt)} · memory ${entry.memory.id}`;
      content.textContent = entry.memory.content || "";
      copyButton.addEventListener("click", async () => {
        await navigator.clipboard.writeText(entry.memory.content || "");
        flashButton(copyButton, "Copied!");
      });
    } else {
      card.classList.add("empty");
      copyButton.disabled = true;
      if (entry.error) {
        state.classList.add("error");
        state.textContent = `Could not read memory: ${entry.error}`;
      } else {
        state.textContent = "No saved memory returned for this agent.";
      }
    }
    agentList.append(fragment);
  }

  if (entries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "panel controls muted";
    empty.textContent = "No agents match that search.";
    agentList.append(empty);
  }
}

function formatTimestamp(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function safeFileName(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "ai-village";
}

function downloadText(name, text, type) {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function flashButton(button, label) {
  const old = button.textContent;
  button.textContent = label;
  setTimeout(() => { button.textContent = old; }, 1000);
}
