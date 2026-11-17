// graphql.ts — the GitHub GraphQL v4 surface: a small parser for the documents gh and
// github-mcp-server send (operations, variables, aliases, inline fragments, input objects,
// enum lists, batching) and an executor over the shared forge store, with the __type
// introspection those clients feature-detect with. Global ids are opaque base64url
// (the same scheme the REST node_id fields use) and decode back to the same objects.

import type { Forge, IssueRec, PullRec, RepoRec } from './forge.ts';
import type { HttpResult } from './githttp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

function json(status: number, value: unknown): HttpResult {
  return { status, contentType: JSON_TYPE, body: Buffer.from(`${JSON.stringify(value)}\n`, 'utf8') };
}

// ------------------------------------------------------------------------------------------------
// Global ids.
// ------------------------------------------------------------------------------------------------

export function encodeId(raw: string): string {
  return Buffer.from(raw, 'utf8').toString('base64url');
}

export function decodeId(id: string): { kind: 'repo' | 'issue' | 'pull' | 'comment'; repoDbId: number; number: number } | null {
  let raw: string;
  try {
    raw = Buffer.from(id, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  let match = /^R(\d+)$/.exec(raw);
  if (match !== null) return { kind: 'repo', repoDbId: Number(match[1]), number: 0 };
  match = /^I(\d+)\.(\d+)$/.exec(raw);
  if (match !== null) return { kind: 'issue', repoDbId: Number(match[1]), number: Number(match[2]) };
  match = /^P(\d+)\.(\d+)$/.exec(raw);
  if (match !== null) return { kind: 'pull', repoDbId: Number(match[1]), number: Number(match[2]) };
  match = /^C(\d+)\.(\d+)$/.exec(raw);
  if (match !== null) return { kind: 'comment', repoDbId: Number(match[1]), number: Number(match[2]) };
  return null;
}

const repoId = (repo: RepoRec): string => encodeId(`R${repo.dbId}`);
const issueId = (repo: RepoRec, issue: IssueRec): string => encodeId(`I${repo.dbId}.${issue.number}`);
const pullId = (repo: RepoRec, pull: PullRec): string => encodeId(`P${repo.dbId}.${pull.number}`);
const commentId = (repo: RepoRec, commentDbId: number): string => encodeId(`C${repo.dbId}.${commentDbId}`);

// ------------------------------------------------------------------------------------------------
// The parser.
// ------------------------------------------------------------------------------------------------

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Array<{ name: string; value: Value }> };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Map<string, Value>;
  selection: SelectionNode[] | null;
}

type SelectionNode =
  | { kind: 'field'; field: FieldNode }
  | { kind: 'inline'; typeCondition: string; selection: SelectionNode[] }
  | { kind: 'spread'; name: string };

interface OperationNode {
  type: 'query' | 'mutation';
  name: string | null;
  selection: SelectionNode[];
}

interface FragmentNode {
  typeCondition: string;
  selection: SelectionNode[];
}

interface DocumentNode {
  operations: OperationNode[];
  fragments: Map<string, FragmentNode>;
}

class ParseError extends Error {}

