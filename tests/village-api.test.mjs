import test from "node:test";
import assert from "node:assert/strict";
import {
  createVillageClient,
  extractCurrentMemories,
  parseRelayedJson,
  snapshotToMarkdown,
} from "../src/village-api.js";

test("parseRelayedJson accepts raw JSON", () => {
  assert.deepEqual(parseRelayedJson('{"ok":true}'), { ok: true });
});

test("parseRelayedJson accepts Jina Reader wrapper", () => {
  const wrapped = "Title: Example\n\nMarkdown Content:\n{\"dates\":[\"2026-09-20\"]}";
  assert.deepEqual(parseRelayedJson(wrapped), { dates: ["2026-09-20"] });
});

test("extractCurrentMemories returns newest memory per active roster agent", async () => {
  const village = {
    id: "v1",
    slug: "actual-launch-1",
    name: "Actual Launch",
    agents: [
      { id: "a1", name: "Agent One", modelString: "Model A", isParticipating: true },
      { id: "a2", name: "Agent Two", modelString: "Model B", isParticipating: true },
      { id: "a3", name: "Agent Three", isParticipating: true },
    ],
  };

  const client = {
    async loadVillage(slug) {
      assert.equal(slug, "actual-launch-1");
      return village;
    },
    async loadLatestMemory(agentId) {
      if (agentId === "a1") {
        const memories = [
          { id: "old", agentId: "a1", content: "old", createdAt: "2026-09-18T00:00:00Z", updatedAt: "2026-09-18T00:00:00Z" },
          { id: "new", agentId: "a1", content: "newest", createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-20T00:00:00Z" },
        ];
        memories.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
        return memories[0];
      }
      if (agentId === "a2") return null;
      throw new Error("simulated failure");
    },
  };

  const snapshot = await extractCurrentMemories({ slug: "actual-launch-1", concurrency: 2, client });
  assert.equal(snapshot.totals.agents, 3);
  assert.equal(snapshot.totals.excludedInactive, 0);
  assert.equal(snapshot.totals.withMemory, 1);
  assert.equal(snapshot.totals.withoutMemory, 1);
  assert.equal(snapshot.totals.errors, 1);
  assert.equal(snapshot.agents[0].memory.id, "new");
  assert.match(snapshot.agents[2].error, /simulated failure/);
  assert.match(snapshotToMarkdown(snapshot), /Agent One/);
  assert.match(snapshotToMarkdown(snapshot), /newest/);
});

test("inactive and historical agents are excluded before memory requests", async () => {
  const requested = [];
  const client = {
    async loadVillage() {
      return {
        id: "v1",
        slug: "actual-launch-1",
        name: "Actual Launch",
        agents: [
          { id: "active", name: "Active Agent", isParticipating: true },
          { id: "inactive", name: "Inactive Agent", isParticipating: false },
          { id: "historical", name: "Historical Agent" },
        ],
      };
    },
    async loadLatestMemory(agentId) {
      requested.push(agentId);
      return {
        id: `memory-${agentId}`,
        agentId,
        content: "active memory",
        createdAt: "2026-09-20T00:00:00Z",
        updatedAt: "2026-09-20T00:00:00Z",
      };
    },
  };

  const snapshot = await extractCurrentMemories({ slug: "actual-launch-1", client });
  assert.deepEqual(requested, ["active"]);
  assert.equal(snapshot.totals.agents, 1);
  assert.equal(snapshot.totals.excludedInactive, 2);
  assert.deepEqual(snapshot.agents.map((entry) => entry.agent.id), ["active"]);
  assert.doesNotMatch(snapshotToMarkdown(snapshot), /Inactive Agent|Historical Agent/);
});

test("createVillageClient parses relayed endpoint responses", async () => {
  const fetchImpl = async (url) => {
    const target = String(url).replace("https://r.jina.ai/https://theaidigest.org/village", "");
    const payload = target.startsWith("/api/villages?slug=")
      ? { id: "v1", slug: "x", name: "X" }
      : target === "/api/villages/v1"
        ? { id: "v1", slug: "x", name: "X", agents: [{ id: "a", name: "A", isParticipating: true }] }
        : { memories: [{ id: "m", agentId: "a", content: "hello", createdAt: "2026-09-20T00:00:00Z", updatedAt: "2026-09-20T00:00:00Z" }] };
    return {
      ok: true,
      status: 200,
      async text() { return `Markdown Content:\n${JSON.stringify(payload)}`; },
    };
  };
  const client = createVillageClient({ fetchImpl, transport: "relay", retryCount: 0 });
  const village = await client.loadVillage("x");
  assert.equal(village.agents[0].name, "A");
  const memory = await client.loadLatestMemory("a");
  assert.equal(memory.content, "hello");
});
