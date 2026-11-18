// forge.ts — the forge's one in-memory store and the domain operations every surface
// (git smart HTTP, REST v3, GraphQL v4, MCP) shares, so an object created on one surface
// is the same object on all of them. State is per-process and deterministic: timestamps
// come from a logical clock, never the wall clock, so a replayed trial sees the same bytes.

import {
  ZERO_OID,
  buildCommit,
  buildTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  type CommitInfo,
  type GitObj,
  type TreeEntry,
} from './gitstore.ts';

export const ZERO = ZERO_OID;

/** A fixed epoch the logical clock starts from (2023-11-14T22:13:20Z). */
const EPOCH_SEC = 1_700_000_000;
/** The identity this forge signs its own commits (contents writes, merges) with. */
const FORGE_IDENTITY = 'Forge Bot <forge@localhost>';

export interface LabelRec {
  name: string;
  color: string;
}

export interface CommentRec {
  id: number;
  body: string;
}

export interface IssueRec {
  /** Global numeric id (the REST `id` field); stable for the issue's life. */
  id: number;
  /** The opaque global id (base64url of "I<repoDbId>.<number>"), fixed at creation. */
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  createdTick: number;
}

export interface PullRec {
  id: number;
  /** The opaque global id (base64url of "P<repoDbId>.<number>"), fixed at creation. */
  nodeId: string;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  baseRef: string;
  /** Branch tips when the pull request was opened (fallbacks if a branch later moves or goes). */
  headSha: string;
  baseSha: string;
  mergeCommitSha: string | null;
  mergedTick: number | null;
  createdTick: number;
}

export interface RepoRec {
  /** The numeric database id GraphQL reports; unique across the forge. */
  dbId: number;
  /** The opaque global id (base64url of "R<dbId>"), fixed at creation. */
  nodeId: string;
  name: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  objects: Map<string, GitObj>;
  refs: Map<string, string>;
  /** Parsed commits, memoized: commit bytes never change, so a parse is valid forever. */
  commitCache: Map<string, CommitInfo>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  /** Issues and pull requests share one number sequence, as on GitHub. */
  nextNumber: number;
  createdTick: number;
  /**
   * Serialized REST bodies of open issues, keyed by `login|repo-name|number`: an open
   * issue's every field is fixed except its comment count and its labels, both of which
   * invalidate the entry (see invalidateIssueBody), so the read workload's 2,000 GETs
   * of one issue answer from the cache instead of rebuilding the JSON each time.
   */
  issueBodyCache: Map<string, Buffer>;
  /**
   * Whole fetch answers (upload-pack v0/v2 bodies), keyed by the fetch's inputs: a
   * fetch's content depends only on immutable objects, so an identical fetch of the
   * same repository answers from the cache. Entries are stored only for complete
   * selections (see fetchSelection); the map is dropped with the repository.
   */
  fetchCache: Map<string, Buffer>;
}

/** Flattened tree view: full path -> blob entry. */
export type FlatTree = Map<string, { oid: string; mode: string }>;

export class Forge {
  readonly repos = new Map<string, RepoRec>();
  private readonly reposByDbId = new Map<number, RepoRec>();
  private nextDbId = 1;
  private nextIssueId = 1;
  private nextPullId = 1;
  private nextCommentId = 1;
  private tick = 0;
  /** ISO-8601 strings by tick: a tick's string never changes, so each is built once. */
  private readonly isoCache = new Map<number, string>();

  /**
   * The token owner's login. The trial's bearer token carries no name, so the forge learns
   * the login from the first owner-addressed request that names an existing repository (or
   * any owner-addressed request when nothing contradicts it yet) and treats every other
   * owner as a stranger from then on: the same repository name under another owner is 404.
   */
  viewerLogin: string | null = null;

  /** Advance the logical clock and answer the new tick. */
  private advance(): number {
    this.tick += 1;
    return this.tick;
  }

  /** ISO-8601 for a tick, on the logical clock (memoized: the answer never changes). */
  isoOf(tickValue: number): string {
    const cached = this.isoCache.get(tickValue);
    if (cached !== undefined) return cached;
    const iso = new Date((EPOCH_SEC + tickValue) * 1000).toISOString();
    this.isoCache.set(tickValue, iso);
    return iso;
  }