function tokenize(source: string): Array<{ kind: string; value: string }> {
  const tokens: Array<{ kind: string; value: string }> = [];
  let at = 0;
  while (at < source.length) {
    const ch = source[at] as string;
    if (ch === '#') {
      while (at < source.length && source[at] !== '\n') at += 1;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      at += 1;
      continue;
    }
    if (source.startsWith('...', at)) {
      tokens.push({ kind: 'spread', value: '...' });
      at += 3;
      continue;
    }
    if ('{}()[]:$!@='.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      at += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', at)) {
        const end = source.indexOf('"""', at + 3);
        if (end < 0) throw new ParseError('unterminated block string');
        tokens.push({ kind: 'string', value: source.slice(at + 3, end) });
        at = end + 3;
        continue;
      }
      let value = '';
      at += 1;
      while (at < source.length && source[at] !== '"') {
        if (source[at] === '\\') {
          const escaped = source[at + 1];
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"' };
          if (escaped === 'u') {
            value += String.fromCharCode(Number.parseInt(source.slice(at + 2, at + 6), 16));
            at += 6;
          } else {
            value += map[escaped ?? ''] ?? escaped ?? '';
            at += 2;
          }
        } else {
          value += source[at];
          at += 1;
        }
      }
      if (at >= source.length) throw new ParseError('unterminated string');
      at += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      const match = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(source.slice(at));
      if (match === null) throw new ParseError(`bad number at ${at}`);
      const text = match[0];
      tokens.push({ kind: text.includes('.') || text.includes('e') || text.includes('E') ? 'float' : 'int', value: text });
      at += text.length;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(source.slice(at));
      const text = (match as RegExpExecArray)[0];
      tokens.push({ kind: 'name', value: text });
      at += text.length;
      continue;
    }
    throw new ParseError(`unexpected character ${JSON.stringify(ch)} at ${at}`);
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

class Parser {
  private readonly tokens: Array<{ kind: string; value: string }>;
  private at = 0;

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): { kind: string; value: string } {
    return this.tokens[this.at] as { kind: string; value: string };
  }

  private next(): { kind: string; value: string } {
    const token = this.tokens[this.at] as { kind: string; value: string };
    this.at += 1;
    return token;
  }

  private expect(kind: string, value?: string): { kind: string; value: string } {
    const token = this.next();
    if (token.kind !== kind || (value !== undefined && token.value !== value)) {
      throw new ParseError(`expected ${value ?? kind}, got ${token.kind} ${JSON.stringify(token.value)}`);
    }
    return token;
  }

  private skip(kind: string, value?: string): boolean {
    const token = this.peek();
    if (token.kind === kind && (value === undefined || token.value === value)) {
      this.at += 1;
      return true;
    }
    return false;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments = new Map<string, FragmentNode>();
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.peek().kind === 'punct' && this.peek().value === '(') this.parseVariableDefinitions();
        this.skipDirectives();
        operations.push({ type: token.value, name, selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.expect('name').value;
        this.expect('name', 'on');
        const typeCondition = this.expect('name').value;
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
        continue;
      }
      throw new ParseError(`unexpected token ${token.kind} ${JSON.stringify(token.value)}`);
    }
    return { operations, fragments };
  }

  private parseVariableDefinitions(): void {
    this.expect('punct', '(');
    while (!this.skip('punct', ')')) {
      this.expect('punct', '$');
      this.expect('name');
      this.expect('punct', ':');
      this.parseType();
      if (this.skip('punct', '=')) this.parseValue();
      this.skipDirectives();
    }
  }

  private parseType(): void {
    if (this.skip('punct', '[')) {
      this.parseType();
      this.expect('punct', ']');
    } else {
      this.expect('name');
    }
    this.skip('punct', '!');
  }

  private skipDirectives(): void {
    while (this.skip('punct', '@')) {
      this.expect('name');
      if (this.peek().kind === 'punct' && this.peek().value === '(') {
        this.expect('punct', '(');
        while (!this.skip('punct', ')')) {
          this.expect('name');
          this.expect('punct', ':');
          this.parseValue();
        }
      }
    }
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expect('punct', '{');
    const selections: SelectionNode[] = [];
    while (!this.skip('punct', '}')) {
      if (this.peek().kind === 'spread') {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          const typeCondition = this.expect('name').value;
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selection: this.parseSelectionSet() });
        } else {
          const name = this.expect('name').value;
          this.skipDirectives();
          selections.push({ kind: 'spread', name });
        }
        continue;
      }
      selections.push({ kind: 'field', field: this.parseField() });
    }
    return selections;
  }

  private parseField(): FieldNode {
    let name = this.expect('name').value;
    let alias: string | null = null;
    if (this.skip('punct', ':')) {
      alias = name;
      name = this.expect('name').value;
    }
    const args = new Map<string, Value>();
    if (this.peek().kind === 'punct' && this.peek().value === '(') {
      this.next();
      while (!this.skip('punct', ')')) {
        const argName = this.expect('name').value;
        this.expect('punct', ':');
        args.set(argName, this.parseValue());
      }
    }
    this.skipDirectives();
    let selection: SelectionNode[] | null = null;
    if (this.peek().kind === 'punct' && this.peek().value === '{') selection = this.parseSelectionSet();
    return { alias, name, args, selection };
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'var', name: this.expect('name').value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      while (!this.skip('punct', ']')) items.push(this.parseValue());
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: Value }> = [];
      while (!this.skip('punct', '}')) {
        const name = this.expect('name').value;
        this.expect('punct', ':');
        fields.push({ name, value: this.parseValue() });
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new ParseError(`unexpected value token ${token.kind} ${JSON.stringify(token.value)}`);
  }
}

