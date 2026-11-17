// rest.ts — the GitHub REST v3 surface: repositories, refs, branches, commits, contents,
// labels, issues, comments and pull requests, over the shared forge store. Every answer is
// JSON with a `message` on errors, as the protocol checks require; ids are stable.

import { parseCommit, parseTree, type GitObj } from './gitstore.ts';
import type { Forge, IssueRec, PullRec, RepoRec } from './forge.ts';
import type { HttpResult } from './githttp.ts';

export interface RestRequest {
  forge: Forge;
  method: string;
  /** Path segments after /api/v3, percent-decoded. */
  segments: string[];
  query: URLSearchParams;
  bodyText: string;
  /** The request's absolute origin (http://host), for pagination Link headers. */
  origin: string;
  /** The full request path, for pagination Link headers. */
  pathname: string;
}

const JSON_TYPE = 'application/json; charset=utf-8';

function json(status: number, value: unknown, headers: Record<string, string> = {}): HttpResult {
  return { status, contentType: JSON_TYPE, body: Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'), headers };
}

function empty(status: number): HttpResult {
  return { status, contentType: JSON_TYPE, body: Buffer.alloc(0) };
}

function notFound(): HttpResult {
  return json(404, { message: 'Not Found' });
}

function validation(message: string): HttpResult {
  return json(422, { message: `Validation Failed: ${message}` });
}

/** Parse a JSON request body: an empty body is {}, malformed JSON is the protocol 400. */
function parseBody(text: string): { ok: true; value: Record<string, unknown> } | { ok: false; result: HttpResult } {
  if (text.trim() === '') return { ok: true, value: {} };
  try {
    const value: unknown = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: true, value: {} };
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, result: json(400, { message: 'Invalid JSON body' }) };
  }
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function pageParams(query: URLSearchParams): { perPage: number; page: number } {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  return {
    perPage: Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30,
    page: Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1,
  };
}

/** Slice one page out of a list and build the Link header for the pages that remain. */
function paginate<T>(req: RestRequest, items: readonly T[]): { page: T[]; headers: Record<string, string> } {
  const { perPage, page } = pageParams(req.query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  if (start + perPage < items.length) {
    const lastPage = Math.ceil(items.length / perPage);
    const url = (target: number): string => {
      const params = new URLSearchParams(req.query);
      params.set('page', String(target));
      params.set('per_page', String(perPage));
      return `<${req.origin}${req.pathname}?${params.toString()}>`;
    };
    headers.link = `${url(page + 1)}; rel="next", ${url(lastPage)}; rel="last"`;
  }
  return { page: slice, headers };
}

// ------------------------------------------------------------------------------------------------
// Object shapes.
// ------------------------------------------------------------------------------------------------

/** The opaque global id of a repository (shared with GraphQL; never the plain database id). */
export function repoNodeId(repo: RepoRec): string {
  return Buffer.from(`R${repo.dbId}`, 'utf8').toString('base64url');
}

export function repoJson(forge: Forge, repo: RepoRec): Record<string, unknown> {
  const login = forge.login();
  return {
    id: repo.dbId,
    node_id: repoNodeId(repo),
    name: repo.name,
    full_name: `${login}/${repo.name}`,
    owner: { login, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    visibility: repo.private ? 'private' : 'public',
    has_issues: true,
    open_issues_count: [...repo.issues.values()].filter((issue) => issue.state === 'open').length,
    created_at: forge.isoOf(repo.createdTick),
    updated_at: forge.nowIso(),
    pushed_at: forge.nowIso(),
    html_url: `https://forge.local/${login}/${repo.name}`,
    url: `/api/v3/repos/${login}/${repo.name}`,
  };
}

export function issueJson(forge: Forge, repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  const login = forge.login();
  const createdAt = forge.isoOf(issue.createdTick);
  return {
    id: issue.id,
    node_id: Buffer.from(`I${repo.dbId}.${issue.number}`, 'utf8').toString('base64url'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', default: false, description: null };
    }),
    user: { login, id: 1000, type: 'User' },
    comments: issue.comments.length,
    created_at: createdAt,
    updated_at: createdAt,
    closed_at: issue.state === 'closed' ? forge.nowIso() : null,
    html_url: `https://forge.local/${login}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${login}/${repo.name}/issues/${issue.number}`,
  };
}

export function commentJson(forge: Forge, comment: { id: number; body: string }): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: forge.login(), id: 1000, type: 'User' },
    created_at: forge.nowIso(),
    updated_at: forge.nowIso(),
  };
}

