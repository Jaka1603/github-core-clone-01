// mcp.ts — the Model Context Protocol endpoint (POST /mcp, JSON-RPC 2.0 over streamable
// HTTP). Speaks the 2026-07-28 revision (server/discover, no handshake) and the legacy
// initialize handshake. The tools are github-mcp-server's core set, executed against the
// same forge store as REST and GraphQL, so ids and objects agree across surfaces.

import { issueJson, pullJson, repoJson } from './rest.ts';
import type { Forge, RepoRec } from './forge.ts';
import type { HttpResult } from './githttp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' } as const;
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

function json(status: number, value: unknown, headers: Record<string, string> = {}): HttpResult {
  return { status, contentType: JSON_TYPE, body: Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'), headers };
}

interface ToolDef {
  name: string;
  description: string;
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

function tool(name: string, description: string, properties: ToolDef['properties'], required: string[]): ToolDef {
  return { name, description, properties, required };
}

const OWNER_REPO: ToolDef['properties'] = {
  owner: { type: 'string', description: 'The repository owner login.' },
  repo: { type: 'string', description: 'The repository name.' },
};

/** The tool list: built once, so two tools/list answers are byte-identical. */
const TOOLS: ToolDef[] = [
  tool('create_repo', 'Create a new repository for the token owner.', {
    name: { type: 'string', description: 'The repository name.' },
    description: { type: 'string', description: 'A short description of the repository.' },
    private: { type: 'boolean', description: 'Whether the repository is private.' },
  }, ['name']),
  tool('get_repo', 'Get a repository by owner and name.', { ...OWNER_REPO }, ['owner', 'repo']),
  tool('create_issue', 'Create an issue in a repository.', {
    ...OWNER_REPO,
    title: { type: 'string', description: 'The issue title.' },
    body: { type: 'string', description: 'The issue body.' },
  }, ['owner', 'repo', 'title']),
  tool('list_issues', 'List the issues of a repository.', {
    ...OWNER_REPO,
    state: { type: 'string', description: 'Filter by state: open, closed or all.' },
  }, ['owner', 'repo']),
  tool('get_issue', 'Get one issue of a repository by its number.', {
    ...OWNER_REPO,
    issue_number: { type: 'integer', description: 'The issue number.' },
  }, ['owner', 'repo', 'issue_number']),
  tool('create_pull_request', 'Open a pull request from a head branch into a base branch.', {
    ...OWNER_REPO,
    title: { type: 'string', description: 'The pull request title.' },
    body: { type: 'string', description: 'The pull request body.' },
    head: { type: 'string', description: 'The head branch name.' },
    base: { type: 'string', description: 'The base branch name.' },
  }, ['owner', 'repo', 'title', 'head', 'base']),
  tool('list_pull_requests', 'List the pull requests of a repository.', {
    ...OWNER_REPO,
    state: { type: 'string', description: 'Filter by state: open, closed or all.' },
  }, ['owner', 'repo']),
  tool('merge_pull_request', 'Merge a pull request into its base branch.', {
    ...OWNER_REPO,
    pull_number: { type: 'integer', description: 'The pull request number.' },
  }, ['owner', 'repo', 'pull_number']),
  tool('add_comment', 'Add a comment to an issue.', {
    ...OWNER_REPO,
    issue_number: { type: 'integer', description: 'The issue number.' },
    body: { type: 'string', description: 'The comment body.' },
  }, ['owner', 'repo', 'issue_number', 'body']),
];

function toolsListResult(): Record<string, unknown> {
  return {
    tools: TOOLS.map((def) => ({
      name: def.name,
      description: def.description,
      inputSchema: { type: 'object', properties: def.properties, required: def.required },
    })),
  };
}

type ToolOutcome =
  | { ok: true; value: unknown }
  | { ok: false; message: string };

function repoOrError(forge: Forge, args: Record<string, unknown>): RepoRec | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repo = typeof args.repo === 'string' ? args.repo : '';
  return forge.repoFor(owner, repo);
}

function runTool(forge: Forge, name: string, args: Record<string, unknown>): ToolOutcome {
  switch (name) {
    case 'create_repo': {
      const repoName = typeof args.name === 'string' ? args.name : '';
      if (repoName === '') return { ok: false, message: 'name is required' };
      const created = forge.createRepo(repoName, {
        private: args.private === true,
        description: typeof args.description === 'string' ? args.description : '',
      });
      if (created === null) return { ok: false, message: `repository ${repoName} already exists` };
      return { ok: true, value: repoJson(forge, created) };
    }
    case 'get_repo': {
      const repo = repoOrError(forge, args);
      if (repo === null) return { ok: false, message: 'repository not found' };
      return { ok: true, value: repoJson(forge, repo) };
    }
    case 'create_issue': {
      const repo = repoOrError(forge, args);
      if (repo === null) return { ok: false, message: 'repository not found' };
      const title = typeof args.title === 'string' ? args.title : '';
      if (title === '') return { ok: false, message: 'title is required' };
      const issue = forge.createIssue(repo, title, typeof args.body === 'string' ? args.body : '', []);
      return { ok: true, value: issueJson(forge, repo, issue) };
    }
    case 'list_issues': {
      const repo = repoOrError(forge, args);
      if (repo === null) return { ok: false, message: 'repository not found' };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
      else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
      issues.sort((a, b) => a.number - b.number);
      return { ok: true, value: issues.map((issue) => issueJson(forge, repo, issue)) };
    }
    case 'get_issue': {
      const repo = repoOrError(forge, args);
      if (repo === null) return { ok: false, message: 'repository not found' };
      const number = typeof args.issue_number === 'number' ? args.issue_number : -1;
      const issue = repo.issues.get(number);
      if (issue === undefined) return { ok: false, message: 'issue not found' };
      return { ok: true, value: issueJson(forge, repo, issue) };
    }
    case 'create_pull_request': {
      const repo = repoOrError(forge, args);
      if (repo === null) return { ok: false, message: 'repository not found' };
      const title = typeof args.title === 'string' ? args.title : '';
      const head = typeof args.head === 'string' ? args.head : '';
      const base = typeof args.base === 'string' ? args.base : '';
      if (forge.branchTip(repo, head) === null) return { ok: false, message: `head branch ${head} does not exist` };
      if (forge.branchTip(repo, base) === null) return { ok: false, message: `base branch ${base} does not exist` };
      const pull = forge.createPull(repo, title, typeof args.body === 'string' ? args.body : '', head, base);
      if (pull === null) return { ok: false, message: 'could not create the pull request' };
      return { ok: true, value: pullJson(forge, repo, pull) };
    }
    case 'list_pull_requests': {
      const repo = repoOrError(forge, args);
      if (repo === null) return { ok: false, message: 'repository not found' };
      const state = typeof args.state === 'string' ? args.state : 'open';
      let pulls = [...repo.pulls.values()];
      if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
      else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
      pulls.sort((a, b) => a.number - b.number);
      return { ok: true, value: pulls.map((pull) => pullJson(forge, repo, pull)) };
    }
    case 'merge_pull_request': {
      const repo = repoOrError(forge, args);
      if (repo === null) return { ok: false, message: 'repository not found' };
      const number = typeof args.pull_number === 'number' ? args.pull_number : -1;
      const pull = repo.pulls.get(number);
      if (pull === undefined) return { ok: false, message: 'pull request not found' };
      if (pull.state !== 'open') return { ok: false, message: 'pull request is not open' };
      const sha = forge.mergePull(repo, pull);
      if (sha === null) return { ok: false, message: 'pull request is not mergeable' };
      return { ok: true, value: { ...pullJson(forge, repo, pull), merge_commit_sha: sha } };
    }
    case 'add_comment': {
      const repo = repoOrError(forge, args);
      if (repo === null) return { ok: false, message: 'repository not found' };
      const number = typeof args.issue_number === 'number' ? args.issue_number : -1;
      const issue = repo.issues.get(number);
      if (issue === undefined) return { ok: false, message: 'issue not found' };
      const comment = forge.addComment(repo, issue, typeof args.body === 'string' ? args.body : '');
      return { ok: true, value: { id: comment.id, body: comment.body } };
    }
    default:
      return { ok: false, message: `unknown tool ${name}` };
  }
}

interface RpcOutcome {
  status: number;
  payload: Record<string, unknown> | null;
  headers?: Record<string, string>;
}

function rpcResult(id: unknown, result: unknown): RpcOutcome {
  return { status: 200, payload: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string): RpcOutcome {
  return { status: 200, payload: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

/** Dispatch one JSON-RPC request object. A null payload means "answer with no body" (a notification). */
function dispatch(forge: Forge, request: Record<string, unknown>): RpcOutcome {
  const method = typeof request.method === 'string' ? request.method : '';
  const id = request.id;
  const params = (request.params ?? {}) as Record<string, unknown>;
  const isNotification = id === undefined;

  switch (method) {
    case 'server/discover':
      return rpcResult(id, {
        resultType: 'complete',
        supportedVersions: [...SUPPORTED_VERSIONS],
        capabilities: { tools: {} },
        serverInfo: { ...SERVER_INFO },
        _meta: { 'io.modelcontextprotocol/serverInfo': { ...SERVER_INFO } },
      });
    case 'initialize': {
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
      const version = (SUPPORTED_VERSIONS as readonly string[]).includes(requested) ? requested : '2025-11-25';
      return {
        status: 200,
        payload: {
          jsonrpc: '2.0',
          id: id ?? null,
          result: { protocolVersion: version, capabilities: { tools: {} }, serverInfo: { ...SERVER_INFO } },
        },
        headers: { 'mcp-session-id': 'makefun-forge-session' },
      };
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, toolsListResult());
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const def = TOOLS.find((candidate) => candidate.name === toolName);
      if (def === undefined) return rpcError(id, -32602, `unknown tool: ${toolName === '' ? '(missing name)' : toolName}`);
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const missing = def.required.filter((key) => args[key] === undefined || args[key] === null || args[key] === '');
      if (missing.length > 0) return rpcError(id, -32602, `missing required argument(s): ${missing.join(', ')}`);
      const outcome = runTool(forge, toolName, args);
      if (!outcome.ok) {
        return rpcResult(id, { content: [{ type: 'text', text: outcome.message }], isError: true });
      }
      const text = JSON.stringify(outcome.value);
      return rpcResult(id, {
        content: [{ type: 'text', text }],
        structuredContent: outcome.value,
        isError: false,
      });
    }
    default:
      if (isNotification) return { status: 202, payload: null };
      if (method.startsWith('notifications/')) return { status: 202, payload: null };
      return rpcError(id, -32601, `method not found: ${method}`);
  }
}

/**
 * Handle one POST /mcp. Authentication is the app-level gate's job (a request without the
 * trial token is 401 before it reaches here); a body that is not JSON is the JSON-RPC
 * parse error at HTTP 400.
 */
export function handleMcp(forge: Forge, bodyText: string): HttpResult {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  if (Array.isArray(body)) {
    const payloads: unknown[] = [];
    for (const entry of body) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
      const outcome = dispatch(forge, entry as Record<string, unknown>);
      if (outcome.payload !== null) payloads.push(outcome.payload);
    }
    return json(200, payloads);
  }
  if (body === null || typeof body !== 'object') {
    return json(400, { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid request' } });
  }
  const outcome = dispatch(forge, body as Record<string, unknown>);
  if (outcome.payload === null) return { status: outcome.status, contentType: JSON_TYPE, body: Buffer.alloc(0), headers: outcome.headers };
  return json(outcome.status, outcome.payload, outcome.headers);
}
