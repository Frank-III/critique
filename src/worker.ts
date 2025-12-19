import { Hono } from "hono"
import { cors } from "hono/cors"
import { stream } from "hono/streaming"
import type { KVNamespace } from "@cloudflare/workers-types"

type Bindings = {
  CRITIQUE_KV: KVNamespace
  E2B_API_KEY: string
  E2B_TEMPLATE: string
  GITHUB_TOKEN?: string
}

const app = new Hono<{ Bindings: Bindings }>()

// Enable CORS for all routes
app.use("*", cors())

// =============================================================================
// GitHub URL Parsing
// =============================================================================

interface GitHubPRInfo {
  type: "pull"
  owner: string
  repo: string
  number: number
}

interface GitHubCommitInfo {
  type: "commit"
  owner: string
  repo: string
  sha: string
}

interface GitHubCompareInfo {
  type: "compare"
  owner: string
  repo: string
  base: string
  head: string
}

type GitHubInfo = GitHubPRInfo | GitHubCommitInfo | GitHubCompareInfo

function parseGitHubUrl(path: string): GitHubInfo | null {
  // Remove leading slash and optional github.com prefix
  path = path.replace(/^\/+/, "").replace(/^github\.com\//, "")

  // Match: owner/repo/pull/123
  const prMatch = path.match(/^([^/]+)\/([^/]+)\/pull\/(\d+)$/)
  if (prMatch && prMatch[1] && prMatch[2] && prMatch[3]) {
    return {
      type: "pull",
      owner: prMatch[1],
      repo: prMatch[2],
      number: parseInt(prMatch[3], 10),
    }
  }

  // Match: owner/repo/commit/sha
  const commitMatch = path.match(/^([^/]+)\/([^/]+)\/commit\/([a-f0-9]+)$/i)
  if (commitMatch && commitMatch[1] && commitMatch[2] && commitMatch[3]) {
    return {
      type: "commit",
      owner: commitMatch[1],
      repo: commitMatch[2],
      sha: commitMatch[3],
    }
  }

  // Match: owner/repo/compare/base...head
  const compareMatch = path.match(/^([^/]+)\/([^/]+)\/compare\/([^.]+)\.\.\.(.+)$/)
  if (compareMatch && compareMatch[1] && compareMatch[2] && compareMatch[3] && compareMatch[4]) {
    return {
      type: "compare",
      owner: compareMatch[1],
      repo: compareMatch[2],
      base: compareMatch[3],
      head: compareMatch[4],
    }
  }

  return null
}

function getCacheKey(info: GitHubInfo): string {
  switch (info.type) {
    case "pull":
      return `gh:${info.owner}/${info.repo}/pull/${info.number}`
    case "commit":
      return `gh:${info.owner}/${info.repo}/commit/${info.sha}`
    case "compare":
      return `gh:${info.owner}/${info.repo}/compare/${info.base}...${info.head}`
  }
}

// =============================================================================
// GitHub API
// =============================================================================

async function fetchGitHubDiff(info: GitHubInfo, token?: string): Promise<string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3.diff",
    "User-Agent": "critique-worker",
  }

  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  let url: string
  switch (info.type) {
    case "pull":
      url = `https://api.github.com/repos/${info.owner}/${info.repo}/pulls/${info.number}`
      break
    case "commit":
      url = `https://api.github.com/repos/${info.owner}/${info.repo}/commits/${info.sha}`
      break
    case "compare":
      url = `https://api.github.com/repos/${info.owner}/${info.repo}/compare/${info.base}...${info.head}`
      break
  }

  const response = await fetch(url, { headers })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`GitHub API error ${response.status}: ${text}`)
  }

  return response.text()
}

// =============================================================================
// E2B Sandbox
// =============================================================================

interface E2BSandbox {
  sandboxId: string
}

async function createE2BSandbox(apiKey: string, template: string): Promise<E2BSandbox> {
  const response = await fetch("https://api.e2b.dev/sandboxes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-Key": apiKey,
    },
    body: JSON.stringify({
      templateID: template,
      timeout: 60, // 60 seconds timeout
    }),
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`E2B API error ${response.status}: ${text}`)
  }

  const data = await response.json() as { sandboxId: string }
  return { sandboxId: data.sandboxId }
}

async function writeFileToSandbox(
  apiKey: string,
  sandboxId: string,
  path: string,
  content: string
): Promise<void> {
  const response = await fetch(
    `https://api.e2b.dev/sandboxes/${sandboxId}/files`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({
        path,
        content: Buffer.from(content).toString("base64"),
      }),
    }
  )

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`E2B file write error ${response.status}: ${text}`)
  }
}