// ------------------------------------------------------------------------------------------------
// The schema the introspection probes read.
// ------------------------------------------------------------------------------------------------

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Query: ['viewer', 'repository', 'node', 'rateLimit', 'meta'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'updateIssue', 'addReaction'],
  User: ['id', 'login', 'name', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'hasProjectsEnabled', 'description', 'isPrivate', 'isArchived', 'createdAt',
    'updatedAt', 'url', 'issue', 'issues', 'pullRequest', 'pullRequests', 'labels', 'refs',
  ],
  Ref: ['id', 'name', 'prefix', 'target'],
  Issue: [
    'id', 'number', 'title', 'state', 'body', 'author', 'repository', 'labels', 'comments',
    'createdAt', 'updatedAt', 'closedAt', 'url', 'viewerCanReact',
  ],
  PullRequest: [
    'id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable', 'headRefName',
    'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'createdAt', 'updatedAt', 'url',
    'mergeCommit', 'viewerCanUpdate',
  ],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Comment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  IssueComment: ['id', 'body', 'author', 'createdAt', 'updatedAt', 'url'],
  CreateIssuePayload: ['clientMutationId', 'issue'],
  CloseIssuePayload: ['clientMutationId', 'issue'],
  CreatePullRequestPayload: ['clientMutationId', 'pullRequest'],
  MergePullRequestPayload: ['clientMutationId', 'pullRequest'],
  AddCommentPayload: ['clientMutationId', 'commentEdge', 'subject'],
  CommentEdge: ['cursor', 'node'],
  __Type: ['kind', 'name', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'interfaces', 'ofType'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
  __Directive: ['name', 'description', 'locations', 'args'],
  __Schema: ['types', 'queryType', 'mutationType', 'directives'],
};

const ENUM_VALUES: Readonly<Record<string, readonly string[]>> = {
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'CODE'],
  FileChangeType: ['ADDED', 'MODIFIED', 'DELETED', 'RENAMED', 'COPIED', 'CHANGED'],
};

// ------------------------------------------------------------------------------------------------
// The executor.
// ------------------------------------------------------------------------------------------------

/** A field's resolved value: a scalar, or an object/list carrying its GraphQL type for the walk. */
type Resolved =
  | { form: 'scalar'; value: unknown }
  | { form: 'object'; type: string; source: unknown }
  | { form: 'list'; items: Resolved[] };

const scalar = (value: unknown): Resolved => ({ form: 'scalar', value });
const object = (type: string, source: unknown): Resolved => ({ form: 'object', type, source });
const list = (items: Resolved[]): Resolved => ({ form: 'list', items });

interface ExecContext {
  forge: Forge;
  variables: Record<string, unknown>;
  fragments: Map<string, FragmentNode>;
  errors: Array<{ message: string }>;
}

function valueOf(ctx: ExecContext, value: Value): unknown {
  switch (value.kind) {
    case 'var':
      return ctx.variables[value.name];
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => valueOf(ctx, item));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = valueOf(ctx, field.value);
      return out;
    }
  }
}

function argsOf(ctx: ExecContext, field: FieldNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of field.args) out[name] = valueOf(ctx, value);
  return out;
}

