import { Hono } from "hono"
import { cors } from "hono/cors"
import { handle } from "hono/vercel"

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

interface ParsedFile {
  fileName: string
  diff: string
  additions: number
  deletions: number
}

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
// Diff Parsing
// =============================================================================

function parseGitDiff(diffText: string): ParsedFile[] {
  const files: ParsedFile[] = []
  const filePattern = /^diff --git a\/.+ b\/(.+)$/gm
  const parts = diffText.split(/(?=^diff --git)/m).filter(Boolean)

  for (const part of parts) {
    const fileMatch = part.match(/^diff --git a\/.+ b\/(.+)$/m)
    if (!fileMatch) continue

    const fileName = fileMatch[1] || "unknown"
    const lines = part.split("\n")

    let additions = 0
    let deletions = 0

    for (const line of lines) {
      if (line.startsWith("+") && !line.startsWith("+++")) additions++
      if (line.startsWith("-") && !line.startsWith("---")) deletions++
    }

    files.push({
      fileName,
      diff: part,
      additions,
      deletions,
    })
  }

  return files
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;")
}

function detectLanguage(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() || ""
  const langMap: Record<string, string> = {
    ts: "typescript", tsx: "tsx", js: "javascript", jsx: "jsx",
    py: "python", rb: "ruby", go: "go", rs: "rust",
    java: "java", kt: "kotlin", swift: "swift",
    css: "css", scss: "scss", html: "html",
    json: "json", yaml: "yaml", yml: "yaml", toml: "toml",
    md: "markdown", sh: "bash", bash: "bash",
    sql: "sql", graphql: "graphql",
  }
  return langMap[ext] || "text"
}

// =============================================================================
// HTML Diff Renderer
// =============================================================================

function renderDiffToHtml(diffText: string, info: GitHubInfo): string {
  const files = parseGitDiff(diffText)

  const title = info.type === "pull"
    ? `PR #${info.number} - ${info.owner}/${info.repo}`
    : info.type === "commit"
    ? `Commit ${info.sha.slice(0, 7)} - ${info.owner}/${info.repo}`
    : `Compare ${info.base}...${info.head} - ${info.owner}/${info.repo}`

  const totalAdditions = files.reduce((sum, f) => sum + f.additions, 0)
  const totalDeletions = files.reduce((sum, f) => sum + f.deletions, 0)

  let filesHtml = ""

  for (const file of files) {
    const lines = file.diff.split("\n")
    let lineHtml = ""
    let oldLineNum = 0
    let newLineNum = 0
    let inHunk = false

    for (const line of lines) {
      // Parse hunk header
      const hunkMatch = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
      if (hunkMatch) {
        oldLineNum = parseInt(hunkMatch[1] || "0", 10)
        newLineNum = parseInt(hunkMatch[2] || "0", 10)
        inHunk = true
        lineHtml += `<div class="line hunk-header"><span class="line-num"></span><span class="line-num"></span><span class="line-content">${escapeHtml(line)}</span></div>`
        continue
      }

      if (!inHunk) continue
      if (line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("---") || line.startsWith("+++")) continue

      const escaped = escapeHtml(line.slice(1) || " ")

      if (line.startsWith("+")) {
        lineHtml += `<div class="line added"><span class="line-num"></span><span class="line-num">${newLineNum}</span><span class="line-content">+${escaped}</span></div>`
        newLineNum++
      } else if (line.startsWith("-")) {
        lineHtml += `<div class="line removed"><span class="line-num">${oldLineNum}</span><span class="line-num"></span><span class="line-content">-${escaped}</span></div>`
        oldLineNum++
      } else if (line.startsWith(" ") || line === "") {
        lineHtml += `<div class="line context"><span class="line-num">${oldLineNum}</span><span class="line-num">${newLineNum}</span><span class="line-content"> ${escaped}</span></div>`
        oldLineNum++
        newLineNum++
      }
    }

    filesHtml += `
      <div class="file">
        <div class="file-header">
          <span class="file-name">${escapeHtml(file.fileName)}</span>
          <span class="file-stats">
            <span class="additions">+${file.additions}</span>
            <span class="deletions">-${file.deletions}</span>
          </span>
        </div>
        <div class="file-diff">${lineHtml}</div>
      </div>
    `
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
      font-size: 13px;
      line-height: 1.5;
      background: #0d1117;
      color: #c9d1d9;
      padding: 20px;
    }
    .header {
      margin-bottom: 20px;
      padding-bottom: 15px;
      border-bottom: 1px solid #30363d;
    }
    .header h1 {
      font-size: 20px;
      font-weight: 600;
      margin-bottom: 8px;
    }
    .header .stats {
      font-size: 14px;
      color: #8b949e;
    }
    .header .stats .additions { color: #3fb950; }
    .header .stats .deletions { color: #f85149; }
    .file {
      margin-bottom: 20px;
      border: 1px solid #30363d;
      border-radius: 6px;
      overflow: hidden;
    }
    .file-header {
      background: #161b22;
      padding: 10px 16px;
      border-bottom: 1px solid #30363d;
      display: flex;
      justify-content: space-between;
      align-items: center;
    }
    .file-name {
      font-weight: 600;
      color: #c9d1d9;
    }
    .file-stats .additions { color: #3fb950; margin-right: 8px; }
    .file-stats .deletions { color: #f85149; }
    .file-diff {
      overflow-x: auto;
    }
    .line {
      display: flex;
      min-height: 20px;
      white-space: pre;
    }
    .line-num {
      width: 50px;
      min-width: 50px;
      padding: 0 10px;
      text-align: right;
      color: #484f58;
      background: #161b22;
      user-select: none;
      border-right: 1px solid #30363d;
    }
    .line-content {
      flex: 1;
      padding: 0 10px;
      overflow-x: auto;
    }
    .line.added {
      background: rgba(46, 160, 67, 0.15);
    }
    .line.added .line-content {
      color: #3fb950;
    }
    .line.added .line-num {
      background: rgba(46, 160, 67, 0.2);
    }
    .line.removed {
      background: rgba(248, 81, 73, 0.15);
    }
    .line.removed .line-content {
      color: #f85149;
    }
    .line.removed .line-num {
      background: rgba(248, 81, 73, 0.2);
    }
    .line.hunk-header {
      background: rgba(56, 139, 253, 0.1);
      color: #58a6ff;
    }
    .line.hunk-header .line-num {
      background: rgba(56, 139, 253, 0.15);
    }
    .line.context {
      background: #0d1117;
    }
  </style>
</head>
<body>
  <div class="header">
    <h1>${escapeHtml(title)}</h1>
    <div class="stats">
      ${files.length} files changed,
      <span class="additions">+${totalAdditions} additions</span>,
      <span class="deletions">-${totalDeletions} deletions</span>
    </div>
  </div>
  ${filesHtml}
</body>
</html>`
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
  return c.json({ status: "ok", runtime: "bun" })
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

    const html = renderDiffToHtml(diff, info)

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
