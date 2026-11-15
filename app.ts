// app.ts — the forge's HTTP server: one in-memory Forge behind four surfaces (git smart
// HTTP, REST v3, GraphQL v4, MCP) plus the harness's health probe and API root. Every API
// surface sits behind the trial's bearer token; every REST reply is JSON with an
// X-GitHub-Request-Id. main.ts owns the lifecycle; this file is the server it serves.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Forge } from './forge.ts';
import { handleGit, sendResult, type HttpResult } from './githttp.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 128 * 1024 * 1024;

/** The token the env presents (wire.ts TOKEN_ENV); empty when the harness did not set one. */
const EXPECTED_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

let requestCounter = 0;

function json(status: number, value: unknown, headers: Record<string, string> = {}): HttpResult {
  return { status, contentType: JSON_TYPE, body: Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'), headers };
}

function notFound(): HttpResult {
  return json(404, { message: 'Not Found' });
}

/** Whether the request carries the trial's bearer token (any bearer token when none was issued). */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length);
  if (token === '') return false;
  return EXPECTED_TOKEN === '' || token === EXPECTED_TOKEN;
}

/** Read a request body whole. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Percent-decode one path segment, tolerating bad escapes. */
function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

const GIT_PATH = /^\/([^/]+)\/(.+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

async function route(forge: Forge, req: IncomingMessage): Promise<HttpResult> {
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;
  const method = req.method ?? 'GET';

  // The env's boot probe: no auth, always the same answer.
  if (method === 'GET' && path === '/healthz') return json(200, { ok: true });

  // The GitHub API root, as the starter answers it: 200 with the token's scopes.
  if (method === 'GET' && (path === '/api/v3' || path === '/api/v3/')) {
    return json(
      200,
      {
        current_user_url: '/api/v3/user',
        repository_url: '/api/v3/repos/{owner}/{repo}',
        rate_limit_url: '/api/v3/rate_limit',
      },
      { 'x-oauth-scopes': 'repo, read:org' },
    );
  }

  const gitMatch = GIT_PATH.exec(path);
  const isApi = path.startsWith('/api/v3/') || path === '/api/graphql' || path === '/mcp' || gitMatch !== null;
  if (!isApi) return notFound();

  // Every remaining surface is the token owner's: no token (or a wrong one) is a 401 with a
  // JSON message, never a redirect or an HTML error page.
  if (!authorized(req)) return json(401, { message: 'Bad credentials' });

  if (gitMatch !== null) {
    const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
    return handleGit(forge, decodeSegment(gitMatch[1] as string), decodeSegment(gitMatch[2] as string), gitMatch[3] as string, req, body, url.searchParams);
  }

  if (path === '/api/graphql') {
    if (method !== 'POST') return notFound();
    const body = await readBody(req);
    return handleGraphQL(forge, body.toString('utf8'));
  }

  if (path === '/mcp') {
    if (method === 'DELETE') return json(200, {});
    if (method !== 'POST') return json(405, { message: 'Method Not Allowed' });
    const body = await readBody(req);
    return handleMcp(forge, body.toString('utf8'));
  }

  // REST v3.
  const body = await readBody(req);
  const segments = path
    .slice('/api/v3/'.length)
    .split('/')
    .filter((segment) => segment !== '')
    .map(decodeSegment);
  const host = req.headers.host ?? 'localhost';
  return handleRest({
    forge,
    method,
    segments,
    query: url.searchParams,
    bodyText: body.toString('utf8'),
    origin: `http://${host}`,
    pathname: path,
  });
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const forge = new Forge();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    requestCounter += 1;
    const requestId = `req-${requestCounter}`;
    route(forge, req)
      .then((result) => {
        const headers = { ...(result.headers ?? {}), 'x-github-request-id': requestId };
        sendResult(res, { ...result, headers });
      })
      .catch(() => {
        // A handler failure is a JSON 500, never a dead server.
        if (!res.headersSent) {
          sendResult(res, json(500, { message: 'Internal Server Error' }, { 'x-github-request-id': requestId }));
        } else {
          res.end();
        }
      });
  });
  return server;
}