interface IssuePage {
  items: Array<{ repo: RepoRec; issue: IssueRec }>;
  hasNextPage: boolean;
  endCursor: string | null;
}

function issueCursor(repo: RepoRec, issue: IssueRec): string {
  return encodeId(`cursor:${repo.dbId}:${issue.number}`);
}

function issuesConnection(forge: Forge, repo: RepoRec, args: Record<string, unknown>): IssuePage & { total: number } {
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  let issues = [...repo.issues.values()];
  if (states !== null) {
    issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
  }
  const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
  issues.sort((a, b) => a.number - b.number);
  if (orderBy !== null && orderBy.direction === 'DESC') issues.reverse();
  const total = issues.length;
  const after = typeof args.after === 'string' && args.after !== '' ? args.after : null;
  let startIndex = 0;
  if (after !== null) {
    const index = issues.findIndex((issue) => issueCursor(repo, issue) === after);
    if (index >= 0) startIndex = index + 1;
  }
  const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.trunc(args.first)) : total;
  const page = issues.slice(startIndex, startIndex + first);
  return {
    items: page.map((issue) => ({ repo, issue })),
    hasNextPage: startIndex + page.length < total,
    endCursor: page.length > 0 ? issueCursor(repo, page[page.length - 1] as IssueRec) : after,
    total,
  };
}