  /** The current logical time as ISO-8601 (does not advance the clock). */
  nowIso(): string {
    return this.isoOf(this.tick);
  }

  /** A git timestamp line fragment ("<unix> +0000") on the logical clock. */
  private stamp(): string {
    return `${EPOCH_SEC + this.advance()} +0000`;
  }

  /** Record `owner` as the viewer's login when it is not yet known. */
  learnOwner(owner: string): void {
    if (this.viewerLogin === null && owner !== '') this.viewerLogin = owner;
  }

  /** Whether `owner` may address the viewer's repositories (true while the login is unlearned). */
  ownerAllowed(owner: string): boolean {
    return this.viewerLogin === null || owner === this.viewerLogin;
  }

  /** The login to print for the viewer (learned, else the conventional placeholder). */
  login(): string {
    return this.viewerLogin ?? 'viewer';
  }

  /** The issue-body cache key: the login and repository name are part of the bytes. */
  private issueBodyKey(repo: RepoRec, number: number): string {
    return `${this.login()}|${repo.name}|${number}`;
  }

  /** A cached serialized body for an open issue, or undefined (closed issues are never cached: their closed_at reads the clock). */
  cachedIssueBody(repo: RepoRec, issue: IssueRec): Buffer | undefined {
    if (issue.state !== 'open') return undefined;
    return repo.issueBodyCache.get(this.issueBodyKey(repo, issue.number));
  }

  /** Store a serialized body for an open issue. */
  cacheIssueBody(repo: RepoRec, issue: IssueRec, body: Buffer): void {
    if (issue.state !== 'open') return;
    repo.issueBodyCache.set(this.issueBodyKey(repo, issue.number), body);
  }

  /** Drop every cached body of one issue (patch, comment, close). */
  invalidateIssueBody(repo: RepoRec, number: number): void {
    const suffix = `|${number}`;
    for (const key of [...repo.issueBodyCache.keys()]) {
      if (key.endsWith(suffix)) repo.issueBodyCache.delete(key);
    }
  }

  // ----------------------------------------------------------------------------------------------
  // Repositories.
  // ----------------------------------------------------------------------------------------------

  createRepo(name: string, options: { private?: boolean; description?: string; defaultBranch?: string }): RepoRec | null {
    if (this.repos.has(name)) return null;
    const repo: RepoRec = {
      dbId: this.nextDbId,
      nodeId: Buffer.from(`R${this.nextDbId}`, 'utf8').toString('base64url'),
      name,
      private: options.private ?? false,
      description: options.description ?? '',
      defaultBranch: options.defaultBranch !== undefined && options.defaultBranch !== '' ? options.defaultBranch : 'main',
      objects: new Map(),
      refs: new Map(),
      commitCache: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      nextNumber: 1,
      createdTick: this.advance(),
      issueBodyCache: new Map(),
      fetchCache: new Map(),
    };
    this.nextDbId += 1;
    this.repos.set(name, repo);
    this.reposByDbId.set(repo.dbId, repo);
    return repo;
  }

  /**
   * Look a repository up by owner and name, applying the stranger rule: a known viewer login
   * that differs from `owner` hides the repository (404), and a successful lookup by an
   * as-yet-unlearned owner teaches the forge the login.
   */
  repoFor(owner: string, name: string): RepoRec | null {
    const repo = this.repos.get(name);
    if (repo === undefined) return null;
    if (!this.ownerAllowed(owner)) return null;
    this.learnOwner(owner);
    return repo;
  }

  repoByDbId(dbId: number): RepoRec | null {
    return this.reposByDbId.get(dbId) ?? null;
  }

  deleteRepo(name: string): boolean {
    const repo = this.repos.get(name);
    if (repo === undefined) return false;
    this.repos.delete(name);
    this.reposByDbId.delete(repo.dbId);
    return true;
  }

  allRepos(): RepoRec[] {
    return [...this.repos.values()].sort((a, b) => a.dbId - b.dbId);
  }