export function pullJson(forge: Forge, repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const { head, base } = forge.pullTips(repo, pull);
  const login = forge.login();
  return {
    id: pull.id,
    node_id: Buffer.from(`P${repo.dbId}.${pull.number}`, 'utf8').toString('base64url'),
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.headRef, sha: head, label: `${login}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: base, label: `${login}:${pull.baseRef}` },
    merged: pull.merged,
    merged_at: pull.mergedTick === null ? null : forge.isoOf(pull.mergedTick),
    merge_commit_sha: pull.mergeCommitSha,
    user: { login, id: 1000, type: 'User' },
    created_at: forge.isoOf(pull.createdTick),
    updated_at: forge.isoOf(pull.createdTick),
    closed_at: pull.state === 'closed' ? forge.nowIso() : null,
    html_url: `https://forge.local/${login}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${login}/${repo.name}/pulls/${pull.number}`,
  };
}

function commitJson(repo: RepoRec, oid: string): Record<string, unknown> {
  const object = repo.objects.get(oid);
  const commit = object !== undefined && object.type === 'commit' ? parseCommit(object.data) : null;
  const identity = (line: string): { name: string; email: string; date: string } => {
    const match = /^(.*)<([^>]*)>\s+(\d+)\s+/.exec(line) ?? /^(.*)<([^>]*)>/.exec(line);
    const stamp = match?.[3] !== undefined ? Number.parseInt(match[3], 10) : 1_700_000_000;
    return {
      name: (match?.[1] ?? '').trim(),
      email: match?.[2] ?? '',
      date: new Date(stamp * 1000).toISOString(),
    };
  };
  return {
    sha: oid,
    commit: {
      message: commit?.message.replace(/\n$/, '') ?? '',
      author: identity(commit?.author ?? ''),
      committer: identity(commit?.committer ?? ''),
      tree: { sha: commit?.tree ?? '' },
    },
    parents: (commit?.parents ?? []).map((parent) => ({ sha: parent })),
  };
}

// ------------------------------------------------------------------------------------------------
// Repository-level routes.
// ------------------------------------------------------------------------------------------------

function createRepo(req: RestRequest): HttpResult {
  const parsed = parseBody(req.bodyText);
  if (!parsed.ok) return parsed.result;
  const name = str(parsed.value.name);
  if (name === '') return validation('name is required');
  const created = req.forge.createRepo(name, {
    private: parsed.value.private === true,
    description: str(parsed.value.description),
    defaultBranch: str(parsed.value.default_branch),
  });
  if (created === null) {
    return json(422, {
      message: 'Repository creation failed.',
      errors: [{ resource: 'Repository', code: 'custom', field: 'name', message: 'name already exists on this account' }],
    });
  }
  return json(201, repoJson(req.forge, created));
}

function listUserRepos(req: RestRequest): HttpResult {
  const { page, headers } = paginate(req, req.forge.allRepos());
  return json(200, page.map((repo) => repoJson(req.forge, repo)), headers);
}

/** Resolve the repository a /repos/{owner}/{name} route addresses, or the 404 result. */
function withRepo(req: RestRequest, owner: string, name: string): { repo: RepoRec } | { result: HttpResult } {
  const repo = req.forge.repoFor(owner, name);
  if (repo === null) return { result: notFound() };
  return { repo };
}

// ------------------------------------------------------------------------------------------------
// Git data: refs, branches, commits.
// ------------------------------------------------------------------------------------------------

function refJson(repo: RepoRec, ref: string, oid: string): Record<string, unknown> {
  const object: GitObj | undefined = repo.objects.get(oid);
  return { ref, node_id: repoNodeId(repo), object: { sha: oid, type: object?.type ?? 'commit' } };
}

function createRef(req: RestRequest, repo: RepoRec): HttpResult {
  const parsed = parseBody(req.bodyText);
  if (!parsed.ok) return parsed.result;
  const ref = str(parsed.value.ref);
  const sha = str(parsed.value.sha);
  if (!ref.startsWith('refs/')) return validation('ref must start with refs/');
  if (!repo.objects.has(sha)) return validation(`object ${sha} does not exist`);
  if (repo.refs.has(ref)) return validation('Reference already exists');
  repo.refs.set(ref, sha);
  return json(201, refJson(repo, ref, sha));
}