/** Resolve one field on one object type. Unknown fields record a GraphQL error, per the wire rules. */
function resolveField(ctx: ExecContext, type: string, source: unknown, field: FieldNode): Resolved {
  const forge = ctx.forge;
  const args = argsOf(ctx, field);
  const name = field.name;
  if (name === '__typename') return scalar(type);

  switch (type) {
    case 'Query': {
      if (name === 'viewer') return object('User', { login: forge.login() });
      if (name === 'repository') {
        const owner = typeof args.owner === 'string' ? args.owner : '';
        const repoName = typeof args.name === 'string' ? args.name : '';
        const repo = forge.repoFor(owner, repoName);
        return repo === null ? scalar(null) : object('Repository', repo);
      }
      if (name === 'node') {
        const decoded = typeof args.id === 'string' ? decodeId(args.id) : null;
        if (decoded === null) return scalar(null);
        const repo = forge.repoByDbId(decoded.repoDbId);
        if (repo === null) return scalar(null);
        if (decoded.kind === 'repo') return object('Repository', repo);
        if (decoded.kind === 'issue') {
          const issue = repo.issues.get(decoded.number);
          return issue === undefined ? scalar(null) : object('Issue', { repo, issue });
        }
        if (decoded.kind === 'pull') {
          const pull = repo.pulls.get(decoded.number);
          return pull === undefined ? scalar(null) : object('PullRequest', { repo, pull });
        }
        return scalar(null);
      }
      if (name === '__type') {
        const typeName = typeof args.name === 'string' ? args.name : '';
        if (TYPE_FIELDS[typeName] !== undefined) return object('__Type', { name: typeName, kind: 'OBJECT' });
        if (ENUM_VALUES[typeName] !== undefined) return object('__Type', { name: typeName, kind: 'ENUM' });
        return scalar(null);
      }
      break;
    }
    case 'Mutation': {
      if (name === 'createIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = typeof input.repositoryId === 'string' ? decodeId(input.repositoryId) : null;
        const repo = decoded !== null && decoded.kind === 'repo' ? forge.repoByDbId(decoded.repoDbId) : null;
        if (repo === null) {
          ctx.errors.push({ message: 'Could not resolve to a Repository with the given id.' });
          return object('CreateIssuePayload', { issue: null });
        }
        const issue = forge.createIssue(repo, typeof input.title === 'string' ? input.title : '', typeof input.body === 'string' ? input.body : '', []);
        return object('CreateIssuePayload', { issue: { repo, issue } });
      }
      if (name === 'closeIssue') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = typeof input.issueId === 'string' ? decodeId(input.issueId) : null;
        const repo = decoded !== null ? forge.repoByDbId(decoded.repoDbId) : null;
        const issue = repo !== null && decoded !== null && decoded.kind === 'issue' ? repo.issues.get(decoded.number) : undefined;
        if (repo === null || issue === undefined) {
          ctx.errors.push({ message: 'Could not resolve to an Issue with the given id.' });
          return object('CloseIssuePayload', { issue: null });
        }
        issue.state = 'closed';
        forge.invalidateIssueBody(repo, decoded.number);
        return object('CloseIssuePayload', { issue: { repo, issue } });
      }
      if (name === 'createPullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = typeof input.repositoryId === 'string' ? decodeId(input.repositoryId) : null;
        const repo = decoded !== null && decoded.kind === 'repo' ? forge.repoByDbId(decoded.repoDbId) : null;
        if (repo === null) {
          ctx.errors.push({ message: 'Could not resolve to a Repository with the given id.' });
          return object('CreatePullRequestPayload', { pull: null });
        }
        const pull = forge.createPull(
          repo,
          typeof input.title === 'string' ? input.title : '',
          typeof input.body === 'string' ? input.body : '',
          typeof input.headRefName === 'string' ? input.headRefName : '',
          typeof input.baseRefName === 'string' ? input.baseRefName : '',
        );
        if (pull === null) {
          ctx.errors.push({ message: 'Could not create the pull request: a head or base branch does not exist.' });
          return object('CreatePullRequestPayload', { pull: null });
        }
        return object('CreatePullRequestPayload', { pull: { repo, pull } });
      }
      if (name === 'mergePullRequest') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = typeof input.pullRequestId === 'string' ? decodeId(input.pullRequestId) : null;
        const repo = decoded !== null ? forge.repoByDbId(decoded.repoDbId) : null;
        const pull = repo !== null && decoded !== null && decoded.kind === 'pull' ? repo.pulls.get(decoded.number) : undefined;
        if (repo === null || pull === undefined) {
          ctx.errors.push({ message: 'Could not resolve to a PullRequest with the given id.' });
          return object('MergePullRequestPayload', { pull: null });
        }
        if (pull.state === 'open') {
          const sha = forge.mergePull(repo, pull);
          if (sha === null) ctx.errors.push({ message: 'Pull Request is not mergeable' });
        }
        return object('MergePullRequestPayload', { pull: { repo, pull } });
      }
      if (name === 'addComment') {
        const input = (args.input ?? {}) as Record<string, unknown>;
        const decoded = typeof input.subjectId === 'string' ? decodeId(input.subjectId) : null;
        const repo = decoded !== null ? forge.repoByDbId(decoded.repoDbId) : null;
        const issue = repo !== null && decoded !== null && decoded.kind === 'issue' ? repo.issues.get(decoded.number) : undefined;
        if (repo === null || issue === undefined) {
          ctx.errors.push({ message: 'Could not resolve to a subject with the given id.' });
          return object('AddCommentPayload', { edge: null });
        }
        const comment = forge.addComment(repo, issue, typeof input.body === 'string' ? input.body : '');
        forge.invalidateIssueBody(repo, decoded.number);
        return object('AddCommentPayload', { edge: { repo, comment } });
      }
      break;
    }
    case 'User': {
      const user = source as { login: string };
      if (name === 'login') return scalar(user.login);
      if (name === 'id') return scalar(encodeId(`U${user.login}`));
      if (name === 'name') return scalar(user.login);
      if (name === 'url') return scalar(`https://forge.local/${user.login}`);
      break;
    }
    case 'Repository': {
      const repo = source as RepoRec;
      switch (name) {
        case 'id':
          return scalar(repoId(repo));
        case 'databaseId':
          return scalar(repo.dbId);
        case 'name':
          return scalar(repo.name);
        case 'nameWithOwner':
          return scalar(`${forge.login()}/${repo.name}`);
        case 'owner':
          return object('User', { login: forge.login() });
        case 'defaultBranchRef':
          return object('Ref', { name: repo.defaultBranch });
        case 'viewerPermission':
          return scalar('ADMIN');
        case 'hasIssuesEnabled':
        case 'hasProjectsEnabled':
          return scalar(true);
        case 'description':
          return scalar(repo.description === '' ? null : repo.description);
        case 'isPrivate':
          return scalar(repo.private);
        case 'isArchived':
          return scalar(false);
        case 'createdAt':
          return scalar(forge.isoOf(repo.createdTick));
        case 'updatedAt':
          return scalar(forge.nowIso());
        case 'url':
          return scalar(`https://forge.local/${forge.login()}/${repo.name}`);
        case 'issue': {
          const number = typeof args.number === 'number' ? args.number : -1;
          const issue = repo.issues.get(number);
          return issue === undefined ? scalar(null) : object('Issue', { repo, issue });
        }
        case 'issues': {
          const page = issuesConnection(forge, repo, args);
          return object('IssueConnection', page);
        }
        case 'pullRequest': {
          const number = typeof args.number === 'number' ? args.number : -1;
          const pull = repo.pulls.get(number);
          return pull === undefined ? scalar(null) : object('PullRequest', { repo, pull });
        }
        case 'pullRequests': {
          const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.trunc(args.first)) : 100;
          const pulls = [...repo.pulls.values()].sort((a, b) => a.number - b.number).slice(0, first);
          return object('PullRequestConnection', {
            items: pulls.map((pull) => ({ repo, pull })),
            total: repo.pulls.size,
          });
        }
      }
      break;
    }
    case 'Ref': {
      const ref = source as { name: string };
      if (name === 'name') return scalar(ref.name);
      if (name === 'prefix') return scalar('refs/heads/');
      if (name === 'id') return scalar(encodeId(`Ref:${ref.name}`));
      break;
    }
    case 'Issue': {
      const { repo, issue } = source as { repo: RepoRec; issue: IssueRec };
      switch (name) {
        case 'id':
          return scalar(issueId(repo, issue));
        case 'number':
          return scalar(issue.number);
        case 'title':
          return scalar(issue.title);
        case 'body':
          return scalar(issue.body);
        case 'state':
          return scalar(issue.state.toUpperCase());
        case 'author':
          return object('User', { login: forge.login() });
        case 'repository':
          return object('Repository', repo);
        case 'createdAt':
          return scalar(forge.isoOf(issue.createdTick));
        case 'updatedAt':
          return scalar(forge.isoOf(issue.createdTick));
        case 'closedAt':
          return scalar(issue.state === 'closed' ? forge.nowIso() : null);
        case 'url':
          return scalar(`https://forge.local/${forge.login()}/${repo.name}/issues/${issue.number}`);
      }
      break;
    }
    case 'PullRequest': {
      const { repo, pull } = source as { repo: RepoRec; pull: PullRec };
      switch (name) {
        case 'id':
          return scalar(pullId(repo, pull));
        case 'number':
          return scalar(pull.number);
        case 'title':
          return scalar(pull.title);
        case 'body':
          return scalar(pull.body);
        case 'state':
          return scalar(pull.merged ? 'MERGED' : pull.state.toUpperCase());
        case 'merged':
          return scalar(pull.merged);
        case 'mergedAt':
          return scalar(pull.mergedTick === null ? null : forge.isoOf(pull.mergedTick));
        case 'headRefName':
          return scalar(pull.headRef);
        case 'baseRefName':
          return scalar(pull.baseRef);
        case 'mergeable':
          return scalar(pull.state !== 'open' ? 'UNKNOWN' : forge.pullConflict(repo, pull) ? 'CONFLICTING' : 'MERGEABLE');
        case 'author':
          return object('User', { login: forge.login() });
        case 'createdAt':
          return scalar(forge.isoOf(pull.createdTick));
        case 'updatedAt':
          return scalar(forge.isoOf(pull.createdTick));
        case 'url':
          return scalar(`https://forge.local/${forge.login()}/${repo.name}/pull/${pull.number}`);
        case 'files': {
          const first = typeof args.first === 'number' && Number.isFinite(args.first) ? Math.max(0, Math.trunc(args.first)) : 100;
          const files = forge.pullFiles(repo, pull).slice(0, first);
          return object('PullRequestFileConnection', {
            items: files.map((file) => ({ path: file.path, status: file.status })),
          });
        }
      }
      break;
    }
    case 'PullRequestChangedFile': {
      const file = source as { path: string; status: string };
      if (name === 'path') return scalar(file.path);
      if (name === 'additions') return scalar(0);
      if (name === 'deletions') return scalar(0);
      if (name === 'changeType') return scalar(file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED');
      break;
    }
    case 'IssueConnection': {
      const page = source as IssuePage & { total: number };
      if (name === 'nodes') return list(page.items.map((item) => object('Issue', item)));
      if (name === 'pageInfo') {
        return object('PageInfo', {
          hasNextPage: page.hasNextPage,
          hasPreviousPage: false,
          startCursor: page.items.length > 0 ? issueCursor(page.items[0]?.repo as RepoRec, page.items[0]?.issue as IssueRec) : null,
          endCursor: page.endCursor,
        });
      }
      if (name === 'totalCount') return scalar(page.total);
      break;
    }
    case 'PullRequestConnection': {
      const connection = source as { items: Array<{ repo: RepoRec; pull: PullRec }>; total: number };
      if (name === 'nodes') return list(connection.items.map((item) => object('PullRequest', item)));
      if (name === 'totalCount') return scalar(connection.total);
      if (name === 'pageInfo') {
        return object('PageInfo', { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null });
      }
      break;
    }
    case 'PullRequestFileConnection': {
      const connection = source as { items: Array<{ path: string; status: string }> };
      if (name === 'nodes') return list(connection.items.map((item) => object('PullRequestChangedFile', item)));
      if (name === 'totalCount') return scalar(connection.items.length);
      break;
    }
    case 'PageInfo': {
      const info = source as { hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null };
      if (name === 'hasNextPage') return scalar(info.hasNextPage);
      if (name === 'hasPreviousPage') return scalar(info.hasPreviousPage);
      if (name === 'startCursor') return scalar(info.startCursor);
      if (name === 'endCursor') return scalar(info.endCursor);
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      const payload = source as { issue: { repo: RepoRec; issue: IssueRec } | null };
      if (name === 'issue') return payload.issue === null ? scalar(null) : object('Issue', payload.issue);
      if (name === 'clientMutationId') return scalar(null);
      break;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      const payload = source as { pull: { repo: RepoRec; pull: PullRec } | null };
      if (name === 'pullRequest') return payload.pull === null ? scalar(null) : object('PullRequest', payload.pull);
      if (name === 'clientMutationId') return scalar(null);
      break;
    }
    case 'AddCommentPayload': {
      const payload = source as { edge: { repo: RepoRec; comment: { id: number; body: string } } | null };
      if (name === 'commentEdge') return payload.edge === null ? scalar(null) : object('CommentEdge', payload.edge);
      if (name === 'clientMutationId') return scalar(null);
      break;
    }
    case 'CommentEdge': {
      const edge = source as { repo: RepoRec; comment: { id: number; body: string } };
      if (name === 'node') return object('IssueComment', edge);
      if (name === 'cursor') return scalar(encodeId(`cursor:c:${edge.comment.id}`));
      break;
    }
    case 'IssueComment':
    case 'Comment': {
      const entry = source as { repo: RepoRec; comment: { id: number; body: string } };
      if (name === 'id') return scalar(commentId(entry.repo, entry.comment.id));
      if (name === 'body') return scalar(entry.comment.body);
      if (name === 'author') return object('User', { login: forge.login() });
      if (name === 'createdAt' || name === 'updatedAt') return scalar(forge.nowIso());
      break;
    }
    case '__Type': {
      const typeInfo = source as { name: string; kind: string };
      if (name === 'name') return scalar(typeInfo.name);
      if (name === 'kind') return scalar(typeInfo.kind);
      if (name === 'description') return scalar(null);
      if (name === 'fields') {
        const fields = TYPE_FIELDS[typeInfo.name];
        if (fields === undefined) return scalar(null);
        return list(fields.map((fieldName) => object('__Field', { name: fieldName })));
      }
      if (name === 'enumValues') {
        const values = ENUM_VALUES[typeInfo.name];
        if (values === undefined) return scalar(null);
        return list(values.map((valueName) => object('__EnumValue', { name: valueName })));
      }
      if (name === 'possibleTypes' || name === 'inputFields' || name === 'interfaces') return list([]);
      if (name === 'ofType') return scalar(null);
      break;
    }
    case '__Field': {
      const fieldInfo = source as { name: string };
      if (name === 'name') return scalar(fieldInfo.name);
      if (name === 'description') return scalar(null);
      if (name === 'isDeprecated') return scalar(false);
      if (name === 'deprecationReason') return scalar(null);
      if (name === 'args') return list([]);
      if (name === 'type') return scalar(null);
      break;
    }
    case '__EnumValue': {
      const enumInfo = source as { name: string };
      if (name === 'name') return scalar(enumInfo.name);
      if (name === 'description') return scalar(null);
      if (name === 'isDeprecated') return scalar(false);
      if (name === 'deprecationReason') return scalar(null);
      break;
    }
  }

  ctx.errors.push({ message: `Field '${name}' doesn't exist on type '${type}'` });
  return scalar(null);
}