  // ----------------------------------------------------------------------------------------------
  // Git graph helpers.
  // ----------------------------------------------------------------------------------------------

  /** Peel an object id to the commit it names (through annotated tags), or null. */
  peelToCommit(repo: RepoRec, oid: string): string | null {
    let current = oid;
    for (let hops = 0; hops < 16; hops += 1) {
      const object = repo.objects.get(current);
      if (object === undefined) return null;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  /** The commit a ref names, peeled, or null when the ref is absent or not a commit. */
  refCommit(repo: RepoRec, ref: string): string | null {
    const oid = repo.refs.get(ref);
    return oid === undefined ? null : this.peelToCommit(repo, oid);
  }

  /** A commit's parsed headers, memoized on the repository (commit bytes are immutable). */
  commitInfo(repo: RepoRec, oid: string): CommitInfo | null {
    const cached = repo.commitCache.get(oid);
    if (cached !== undefined) return cached;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') return null;
    const parsed = parseCommit(object.data);
    repo.commitCache.set(oid, parsed);
    return parsed;
  }

  /** Commit generations from `tip`: the tip is generation 1, its parents 2, and so on (BFS). */
  generations(repo: RepoRec, tip: string): Map<string, number> {
    const result = new Map<string, number>();
    const start = this.peelToCommit(repo, tip);
    if (start === null) return result;
    const queue: Array<{ oid: string; gen: number }> = [{ oid: start, gen: 1 }];
    result.set(start, 1);
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      const commit = this.commitInfo(repo, current.oid);
      if (commit === null) continue;
      for (const parent of commit.parents) {
        if (!result.has(parent)) {
          result.set(parent, current.gen + 1);
          queue.push({ oid: parent, gen: current.gen + 1 });
        }
      }
    }
    return result;
  }

  /** Every commit reachable from `tip`, tip first (BFS order). */
  reachableCommits(repo: RepoRec, tip: string): string[] {
    return [...this.generations(repo, tip).entries()].sort((a, b) => a[1] - b[1]).map(([oid]) => oid);
  }

  /** Whether `ancestor` is `descendant` itself or one of its ancestors (commit graph only). */
  isAncestor(repo: RepoRec, ancestor: string, descendant: string): boolean {
    const target = this.peelToCommit(repo, ancestor);
    const from = this.peelToCommit(repo, descendant);
    if (target === null || from === null) return false;
    if (target === from) return true;
    // Walk back from the descendant and stop the moment the ancestor turns up: a
    // fast-forward check on a fresh tip is one step, not a whole-history scan.
    const seen = new Set<string>([from]);
    const queue: string[] = [from];
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      const commit = this.commitInfo(repo, current);
      if (commit === null) continue;
      for (const parent of commit.parents) {
        if (parent === target) return true;
        if (!seen.has(parent)) {
          seen.add(parent);
          queue.push(parent);
        }
      }
    }
    return false;
  }

  /** The best common ancestor of two commits (the common ancestor of greatest generation depth from both), or null. */
  mergeBase(repo: RepoRec, a: string, b: string): string | null {
    const gensA = this.generations(repo, a);
    const gensB = this.generations(repo, b);
    let best: string | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    for (const [oid, genA] of gensA) {
      const genB = gensB.get(oid);
      if (genB === undefined) continue;
      const score = genA + genB;
      if (score < bestScore) {
        bestScore = score;
        best = oid;
      }
    }
    return best;
  }