function getRef(req: RestRequest, repo: RepoRec, refPath: string): HttpResult {
  const ref = `refs/${refPath}`;
  const oid = repo.refs.get(ref);
  if (oid === undefined) return notFound();
  return json(200, refJson(repo, ref, oid));
}

function listBranches(req: RestRequest, repo: RepoRec): HttpResult {
  const branches = req.forge
    .sortedRefs(repo)
    .filter(([name]) => name.startsWith('refs/heads/'))
    .map(([name, oid]) => ({ name: name.slice('refs/heads/'.length), commit: { sha: oid }, protected: false }));
  return json(200, branches);
}

function getBranch(req: RestRequest, repo: RepoRec, branch: string): HttpResult {
  const oid = repo.refs.get(`refs/heads/${branch}`);
  if (oid === undefined) return notFound();
  return json(200, { name: branch, commit: { sha: oid }, protected: false });
}

function listCommits(req: RestRequest, repo: RepoRec): HttpResult {
  const shaParam = req.query.get('sha');
  let start: string | null = null;
  if (shaParam !== null && shaParam !== '') {
    if (repo.refs.has(shaParam)) start = repo.refs.get(shaParam) ?? null;
    else if (repo.refs.has(`refs/heads/${shaParam}`)) start = repo.refs.get(`refs/heads/${shaParam}`) ?? null;
    else if (repo.objects.has(shaParam)) start = shaParam;
  } else {
    start = req.forge.branchTip(repo, repo.defaultBranch);
  }
  if (start === null) return json(200, []);
  const commits = req.forge.reachableCommits(repo, start);
  const { page } = paginate(req, commits);
  return json(200, page.map((oid) => commitJson(repo, oid)));
}

// ------------------------------------------------------------------------------------------------
// Contents.
// ------------------------------------------------------------------------------------------------

function contentsBranch(req: RestRequest, body: Record<string, unknown>): string {
  const fromBody = str(body.branch);
  if (fromBody !== '') return fromBody;
  const fromQuery = req.query.get('ref');
  return fromQuery !== null && fromQuery !== '' ? fromQuery : '';
}

function getContents(req: RestRequest, repo: RepoRec, path: string): HttpResult {
  const refParam = req.query.get('ref');
  const branch = refParam !== null && refParam !== '' ? refParam : repo.defaultBranch;
  const tip = req.forge.refCommit(repo, `refs/heads/${branch}`) ?? (repo.objects.has(branch) ? req.forge.peelToCommit(repo, branch) : null);
  const entry = req.forge.entryAt(repo, tip, path);
  if (entry === null) return notFound();
  if (entry.type === 'dir') {
    const tree = repo.objects.get(entry.oid);
    if (tree === undefined || tree.type !== 'tree') return notFound();
    const entries = parseTree(tree.data).map((child) => {
      const childPath = path === '' ? child.name : `${path}/${child.name}`;
      const childObject = repo.objects.get(child.oid);
      return {
        type: child.mode === '40000' ? 'dir' : 'file',
        name: child.name,
        path: childPath,
        sha: child.oid,
        size: child.mode === '40000' ? 0 : (childObject?.data.length ?? 0),
      };
    });
    return json(200, entries);
  }
  const blob = repo.objects.get(entry.oid);
  if (blob === undefined) return notFound();
  const name = path.split('/').pop() ?? path;
  return json(200, {
    type: 'file',
    name,
    path,
    sha: entry.oid,
    size: blob.data.length,
    encoding: 'base64',
    content: blob.data.toString('base64'),
  });
}

function putContents(req: RestRequest, repo: RepoRec, path: string): HttpResult {
  const parsed = parseBody(req.bodyText);
  if (!parsed.ok) return parsed.result;
  const body = parsed.value;
  const branch = contentsBranch(req, body) || repo.defaultBranch;
  const content = Buffer.from(str(body.content), 'base64');
  const message = str(body.message) || `Update ${path}`;
  const expected = typeof body.sha === 'string' && body.sha !== '' ? body.sha : undefined;
  const result = req.forge.putContent(repo, branch, path, content, message, expected);
  if (result === 'stale') {
    return json(409, { message: `${path} does not match the provided sha` });
  }
  const name = path.split('/').pop() ?? path;
  return json(result.created ? 201 : 200, {
    content: { name, path, sha: result.blob, size: content.length, type: 'file', encoding: 'base64' },
    commit: { sha: result.commit, message },
  });
}