async function runCommandInSandbox(
  apiKey: string,
  sandboxId: string,
  command: string
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const response = await fetch(
    `https://api.e2b.dev/sandboxes/${sandboxId}/commands`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
      },
      body: JSON.stringify({
        command,
        timeout: 30, // 30 seconds for command execution
      }),
    }
  )

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`E2B command error ${response.status}: ${text}`)
  }

  return response.json() as Promise<{ stdout: string; stderr: string; exitCode: number }>
}

async function killSandbox(apiKey: string, sandboxId: string): Promise<void> {
  await fetch(`https://api.e2b.dev/sandboxes/${sandboxId}`, {
    method: "DELETE",
    headers: {
      "X-API-Key": apiKey,
    },
  })
}

async function renderDiffWithE2B(
  diff: string,
  apiKey: string,
  template: string,
  cols: number = 240,
  rows: number = 2000
): Promise<string> {
  const sandbox = await createE2BSandbox(apiKey, template)

  try {
    // Write diff to temp file in sandbox
    await writeFileToSandbox(apiKey, sandbox.sandboxId, "/tmp/diff.patch", diff)

    // Run critique to render the diff
    const result = await runCommandInSandbox(
      apiKey,
      sandbox.sandboxId,
      `critique web --patch /tmp/diff.patch --stdout --cols ${cols} --rows ${rows}`
    )

    if (result.exitCode !== 0) {
      throw new Error(`critique failed: ${result.stderr}`)
    }

    return result.stdout
  } finally {
    // Always cleanup the sandbox
    await killSandbox(apiKey, sandbox.sandboxId)
  }
}

// =============================================================================
// Routes
// =============================================================================

// Redirect root to GitHub repo
app.get("/", (c) => {
  return c.redirect("https://github.com/remorses/critique")
})

// Upload HTML content (existing endpoint)
app.post("/upload", async (c) => {
  try {
    const body = await c.req.json<{ html: string }>()

    if (!body.html || typeof body.html !== "string") {
      return c.json({ error: "Missing or invalid 'html' field" }, 400)
    }

    const encoder = new TextEncoder()
    const data = encoder.encode(body.html)
    const hashBuffer = await crypto.subtle.digest("SHA-256", data)
    const hashArray = Array.from(new Uint8Array(hashBuffer))
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, "0")).join("")
    const id = hashHex.slice(0, 32)

    await c.env.CRITIQUE_KV.put(id, body.html, {
      expirationTtl: 60 * 60 * 24 * 7, // 7 days
    })

    const url = new URL(c.req.url)
    const viewUrl = `${url.origin}/view/${id}`

    return c.json({ id, url: viewUrl })
  } catch (error) {
    return c.json({ error: "Failed to process upload" }, 500)
  }
})

// View cached HTML content
app.get("/view/:id", async (c) => {
  const id = c.req.param("id")

  if (!id || !/^[a-f0-9]{16,32}$/.test(id)) {
    return c.text("Invalid ID", 400)
  }

  const html = await c.env.CRITIQUE_KV.get(id)

  if (!html) {
    return c.text("Not found", 404)
  }

  return stream(c, async (s) => {
    c.header("Content-Type", "text/html; charset=utf-8")
    c.header("Cache-Control", "public, max-age=3600")

    const chunkSize = 16 * 1024
    let offset = 0

    while (offset < html.length) {
      const chunk = html.slice(offset, offset + chunkSize)
      await s.write(chunk)
      offset += chunkSize
    }
  })
})

// Get raw HTML content
app.get("/raw/:id", async (c) => {
  const id = c.req.param("id")

  if (!id || !/^[a-f0-9]{16,32}$/.test(id)) {
    return c.json({ error: "Invalid ID" }, 400)
  }

  const html = await c.env.CRITIQUE_KV.get(id)

  if (!html) {
    return c.json({ error: "Not found" }, 404)
  }

  return c.text(html, 200, {
    "Content-Type": "text/html; charset=utf-8",
  })
})

// Check if content exists
app.on("HEAD", "/view/:id", async (c) => {
  const id = c.req.param("id")

  if (!id || !/^[a-f0-9]{16,32}$/.test(id)) {
    return c.body(null, 400)
  }

  const html = await c.env.CRITIQUE_KV.get(id)

  if (!html) {
    return c.body(null, 404)
  }

  c.header("Content-Length", String(html.length))
  return c.body(null, 200)
})

// =============================================================================
// GitHub Diff Viewer Routes
// =============================================================================