  /** Every object reachable from the given tips (commits, their trees and blobs, tags peeled through). */
  closure(repo: RepoRec, tips: readonly string[], boundary = new Set<string>()): Set<string> {
    const seen = new Set<string>();
    const stack: string[] = [...tips];
    while (stack.length > 0) {
      const oid = stack.pop();
      if (oid === undefined || seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined) continue;
      seen.add(oid);
      if (object.type === 'commit') {
        const commit = this.commitInfo(repo, oid);
        if (commit === null) continue;
        stack.push(commit.tree);
        if (!boundary.has(oid)) stack.push(...commit.parents);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) stack.push(entry.oid);
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      }
    }
    return seen;
  }

  /** A branch's tip commit oid (raw ref value), or null. */
  branchTip(repo: RepoRec, branch: string): string | null {
    return repo.refs.get(`refs/heads/${branch}`) ?? null;
  }

  /** All refs, sorted by name: [refName, oid]. */
  sortedRefs(repo: RepoRec): Array<[string, string]> {
    return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  }

  /** Store an object the forge built itself and answer its id. */
  putObject(repo: RepoRec, type: GitObj['type'], data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
    return oid;
  }

  /** Create a commit with the forge's identity on the logical clock, store it, answer its id. */
  makeCommit(repo: RepoRec, tree: string, parents: readonly string[], message: string): string {
    const stamp = this.stamp();
    const data = buildCommit({
      tree,
      parents: [...parents],
      author: `${FORGE_IDENTITY} ${stamp}`,
      committer: `${FORGE_IDENTITY} ${stamp}`,
      message: message.endsWith('\n') ? message : `${message}\n`,
    });
    return this.putObject(repo, 'commit', data);
  }

  // ----------------------------------------------------------------------------------------------
  // Trees as flat path maps (contents API, diffs, merges).
  // ----------------------------------------------------------------------------------------------

  /** Flatten a tree (by oid) into path -> blob entry. An absent tree flattens to empty. */
  flattenTree(repo: RepoRec, treeOid: string | null): FlatTree {
    const out: FlatTree = new Map();
    if (treeOid === null) return out;
    const walk = (oid: string, prefix: string): void => {
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, '');
    return out;
  }

  /** The tree oid of a commit oid, or null. */
  commitTree(repo: RepoRec, commitOid: string | null): string | null {
    if (commitOid === null) return null;
    const commit = this.commitInfo(repo, commitOid);
    return commit === null ? null : commit.tree;
  }

  /** Materialize a flat path map into tree objects (stored), answering the root tree oid. */
  treeFromFlat(repo: RepoRec, flat: FlatTree): string {
    interface DirNode {
      files: Map<string, { oid: string; mode: string }>;
      dirs: Map<string, DirNode>;
    }
    const root: DirNode = { files: new Map(), dirs: new Map() };
    for (const [path, entry] of flat) {
      const parts = path.split('/');
      let node = root;
      for (let index = 0; index < parts.length - 1; index += 1) {
        const part = parts[index] as string;
        let next = node.dirs.get(part);
        if (next === undefined) {
          next = { files: new Map(), dirs: new Map() };
          node.dirs.set(part, next);
        }
        node = next;
      }
      node.files.set(parts[parts.length - 1] as string, entry);
    }
    const build = (node: DirNode): string => {
      const entries: TreeEntry[] = [];
      for (const [name, file] of node.files) entries.push({ mode: file.mode, name, oid: file.oid });
      for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, oid: build(dir) });
      return this.putObject(repo, 'tree', buildTree(entries));
    };
    return build(root);
  }

  /** The entry at `path` in the tree of `commitOid` (or the empty tree), or null. */
  entryAt(repo: RepoRec, commitOid: string | null, path: string): { type: 'file' | 'dir'; oid: string; mode: string } | null {
    let treeOid = this.commitTree(repo, commitOid);
    if (treeOid === null) {
      // No commit yet: only the empty path "exists", as an empty directory.
      return path === '' ? { type: 'dir', oid: this.putObject(repo, 'tree', buildTree([])), mode: '40000' } : null;
    }
    const parts = path === '' ? [] : path.split('/');
    for (let index = 0; index < parts.length; index += 1) {
      const tree = repo.objects.get(treeOid);
      if (tree === undefined || tree.type !== 'tree') return null;
      const entry = parseTree(tree.data).find((candidate) => candidate.name === parts[index]);
      if (entry === undefined) return null;
      if (index === parts.length - 1) {
        return entry.mode === '40000' ? { type: 'dir', oid: entry.oid, mode: entry.mode } : { type: 'file', oid: entry.oid, mode: entry.mode };
      }
      if (entry.mode !== '40000') return null;
      treeOid = entry.oid;
    }
    return { type: 'dir', oid: treeOid, mode: '40000' };
  }

  // ----------------------------------------------------------------------------------------------
  // Contents writes (the REST contents API's commits).
  // ----------------------------------------------------------------------------------------------

  /**
   * Write `content` at `path` on `branch`, as one commit. Returns the new commit oid and the
   * blob oid, or 'stale' when `expectedSha` does not match the file's current blob.
   */
  putContent(
    repo: RepoRec,
    branch: string,
    path: string,
    content: Buffer,
    message: string,
    expectedSha?: string,
  ): { commit: string; blob: string; created: boolean } | 'stale' {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref) ?? null;
    const flat = this.flattenTree(repo, this.commitTree(repo, tip));
    const existing = flat.get(path);
    if (existing !== undefined && expectedSha !== undefined && expectedSha !== existing.oid) return 'stale';
    if (existing === undefined && expectedSha !== undefined && expectedSha !== ZERO) return 'stale';
    const blob = this.putObject(repo, 'blob', content);
    flat.set(path, { oid: blob, mode: existing?.mode ?? '100644' });
    const tree = this.treeFromFlat(repo, flat);
    const commit = this.makeCommit(repo, tree, tip === null ? [] : [tip], message);
    repo.refs.set(ref, commit);
    return { commit, blob, created: existing === undefined };
  }

  /** Delete `path` on `branch` as one commit; 'stale' on a sha mismatch, null when the file is absent. */
  deleteContent(repo: RepoRec, branch: string, path: string, message: string, expectedSha?: string): { commit: string } | 'stale' | null {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref) ?? null;
    if (tip === null) return null;
    const flat = this.flattenTree(repo, this.commitTree(repo, tip));
    const existing = flat.get(path);
    if (existing === undefined) return null;
    if (expectedSha !== undefined && expectedSha !== existing.oid) return 'stale';
    flat.delete(path);
    const tree = this.treeFromFlat(repo, flat);
    const commit = this.makeCommit(repo, tree, [tip], message);
    repo.refs.set(ref, commit);
    return { commit };
  }

  // ----------------------------------------------------------------------------------------------
  // Issues and comments.
  // ----------------------------------------------------------------------------------------------

  createIssue(repo: RepoRec, title: string, body: string, labels: string[]): IssueRec {
    const issue: IssueRec = {
      id: this.nextIssueId,
      nodeId: Buffer.from(`I${repo.dbId}.${repo.nextNumber}`, 'utf8').toString('base64url'),
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      labels: [...labels],
      comments: [],
      createdTick: this.advance(),
    };
    this.nextIssueId += 1;
    repo.nextNumber += 1;
    repo.issues.set(issue.number, issue);
    return issue;
  }

  addComment(repo: RepoRec, issue: IssueRec, body: string): CommentRec {
    const comment: CommentRec = { id: this.nextCommentId, body };
    this.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }

  // ----------------------------------------------------------------------------------------------
  // Pull requests: creation, file diffs, and the three-way merge.
  // ----------------------------------------------------------------------------------------------

  createPull(repo: RepoRec, title: string, body: string, headRef: string, baseRef: string): PullRec | null {
    const headSha = this.branchTip(repo, headRef);
    const baseSha = this.branchTip(repo, baseRef);
    if (headSha === null || baseSha === null) return null;
    const pull: PullRec = {
      id: this.nextPullId,
      nodeId: Buffer.from(`P${repo.dbId}.${repo.nextNumber}`, 'utf8').toString('base64url'),
      number: repo.nextNumber,
      title,
      body,
      state: 'open',
      merged: false,
      headRef,
      baseRef,
      headSha,
      baseSha,
      mergeCommitSha: null,
      mergedTick: null,
      createdTick: this.advance(),
    };
    this.nextPullId += 1;
    repo.nextNumber += 1;
    repo.pulls.set(pull.number, pull);
    return pull;
  }

  /** A pull request's current head/base commit oids (live branch tips, creation snapshot as fallback). */
  pullTips(repo: RepoRec, pull: PullRec): { head: string; base: string } {
    return {
      head: this.branchTip(repo, pull.headRef) ?? pull.headSha,
      base: this.branchTip(repo, pull.baseRef) ?? pull.baseSha,
    };
  }

  /** The changed paths of a pull request: head tree against merge-base tree. */
  pullFiles(repo: RepoRec, pull: PullRec): Array<{ path: string; status: 'added' | 'modified' | 'removed'; before: string | null; after: string | null }> {
    const { head, base } = this.pullTips(repo, pull);
    const baseCommit = this.mergeBase(repo, head, base) ?? base;
    const before = this.flattenTree(repo, this.commitTree(repo, baseCommit));
    const after = this.flattenTree(repo, this.commitTree(repo, head));
    const paths = new Set<string>([...before.keys(), ...after.keys()]);
    const files: Array<{ path: string; status: 'added' | 'modified' | 'removed'; before: string | null; after: string | null }> = [];
    for (const path of [...paths].sort()) {
      const b = before.get(path);
      const a = after.get(path);
      if (b !== undefined && a === undefined) files.push({ path, status: 'removed', before: b.oid, after: null });
      else if (b === undefined && a !== undefined) files.push({ path, status: 'added', before: null, after: a.oid });
      else if (b !== undefined && a !== undefined && (b.oid !== a.oid || b.mode !== a.mode)) {
        files.push({ path, status: 'modified', before: b.oid, after: a.oid });
      }
    }
    return files;
  }

  /** Whether a pull request merges cleanly: a file-level three-way merge against the merge-base. */
  pullConflict(repo: RepoRec, pull: PullRec): boolean {
    return this.planMerge(repo, pull) === null;
  }

  /**
   * Plan a merge: the merged flat tree, or null on a conflict (both sides changed the same
   * path to different bytes, or one side changed a path the other deleted).
   */
  planMerge(repo: RepoRec, pull: PullRec): FlatTree | null {
    const { head, base } = this.pullTips(repo, pull);
    const baseCommit = this.mergeBase(repo, head, base);
    if (baseCommit === null) return null;
    if (baseCommit === this.peelToCommit(repo, head)) return null; // head brings nothing new
    const origin = this.flattenTree(repo, this.commitTree(repo, baseCommit));
    const ours = this.flattenTree(repo, this.commitTree(repo, base));
    const theirs = this.flattenTree(repo, this.commitTree(repo, head));
    const merged: FlatTree = new Map(ours);
    const paths = new Set<string>([...origin.keys(), ...theirs.keys()]);
    for (const path of paths) {
      const o = origin.get(path);
      const t = theirs.get(path);
      const u = ours.get(path);
      const same = (x: { oid: string; mode: string } | undefined, y: { oid: string; mode: string } | undefined): boolean =>
        x === undefined && y === undefined ? true : x !== undefined && y !== undefined && x.oid === y.oid && x.mode === y.mode;
      if (same(t, o)) continue; // the head side did not touch it: keep ours
      if (same(u, o)) {
        // only the head side changed it
        if (t === undefined) merged.delete(path);
        else merged.set(path, t);
        continue;
      }
      if (same(t, u)) continue; // both sides made the same change
      return null; // both sides changed it differently
    }
    return merged;
  }

  /**
   * Merge a pull request into its base branch with one commit (the squash shape; the forge
   * lands merge and rebase requests the same way, as one commit on the base). Answers the
   * merge commit oid, or null on a conflict.
   */
  mergePull(repo: RepoRec, pull: PullRec): string | null {
    const plan = this.planMerge(repo, pull);
    if (plan === null) return null;
    const { base } = this.pullTips(repo, pull);
    const tree = this.treeFromFlat(repo, plan);
    const message = pull.body === '' ? pull.title : `${pull.title}\n\n${pull.body}`;
    const commit = this.makeCommit(repo, tree, [base], message);
    repo.refs.set(`refs/heads/${pull.baseRef}`, commit);
    pull.state = 'closed';
    pull.merged = true;
    pull.mergeCommitSha = commit;
    pull.mergedTick = this.advance();
    return commit;
  }

  // ----------------------------------------------------------------------------------------------
  // Fetch selection (upload-pack): what a fetch sends, and the shallow bookkeeping.
  // ----------------------------------------------------------------------------------------------

  /**
   * Choose the objects a fetch sends: everything reachable from `wants` that the client does
   * not already hold (the closure of `haves`, truncated at the client's declared shallow
   * boundary), cut to `depth` commit generations from the wants when a depth is given.
   * Also answers the new shallow boundary and the boundary commits the fetch unshallows.
   * `complete` is false when the send set should have held an object the repository does
   * not have (an incomplete pack's gap): the answer is still the best the store can give,
   * but it must not be cached, because the missing object may arrive later.
   */
  fetchSelection(
    repo: RepoRec,
    wants: readonly string[],
    haves: readonly string[],
    shallowDeclared: readonly string[],
    depth: number | null,
  ): { objects: GitObj[]; shallow: string[]; unshallow: string[]; complete: boolean } {
    let complete = true;
    const boundary = new Set(shallowDeclared);
    const held = this.closure(repo, haves, boundary);

    // Commit generations from every want (peeling tags), so the depth cut is by ancestry.
    const generations = new Map<string, number>();
    const queue: Array<{ oid: string; gen: number }> = [];
    for (const want of wants) {
      const commit = this.peelToCommit(repo, want);
      if (commit !== null && !generations.has(commit)) {
        generations.set(commit, 1);
        queue.push({ oid: commit, gen: 1 });
      }
    }
    while (queue.length > 0) {
      const current = queue.shift();
      if (current === undefined) break;
      if (depth !== null && current.gen >= depth) continue;
      const commit = this.commitInfo(repo, current.oid);
      if (commit === null) continue;
      for (const parent of commit.parents) {
        if (!generations.has(parent)) {
          generations.set(parent, current.gen + 1);
          queue.push({ oid: parent, gen: current.gen + 1 });
        }
      }
    }

    const includedCommits = new Set<string>();
    for (const [oid, gen] of generations) {
      if (depth !== null && gen > depth) continue;
      if (!held.has(oid)) includedCommits.add(oid);
    }

    // Everything the included commits need (their trees and blobs), plus any non-commit
    // wants themselves (a tag object and what it points at), minus what the client holds.
    const send = new Set<string>();
    const stack: string[] = [];
    for (const oid of includedCommits) {
      const commit = this.commitInfo(repo, oid);
      if (commit === null) {
        complete = false;
        continue;
      }
      send.add(oid);
      stack.push(commit.tree);
    }
    for (const want of wants) {
      const object = repo.objects.get(want);
      if (object !== undefined && object.type !== 'commit') stack.push(want);
    }
    while (stack.length > 0) {
      const oid = stack.pop();
      if (oid === undefined || send.has(oid) || held.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined) {
        complete = false;
        continue;
      }
      send.add(oid);
      if (object.type === 'tree') for (const entry of parseTree(object.data)) stack.push(entry.oid);
      else if (object.type === 'tag') stack.push(parseTag(object.data).object);
      else if (object.type === 'commit') {
        const commit = this.commitInfo(repo, oid);
        if (commit !== null) stack.push(commit.tree);
      }
    }

    // The shallow boundary after this fetch: sent commits with a parent the client will not
    // have. A declared boundary commit whose parents all arrive (or were held) unshallows.
    const clientWillHave = new Set<string>([...held, ...send]);
    const shallow: string[] = [];
    for (const oid of includedCommits) {
      const commit = this.commitInfo(repo, oid);
      if (commit === null) continue;
      if (commit.parents.some((parent) => !clientWillHave.has(parent))) shallow.push(oid);
    }
    const unshallow: string[] = [];
    for (const oid of shallowDeclared) {
      const commit = this.commitInfo(repo, oid);
      if (commit === null) continue;
      if (commit.parents.length > 0 && commit.parents.every((parent) => clientWillHave.has(parent))) unshallow.push(oid);
    }

    const objects: GitObj[] = [];
    for (const oid of send) {
      const object = repo.objects.get(oid);
      if (object !== undefined) objects.push(object);
    }
    // Commits first, then trees, then blobs and tags: a stable, readable pack order.
    const rank = (object: GitObj): number => (object.type === 'commit' ? 0 : object.type === 'tree' ? 1 : 2);
    objects.sort((a, b) => rank(a) - rank(b));
    return { objects, shallow, unshallow, complete };
  }
}