/** Materialize a resolved value against a selection set into plain JSON. */
function materialize(ctx: ExecContext, resolved: Resolved, selection: SelectionNode[] | null): unknown {
  if (resolved.form === 'scalar') return resolved.value;
  if (resolved.form === 'list') return resolved.items.map((item) => materialize(ctx, item, selection));
  const out: Record<string, unknown> = {};
  const walk = (type: string, selections: SelectionNode[]): void => {
    for (const node of selections) {
      if (node.kind === 'field') {
        const key = node.field.alias ?? node.field.name;
        const value = resolveField(ctx, type, resolved.source, node.field);
        out[key] = materialize(ctx, value, node.field.selection);
      } else if (node.kind === 'inline') {
        if (node.typeCondition === type || node.typeCondition === 'Node') walk(type, node.selection);
      } else {
        const fragment = ctx.fragments.get(node.name);
        if (fragment !== undefined && (fragment.typeCondition === type || fragment.typeCondition === 'Node')) {
          walk(type, fragment.selection);
        }
      }
    }
  };
  walk(resolved.type, selection ?? []);
  return out;
}

function executeOperation(forge: Forge, document: DocumentNode, operation: OperationNode, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: ExecContext = { forge, variables, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = materialize(ctx, object(rootType, null), operation.selection);
  const envelope: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return envelope;
}

/** Handle one POST /api/graphql body (a single operation or a batch array). */
export function handleGraphQL(forge: Forge, bodyText: string): HttpResult {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return json(400, { errors: [{ message: 'Invalid JSON body' }] });
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { data: null, errors: [{ message: 'Invalid operation' }] };
    }
    const operation = entry as { query?: unknown; variables?: unknown; operationName?: unknown };
    if (typeof operation.query !== 'string') return { data: null, errors: [{ message: 'Missing query' }] };
    let document: DocumentNode;
    try {
      document = new Parser(operation.query).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'Parse error' }] };
    }
    const variables = (operation.variables ?? {}) as Record<string, unknown>;
    let chosen: OperationNode | undefined;
    if (typeof operation.operationName === 'string') {
      chosen = document.operations.find((candidate) => candidate.name === operation.operationName);
    }
    chosen ??= document.operations[0];
    if (chosen === undefined) return { data: null, errors: [{ message: 'No operation in document' }] };
    return executeOperation(forge, document, chosen, variables);
  };
  if (Array.isArray(body)) return json(200, body.map(runOne));
  return json(200, runOne(body));
}