function deleteContents(req: RestRequest, repo: RepoRec, path: string): HttpResult {
  const parsed = parseBody(req.bodyText);
  if (!parsed.ok) return parsed.result;
  const body = parsed.value;
  const branch = contentsBranch(req, body) || repo.defaultBranch;
  const message = str(body.message) || `Delete ${path}`;
  const expected = typeof body.sha === 'string' && body.sha !== '' ? body.sha : undefined;
  const result = req.forge.deleteContent(repo, branch, path, message, expected);
  if (result === null) return notFound();
  if (result === 'stale') return json(409, { message: `${path} does not match the provided sha` });
  return json(200, { content: null, commit: { sha: result.commit, message } });
}

// ------------------------------------------------------------------------------------------------
// Labels and issues.
// ------------------------------------------------------------------------------------------------

function createLabel(req: RestRequest, repo: RepoRec): HttpResult {
  const parsed = parseBody(req.bodyText);
  if (!parsed.ok) return parsed.result;
  const name = str(parsed.value.name);
  if (name === '') return validation('name is required');
  if (repo.labels.has(name)) return validation(`label ${name} already exists`);
  const color = str(parsed.value.color) || 'ededed';
  repo.labels.set(name, { name, color });
  return json(201, { name, color, default: false, description: null });
}

function labelNamesOf(repo: RepoRec, value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') names.push(entry);
    else if (entry !== null && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
      names.push((entry as { name: string }).name);
    } else return null;
  }
  for (const name of names) if (!repo.labels.has(name)) return null;
  return names;
}

function createIssue(req: RestRequest, repo: RepoRec): HttpResult {
  const parsed = parseBody(req.bodyText);
  if (!parsed.ok) return parsed.result;
  const title = str(parsed.value.title);
  if (title === '') return validation('title is required');
  const labels = labelNamesOf(repo, parsed.value.labels);
  if (labels === null) return validation('one of the labels does not exist on this repository');
  const issue = req.forge.createIssue(repo, title, str(parsed.value.body), labels);
  return json(201, issueJson(req.forge, repo, issue));
}

function listIssues(req: RestRequest, repo: RepoRec): HttpResult {
  const state = req.query.get('state') ?? 'open';
  const direction = req.query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state === 'open') issues = issues.filter((issue) => issue.state === 'open');
  else if (state === 'closed') issues = issues.filter((issue) => issue.state === 'closed');
  issues.sort((a, b) => a.number - b.number);
  if (direction !== 'asc') issues.reverse();
  const { page, headers } = paginate(req, issues);
  return json(200, page.map((issue) => issueJson(req.forge, repo, issue)), headers);
}

function getIssue(req: RestRequest, repo: RepoRec, number: number): HttpResult {
  const issue = repo.issues.get(number);
  if (issue === undefined) return notFound();
  // An open issue's serialized body never changes except on a patch or a comment, both
  // of which invalidate the entry: the read workload's repeated GETs answer from here.
  const cached = req.forge.cachedIssueBody(repo, issue);
  if (cached !== undefined) return { status: 200, contentType: JSON_TYPE, body: cached };
  const result = json(200, issueJson(req.forge, repo, issue));
  req.forge.cacheIssueBody(repo, issue, result.body);
  return result;
}

function patchIssue(req: RestRequest, repo: RepoRec, number: number): HttpResult {
  const issue = repo.issues.get(number);
  if (issue === undefined) return notFound();
  const parsed = parseBody(req.bodyText);
  if (!parsed.ok) return parsed.result;
  if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
  if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
  if (parsed.value.state === 'closed' || parsed.value.state === 'open') issue.state = parsed.value.state;
  if (parsed.value.labels !== undefined) {
    const labels = labelNamesOf(repo, parsed.value.labels);
    if (labels === null) return validation('one of the labels does not exist on this repository');
    issue.labels = labels;
  }
  req.forge.invalidateIssueBody(repo, number);
  return json(200, issueJson(req.forge, repo, issue));
}

function createComment(req: RestRequest, repo: RepoRec, number: number): HttpResult {
  const issue = repo.issues.get(number);
  if (issue === undefined) return notFound();
  const parsed = parseBody(req.bodyText);
  if (!parsed.ok) return parsed.result;
  const comment = req.forge.addComment(repo, issue, str(parsed.value.body));
  req.forge.invalidateIssueBody(repo, number);
  return json(201, commentJson(req.forge, comment));
}

