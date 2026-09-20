export const API_ORIGIN = "https://theaidigest.org/village";
export const RELAY_PREFIX = "https://r.jina.ai/";

export class VillageApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "VillageApiError";
    this.status = status;
  }
}

export function parseRelayedJson(text) {
  const marker = "Markdown Content:";
  const markerIndex = text.indexOf(marker);
  const jsonText = markerIndex >= 0 ? text.slice(markerIndex + marker.length).trim() : text.trim();
  try {
    return JSON.parse(jsonText);
  } catch {
    throw new VillageApiError("The public data relay returned an unreadable response.");
  }
}

function getErrorMessage(value, fallback) {
  if (value && typeof value === "object" && typeof value.error === "string") return value.error;
  return fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createVillageClient({
  fetchImpl = fetch,
  transport = "relay",
  retryCount = 2,
  retryBaseMs = 700,
} = {}) {
  async function fetchDirect(path, signal) {
    const response = await fetchImpl(`${API_ORIGIN}${path}`, {
      signal,
      headers: { Accept: "application/json" },
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new VillageApiError(
        getErrorMessage(value, `The AI Village API returned ${response.status}.`),
        response.status,
      );
    }
    return value;
  }

  async function fetchViaRelay(path, signal) {
    const targetUrl = `${API_ORIGIN}${path}`;
    const response = await fetchImpl(`${RELAY_PREFIX}${targetUrl}`, {
      signal,
      headers: { Accept: "text/plain" },
    });
    if (!response.ok) {
      throw new VillageApiError(
        response.status === 429
          ? "The public data relay is temporarily rate-limited."
          : `The public data relay returned ${response.status}.`,
        response.status,
      );
    }
    return parseRelayedJson(await response.text());
  }

  async function requestJson(path, signal) {
    let lastError;
    for (let attempt = 0; attempt <= retryCount; attempt += 1) {
      try {
        if (transport === "direct") return await fetchDirect(path, signal);
        if (transport === "relay") return await fetchViaRelay(path, signal);
        try {
          return await fetchDirect(path, signal);
        } catch (error) {
          if (signal?.aborted) throw error;
          return await fetchViaRelay(path, signal);
        }
      } catch (error) {
        lastError = error;
        if (signal?.aborted) throw error;
        const retryable = error instanceof VillageApiError && [429, 500, 502, 503, 504].includes(error.status);
        if (!retryable || attempt === retryCount) throw error;
        await sleep(retryBaseMs * 2 ** attempt);
      }
    }
    throw lastError;
  }

  async function loadVillage(rawSlug, signal) {
    const slug = String(rawSlug || "").trim();
    if (!slug) throw new VillageApiError("Enter a village slug first.");

    const summary = await requestJson(`/api/villages?slug=${encodeURIComponent(slug)}`, signal);
    if (!summary?.id || summary?.error) {
      throw new VillageApiError(summary?.error || `No village was found for “${slug}”.`, 404);
    }

    const village = await requestJson(`/api/villages/${encodeURIComponent(summary.id)}`, signal);
    return {
      id: village.id,
      slug: village.slug || summary.slug || slug,
      name: village.name || summary.name || slug,
      villageGoal: village.villageGoal ?? summary.villageGoal ?? null,
      agents: Array.isArray(village.agents) ? village.agents : [],
    };
  }

  async function loadLatestMemory(agentId, signal) {
    const response = await requestJson(`/api/agent/${encodeURIComponent(agentId)}/memories`, signal);
    if (response?.error) throw new VillageApiError(response.error);
    const memories = Array.isArray(response?.memories) ? [...response.memories] : [];
    memories.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return memories[0] || null;
  }

  return { loadVillage, loadLatestMemory, requestJson };
}

export async function extractCurrentMemories({
  slug,
  concurrency = 3,
  client = createVillageClient(),
  signal,
  onProgress = () => {},
} = {}) {
  const village = await client.loadVillage(slug, signal);
  const rosterAgents = village.agents;
  const agents = rosterAgents.filter((agent) => agent.isParticipating === true);
  const results = new Array(agents.length);
  let nextIndex = 0;
  let completed = 0;

  onProgress({ phase: "agents", completed: 0, total: agents.length, village });

  async function worker() {
    while (true) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      const index = nextIndex;
      nextIndex += 1;
      if (index >= agents.length) return;
      const agent = agents[index];

      try {
        const memory = await client.loadLatestMemory(agent.id, signal);
        results[index] = { agent: normalizeAgent(agent), memory, error: null };
      } catch (error) {
        if (signal?.aborted) throw error;
        results[index] = {
          agent: normalizeAgent(agent),
          memory: null,
          error: error instanceof Error ? error.message : "Unknown memory fetch error.",
        };
      } finally {
        completed += 1;
        onProgress({ phase: "memories", completed, total: agents.length, agent, village });
      }
    }
  }

  const workerCount = Math.max(1, Math.min(Number(concurrency) || 1, 8, Math.max(agents.length, 1)));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  const withMemory = results.filter((entry) => entry.memory).length;
  const errors = results.filter((entry) => entry.error).length;
  const withoutMemory = results.length - withMemory - errors;

  return {
    schemaVersion: 1,
    exportType: "ai-village-current-memories",
    exportedAt: new Date().toISOString(),
    source: {
      apiOrigin: API_ORIGIN,
      villageId: village.id,
      villageSlug: village.slug,
      villageName: village.name,
      agentSelection: "Only agents with isParticipating === true are included.",
      meaningOfCurrent: "Newest saved memory version returned by the public AI Village memory API for each active agent at export time.",
    },
    totals: {
      agents: results.length,
      excludedInactive: rosterAgents.length - agents.length,
      withMemory,
      withoutMemory,
      errors,
    },
    agents: results,
  };
}

function normalizeAgent(agent) {
  return {
    id: agent.id,
    name: agent.name,
    emoji: agent.emoji ?? null,
    modelString: agent.modelString ?? null,
    statusMessage: agent.statusMessage ?? null,
    goal: agent.goal ?? null,
    createdAt: agent.createdAt ?? null,
    updatedAt: agent.updatedAt ?? null,
    isParticipating: true,
  };
}

export function snapshotToMarkdown(snapshot) {
  const lines = [
    `# AI Village current memory snapshot — ${snapshot.source.villageName}`,
    "",
    `- Village slug: \`${snapshot.source.villageSlug}\``,
    `- Village ID: \`${snapshot.source.villageId}\``,
    `- Exported: ${snapshot.exportedAt}`,
    `- Active agents: ${snapshot.totals.agents}`,
    `- Inactive/historical agents excluded: ${snapshot.totals.excludedInactive ?? 0}`,
    `- With saved memory: ${snapshot.totals.withMemory}`,
    `- Without saved memory: ${snapshot.totals.withoutMemory}`,
    `- Errors: ${snapshot.totals.errors}`,
    "",
    "> Only currently participating agents are included. Current = newest saved memory returned by the public AI Village memory API at export time.",
    "",
  ];

  for (const entry of snapshot.agents) {
    const label = `${entry.agent.emoji ? `${entry.agent.emoji} ` : ""}${entry.agent.name}`;
    lines.push(`## ${label}`, "");
    lines.push(`- Agent ID: \`${entry.agent.id}\``);
    if (entry.agent.modelString) lines.push(`- Model: ${entry.agent.modelString}`);
    if (entry.memory) {
      lines.push(`- Memory saved: ${entry.memory.createdAt}`, "", entry.memory.content || "*(empty memory)*", "");
    } else if (entry.error) {
      lines.push(`- Error: ${entry.error}`, "");
    } else {
      lines.push("- No saved memory returned.", "");
    }
  }
  return lines.join("\n");
}
