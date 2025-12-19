import { Hono } from "hono"
import { cors } from "hono/cors"
import { handle } from "hono/vercel"
import { Sandbox } from "e2b"

// =============================================================================
// Types
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

// =============================================================================
// GitHub URL Parsing
// =============================================================================

function parseGitHubUrl(path: string): GitHubInfo | null {
  path = path.replace(/^\/+/, "").replace(/^github\.com\//, "")

  const prMatch = path.match(/^([^/]+)\/([^/]+)\/pull\/(\d+)$/)
  if (prMatch && prMatch[1] && prMatch[2] && prMatch[3]) {
    return {
      type: "pull",
      owner: prMatch[1],
      repo: prMatch[2],
      number: parseInt(prMatch[3], 10),
    }
  }

  const commitMatch = path.match(/^([^/]+)\/([^/]+)\/commit\/([a-f0-9]+)$/i)
  if (commitMatch && commitMatch[1] && commitMatch[2] && commitMatch[3]) {
    return {
      type: "commit",
      owner: commitMatch[1],
      repo: commitMatch[2],
      sha: commitMatch[3],
    }
  }

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
    "User-Agent": "critique-vercel",
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

async function renderDiffWithE2B(
  diff: string,
  cols: number = 240,
  rows: number = 2000
): Promise<string> {
  const apiKey = process.env.E2B_API_KEY
  if (!apiKey) {
    throw new Error("E2B_API_KEY not configured")
  }

  // Create sandbox with bun installed
  const sandbox = await Sandbox.create({
    apiKey,
    timeoutMs: 60000,
  })

  try {
    // Install bun and critique
    await sandbox.commands.run("curl -fsSL https://bun.sh/install | bash", { timeoutMs: 30000 })
    await sandbox.commands.run("export PATH=$HOME/.bun/bin:$PATH && bun add -g critique", { timeoutMs: 60000 })

    // Write diff to file
    await sandbox.files.write("/tmp/diff.patch", diff)

    // Run critique with --stdout
    const result = await sandbox.commands.run(
      `export PATH=$HOME/.bun/bin:$PATH && critique web --patch /tmp/diff.patch --stdout --cols ${cols} --rows ${rows}`,
      { timeoutMs: 60000 }
    )

    if (result.exitCode !== 0) {
      throw new Error(`critique failed: ${result.stderr}`)
    }

    return result.stdout
  } finally {
    await sandbox.kill()
  }
}

// =============================================================================
// In-memory cache
// =============================================================================

const cache = new Map<string, { html: string; timestamp: number }>()
const CACHE_TTL_PR = 60 * 60 * 1000
const CACHE_TTL_COMMIT = 7 * 24 * 60 * 60 * 1000

function getCachedHtml(key: string): string | null {
  const cached = cache.get(key)
  if (!cached) return null

  const ttl = key.includes("/pull/") ? CACHE_TTL_PR : CACHE_TTL_COMMIT
  if (Date.now() - cached.timestamp > ttl) {
    cache.delete(key)
    return null
  }

  return cached.html
}

function setCachedHtml(key: string, html: string): void {
  cache.set(key, { html, timestamp: Date.now() })

  if (cache.size > 100) {
    const oldestKey = cache.keys().next().value
    if (oldestKey) cache.delete(oldestKey)
  }
}

// =============================================================================
// Hono App
// =============================================================================

const app = new Hono()

app.use("*", cors())

app.get("/health", (c) => {
  return c.json({ status: "ok", runtime: "bun", renderer: "e2b" })
})

app.get("/", (c) => {
  return c.redirect("https://github.com/remorses/critique")
})

app.get("/:owner/:repo/pull/:number", async (c) => {
  const path = c.req.path
  const info = parseGitHubUrl(path)

  if (!info || info.type !== "pull") {
    return c.text("Invalid PR URL format", 400)
  }

  return handleGitHubDiff(c, info)
})

app.get("/:owner/:repo/commit/:sha", async (c) => {
  const path = c.req.path
  const info = parseGitHubUrl(path)

  if (!info || info.type !== "commit") {
    return c.text("Invalid commit URL format", 400)
  }

  return handleGitHubDiff(c, info)
})

app.get("/:owner/:repo/compare/:spec", async (c) => {
  const path = c.req.path
  const info = parseGitHubUrl(path)

  if (!info || info.type !== "compare") {
    return c.text("Invalid compare URL format", 400)
  }

  return handleGitHubDiff(c, info)
})

async function handleGitHubDiff(c: any, info: GitHubInfo) {
  const cacheKey = getCacheKey(info)

  const cachedHtml = getCachedHtml(cacheKey)
  if (cachedHtml) {
    return c.html(cachedHtml, 200, {
      "Cache-Control": "public, max-age=300",
      "X-Cache": "HIT",
    })
  }

  try {
    const githubToken = process.env.GITHUB_TOKEN
    const diff = await fetchGitHubDiff(info, githubToken)

    if (!diff.trim()) {
      return c.text("No diff content", 404)
    }

    const html = await renderDiffWithE2B(diff)

    setCachedHtml(cacheKey, html)

    return c.html(html, 200, {
      "Cache-Control": "public, max-age=300",
      "X-Cache": "MISS",
    })
  } catch (error: any) {
    console.error("Error rendering GitHub diff:", error)
    return c.json({ error: error.message || "Failed to render diff" }, 500)
  }
}

export const GET = handle(app)
export const POST = handle(app)
export const OPTIONS = handle(app)

export default app