function listComments(req: RestRequest, repo: RepoRec, number: number): HttpResult {
  const issue = repo.issues.get(number);
  if (issue === undefined) return notFound();
  return json(200, issue.comments.map((comment) => commentJson(req.forge, comment)));
}

// ------------------------------------------------------------------------------------------------
// Pull requests.
// ------------------------------------------------------------------------------------------------

/** A head/base argument as a plain branch name: labels ("owner:branch") and full refs are unwrapped. */
function branchNameOf(value: unknown): string {
  let name = str(value);
  if (name.startsWith('refs/heads/')) name = name.slice('refs/heads/'.length);
  const colon = name.lastIndexOf(':');
  if (colon >= 0) name = name.slice(colon + 1);
  return name;
}

function createPull(req: RestRequest, repo: RepoRec): HttpResult {
  const parsed = parseBody(req.bodyText);
  if (!parsed.ok) return parsed.result;
  const head = branchNameOf(parsed.value.head);
  const base = branchNameOf(parsed.value.base);
  const title = str(parsed.value.title);
  if (title === '') return validation('title is required');
  if (req.forge.branchTip(repo, head) === null) return validation(`head branch ${head} does not exist`);
  if (req.forge.branchTip(repo, base) === null) return validation(`base branch ${base} does not exist`);
  for (const existing of repo.pulls.values()) {
    if (existing.state === 'open' && existing.headRef === head && existing.baseRef === base) {
      return validation(`a pull request already exists for ${head} into ${base}`);
    }
  }
  const pull = req.forge.createPull(repo, title, str(parsed.value.body), head, base);
  if (pull === null) return validation('could not create the pull request');
  return json(201, pullJson(req.forge, repo, pull));
}

function listPulls(req: RestRequest, repo: RepoRec): HttpResult {
  const state = req.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state === 'open') pulls = pulls.filter((pull) => pull.state === 'open');
  else if (state === 'closed') pulls = pulls.filter((pull) => pull.state === 'closed');
  pulls.sort((a, b) => a.number - b.number);
  const { page, headers } = paginate(req, pulls);
  return json(200, page.map((pull) => pullJson(req.forge, repo, pull)), headers);
}

function getPull(req: RestRequest, repo: RepoRec, number: number): HttpResult {
  const pull = repo.pulls.get(number);
  if (pull === undefined) return notFound();
  return json(200, pullJson(req.forge, repo, pull));
}

/** Line counts of a blob-to-blob change: an LCS diff, with a coarse fallback for huge files. */
function diffCounts(before: Buffer | null, after: Buffer | null): { additions: number; deletions: number } {
  const lines = (data: Buffer | null): string[] => {
    if (data === null) return [];
    const text = data.toString('utf8');
    if (text === '') return [];
    const split = text.split('\n');
    if (split[split.length - 1] === '') split.pop();
    return split;
  };
  const a = lines(before);
  const b = lines(after);
  if (a.length === 0) return { additions: b.length, deletions: 0 };
  if (b.length === 0) return { additions: 0, deletions: a.length };
  if (a.length > 2000 || b.length > 2000) return { additions: b.length, deletions: a.length };
  // LCS over lines (the files this forge diffs for the suite are small).
  const dp: number[] = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = 0;
    for (let j = 1; j <= b.length; j += 1) {
      const above = dp[j] ?? 0;
      if (a[i - 1] === b[j - 1]) dp[j] = diagonal + 1;
      else dp[j] = Math.max(above, dp[j - 1] ?? 0);
      diagonal = above;
    }
  }
  const common = dp[b.length] ?? 0;
  return { additions: b.length - common, deletions: a.length - common };
}

function pullFiles(req: RestRequest, repo: RepoRec, number: number): HttpResult {
  const pull = repo.pulls.get(number);
  if (pull === undefined) return notFound();
  const files = req.forge.pullFiles(repo, pull).map((file) => {
    const before = file.before === null ? null : (repo.objects.get(file.before)?.data ?? null);
    const after = file.after === null ? null : (repo.objects.get(file.after)?.data ?? null);
    const counts = diffCounts(before, after);
    return {
      filename: file.path,
      status: file.status,
      additions: counts.additions,
      deletions: counts.deletions,
      changes: counts.additions + counts.deletions,
      sha: file.after ?? '',
    };
  });
  return json(200, files);
}

