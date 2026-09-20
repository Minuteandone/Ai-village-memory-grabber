# AI Village Current Memory Extractor

A zero-dependency static tool that extracts the **newest saved memory version** for every currently participating agent in a public AI Village.

It is intentionally modeled after the memory/data route used by [Aivillagenews / Village Archive](https://github.com/Minuteandone/Aivillagenews):

- Resolve a public village from its slug.
- Read the village agent roster.
- Keep only agents where `isParticipating === true`.
- Query `/api/agent/{agentId}/memories` for each active agent.
- Sort returned memory versions newest-first and keep the newest one.
- Use Jina Reader as a read-only CORS relay on static hosting because AI Digest's public API does not currently expose browser CORS headers to GitHub Pages.

## Features

- Defaults to `actual-launch-1`, but accepts any public village slug.
- Excludes inactive, removed, and historical roster entries before making memory requests.
- Bounded concurrency (1–6 in the UI) to reduce relay rate-limit pressure.
- Retries transient 429/5xx relay failures.
- Keeps going when one active agent fails.
- Shows counts for memories, missing memories, and errors.
- Search across agent names, model names, status/goals, and memory text.
- Per-agent copy button.
- Combined self-describing JSON export.
- Human-readable Markdown export.
- No credentials, analytics, backend, or external JavaScript dependencies.

## What “current” means

This tool does **not** claim to expose hidden model context. “Current memory” means the newest saved memory object returned by the public AI Village memory endpoint at the moment of extraction.

Only agents explicitly marked as currently participating by the Village roster are included. Historical/inactive entries are omitted from the agent list and are not queried for memory.

## Run locally

```bash
npm test
npm run serve
```

Then open `http://localhost:5173`.

The app still uses the Jina relay when served locally, so it does not require a development proxy.

## GitHub Pages

Because the project is plain static HTML/CSS/JS, you can publish the repository root directly with GitHub Pages. No build step is required.

You can deep-link a village with:

```text
?village=actual-launch-1
```

## Snapshot format

The JSON export includes:

- export time and source village metadata
- active-agent extraction totals
- a count of inactive/historical roster entries that were excluded
- normalized active-agent metadata
- newest memory object for each active agent, or `null`
- a per-agent error string if that memory fetch failed

Schema identifier:

```json
{
  "schemaVersion": 1,
  "exportType": "ai-village-current-memories"
}
```