// Handle GitHub URLs: /owner/repo/pull/123, /owner/repo/commit/sha, etc.
app.get("/:owner/:repo/:type/:ref", async (c) => {
  const path = c.req.path
  const info = parseGitHubUrl(path)

  if (!info) {
    return c.text("Invalid GitHub URL format", 400)
  }

  // Check cache first
  const cacheKey = getCacheKey(info)
  const cached = await c.env.CRITIQUE_KV.get(cacheKey)

  if (cached) {
    return stream(c, async (s) => {
      c.header("Content-Type", "text/html; charset=utf-8")
      c.header("Cache-Control", "public, max-age=300") // 5 min cache for GitHub content
      c.header("X-Cache", "HIT")

      const chunkSize = 16 * 1024
      let offset = 0

      while (offset < cached.length) {
        const chunk = cached.slice(offset, offset + chunkSize)
        await s.write(chunk)
        offset += chunkSize
      }
    })
  }

  // Check for required E2B API key
  if (!c.env.E2B_API_KEY) {
    return c.json({ error: "E2B API key not configured" }, 500)
  }

  try {
    // Fetch diff from GitHub
    const diff = await fetchGitHubDiff(info, c.env.GITHUB_TOKEN)

    if (!diff.trim()) {
      return c.text("No diff content", 404)
    }

    // Render with E2B
    const html = await renderDiffWithE2B(
      diff,
      c.env.E2B_API_KEY,
      c.env.E2B_TEMPLATE || "critique-sandbox"
    )

    // Cache the result (shorter TTL for PRs since they can change)
    const ttl = info.type === "pull" ? 60 * 60 : 60 * 60 * 24 * 7 // 1 hour for PRs, 7 days for commits
    await c.env.CRITIQUE_KV.put(cacheKey, html, { expirationTtl: ttl })

    return stream(c, async (s) => {
      c.header("Content-Type", "text/html; charset=utf-8")
      c.header("Cache-Control", "public, max-age=300")
      c.header("X-Cache", "MISS")

      const chunkSize = 16 * 1024
      let offset = 0

      while (offset < html.length) {
        const chunk = html.slice(offset, offset + chunkSize)
        await s.write(chunk)
        offset += chunkSize
      }
    })
  } catch (error: any) {
    console.error("Error rendering GitHub diff:", error)
    return c.json({ error: error.message || "Failed to render diff" }, 500)
  }
})

// Handle compare URLs: /owner/repo/compare/base...head
app.get("/:owner/:repo/compare/:spec", async (c) => {
  const path = c.req.path
  const info = parseGitHubUrl(path)

  if (!info || info.type !== "compare") {
    return c.text("Invalid compare URL format", 400)
  }

  // Same logic as above - check cache, fetch, render, cache
  const cacheKey = getCacheKey(info)
  const cached = await c.env.CRITIQUE_KV.get(cacheKey)

  if (cached) {
    return stream(c, async (s) => {
      c.header("Content-Type", "text/html; charset=utf-8")
      c.header("Cache-Control", "public, max-age=300")
      c.header("X-Cache", "HIT")

      const chunkSize = 16 * 1024
      let offset = 0

      while (offset < cached.length) {
        const chunk = cached.slice(offset, offset + chunkSize)
        await s.write(chunk)
        offset += chunkSize
      }
    })
  }

  if (!c.env.E2B_API_KEY) {
    return c.json({ error: "E2B API key not configured" }, 500)
  }

  try {
    const diff = await fetchGitHubDiff(info, c.env.GITHUB_TOKEN)

    if (!diff.trim()) {
      return c.text("No diff content", 404)
    }

    const html = await renderDiffWithE2B(
      diff,
      c.env.E2B_API_KEY,
      c.env.E2B_TEMPLATE || "critique-sandbox"
    )

    await c.env.CRITIQUE_KV.put(cacheKey, html, { expirationTtl: 60 * 60 }) // 1 hour

    return stream(c, async (s) => {
      c.header("Content-Type", "text/html; charset=utf-8")
      c.header("Cache-Control", "public, max-age=300")
      c.header("X-Cache", "MISS")

      const chunkSize = 16 * 1024
      let offset = 0

      while (offset < html.length) {
        const chunk = html.slice(offset, offset + chunkSize)
        await s.write(chunk)
        offset += chunkSize
      }
    })
  } catch (error: any) {
    console.error("Error rendering GitHub compare diff:", error)
    return c.json({ error: error.message || "Failed to render diff" }, 500)
  }
})

export default app