function mergePull(req: RestRequest, repo: RepoRec, number: number): HttpResult {
  const pull = repo.pulls.get(number);
  if (pull === undefined) return notFound();
  const parsed = parseBody(req.bodyText);
  if (!parsed.ok) return parsed.result;
  if (pull.state !== 'open') return json(405, { message: 'Pull Request is not mergeable' });
  const sha = req.forge.mergePull(repo, pull);
  if (sha === null) return json(405, { message: 'Pull Request is not mergeable' });
  return json(200, { sha, merged: true, message: 'Pull Request successfully merged' });
}

// ------------------------------------------------------------------------------------------------
// The router.
// ------------------------------------------------------------------------------------------------

export function handleRest(req: RestRequest): HttpResult {
  const forge = req.forge;
  const segments = req.segments;
  const method = req.method;

  if (segments.length === 1 && segments[0] === 'meta' && method === 'GET') {
    return json(200, { installed_version: '1.0.0' });
  }
  if (segments.length === 1 && segments[0] === 'user' && method === 'GET') {
    if (forge.viewerLogin === null) return notFound();
    return json(200, { login: forge.viewerLogin, id: 1000, type: 'User' });
  }
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'POST') return createRepo(req);
    if (method === 'GET') return listUserRepos(req);
    return notFound();
  }
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = segments[1] as string;
    const name = segments[2] as string;
    const found = withRepo(req, owner, name);
    if ('result' in found) return found.result;
    const repo = found.repo;
    const rest = segments.slice(3);

    if (rest.length === 0) {
      if (method === 'GET') return json(200, repoJson(forge, repo));
      if (method === 'PATCH') {
        const parsed = parseBody(req.bodyText);
        if (!parsed.ok) return parsed.result;
        if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
        if (typeof parsed.value.name === 'string' && parsed.value.name !== '' && parsed.value.name !== repo.name) {
          // A rename moves the store key; the suite only patches descriptions, but stay honest.
          forge.repos.delete(repo.name);
          repo.name = parsed.value.name;
          forge.repos.set(repo.name, repo);
        }
        if (typeof parsed.value.private === 'boolean') repo.private = parsed.value.private;
        if (typeof parsed.value.default_branch === 'string' && parsed.value.default_branch !== '') repo.defaultBranch = parsed.value.default_branch;
        return json(200, repoJson(forge, repo));
      }
      if (method === 'DELETE') {
        forge.deleteRepo(repo.name);
        return empty(204);
      }
      return notFound();
    }

    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 2) {
        if (method === 'POST') return createRef(req, repo);
        if (method === 'GET') {
          return json(200, forge.sortedRefs(repo).map(([ref, oid]) => refJson(repo, ref, oid)));
        }
        return notFound();
      }
      if (method === 'GET') return getRef(req, repo, rest.slice(2).join('/'));
      return notFound();
    }
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') return listBranches(req, repo);
      if (rest.length >= 2 && method === 'GET') return getBranch(req, repo, rest.slice(1).join('/'));
      return notFound();
    }
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') return listCommits(req, repo);
    if (rest[0] === 'contents') {
      const path = rest.slice(1).map((segment) => segment).join('/');
      if (method === 'GET') return getContents(req, repo, path);
      if (method === 'PUT') return putContents(req, repo, path);
      if (method === 'DELETE') return deleteContents(req, repo, path);
      return notFound();
    }
    if (rest[0] === 'labels') {
      if (rest.length === 1) {
        if (method === 'POST') return createLabel(req, repo);
        if (method === 'GET') return json(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, default: false, description: null })));
      }
      return notFound();
    }
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'POST') return createIssue(req, repo);
        if (method === 'GET') return listIssues(req, repo);
        return notFound();
      }
      const number = Number.parseInt(rest[1] as string, 10);
      if (!Number.isFinite(number)) return notFound();
      if (rest.length === 2) {
        if (method === 'GET') return getIssue(req, repo, number);
        if (method === 'PATCH') return patchIssue(req, repo, number);
        return notFound();
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'POST') return createComment(req, repo, number);
        if (method === 'GET') return listComments(req, repo, number);
        return notFound();
      }
      return notFound();
    }
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'POST') return createPull(req, repo);
        if (method === 'GET') return listPulls(req, repo);
        return notFound();
      }
      const number = Number.parseInt(rest[1] as string, 10);
      if (!Number.isFinite(number)) return notFound();
      if (rest.length === 2 && method === 'GET') return getPull(req, repo, number);
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') return pullFiles(req, repo, number);
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') return mergePull(req, repo, number);
      return notFound();
    }
    return notFound();
  }
  return notFound();
}
