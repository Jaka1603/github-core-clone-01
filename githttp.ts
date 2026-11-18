// githttp.ts — git smart HTTP: info/refs advertisements (protocol v0 and v2), v2 ls-refs,
// v2 and v0 fetch (upload-pack) with have negotiation and shallow/deepen, and receive-pack
// pushes with fast-forward enforcement and a side-band report-status. Written against the
// git wire protocol; object and pack mechanics live in gitstore.ts, the store in forge.ts.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { PKT_DELIM, PKT_FLUSH, pktLine, readPack, writePack, ZERO_OID, type Pkt } from './gitstore.ts';
import type { Forge, RepoRec } from './forge.ts';

const AGENT = 'makefun-forge/1.0';
const UPLOAD_CAPS = `multi_ack_detailed side-band-64k thin-pack ofs-delta shallow object-format=sha1 agent=${AGENT}`;
const RECEIVE_CAPS = `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;

export interface HttpResult {
  status: number;
  contentType: string;
  body: Buffer;
  headers?: Record<string, string>;
}

function json(status: number, value: unknown): HttpResult {
  return { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify(value)}\n`, 'utf8') };
}

function notFound(): HttpResult {
  return json(404, { message: 'Not Found' });
}

/** The HEAD target ref of a repository: its default branch. */
function headRef(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** Ref lines for a v0 advertisement: HEAD first (caps on the first line), then every ref, tags peeled. */
function v0RefLines(forge: Forge, repo: RepoRec, caps: string): Buffer[] {
  const lines: Buffer[] = [];
  const refs = forge.sortedRefs(repo);
  const head = headRef(repo);
  const headTip = repo.refs.get(head);
  let capsPending = `\0${caps} symref=HEAD:${head}`;
  const pushLine = (text: string): void => {
    lines.push(pktLine(`${text}${capsPending}\n`));
    capsPending = '';
  };
  if (headTip !== undefined) {
    pushLine(`${headTip} HEAD`);
  }
  if (refs.length === 0 && headTip === undefined) {
    pushLine(`${ZERO_OID} capabilities^{}`);
  }
  for (const [name, oid] of refs) {
    pushLine(`${oid} ${name}`);
    const object = repo.objects.get(oid);
    if (object !== undefined && object.type === 'tag') {
      const peeled = forge.peelToCommit(repo, oid);
      if (peeled !== null) lines.push(pktLine(`${peeled} ${name}^{}\n`));
    }
  }
  return lines;
}

/** The protocol-v2 advertisement: the same bytes for every repository and request, built once. */
const V2_ADVERTISEMENT: Buffer = Buffer.concat([
  pktLine('version 2\n'),
  pktLine(`agent=${AGENT}\n`),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow\n'),
  pktLine('object-format=sha1\n'),
  PKT_FLUSH,
]);

function infoRefs(forge: Forge, repo: RepoRec, service: string, protocolHeader: string | undefined): HttpResult {
  if (service === 'git-upload-pack' && protocolHeader !== undefined && protocolHeader.includes('version=2')) {
    return { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: V2_ADVERTISEMENT };
  }
  const caps = service === 'git-upload-pack' ? UPLOAD_CAPS : RECEIVE_CAPS;
  const body = Buffer.concat([pktLine(`# service=${service}\n`), PKT_FLUSH, ...v0RefLines(forge, repo, caps), PKT_FLUSH]);
  return { status: 200, contentType: `application/x-git-${service === 'git-upload-pack' ? 'upload-pack' : 'receive-pack'}-advertisement`, body };
}

/**
 * Split a request body's leading pkt-lines from the raw bytes that follow them (a push's
 * pack begins right after the command list's flush). Null when the body does not start
 * with a pkt-line length at all — the malformed body the suite probes with.
 */
function splitPktStream(body: Buffer): { packets: Pkt[]; rest: Buffer } | null {
  if (body.length > 0 && !/^[0-9a-f]{4}$/.test(body.toString('ascii', 0, 4))) return null;
  const packets: Pkt[] = [];
  let at = 0;
  while (at + 4 <= body.length) {
    const head = body.toString('ascii', at, at + 4);
    if (!/^[0-9a-f]{4}$/.test(head)) break;
    const length = parseInt(head, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      at += 4;
      return { packets, rest: body.subarray(at) };
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      at += 4;
      continue;
    }
    if (length < 4 || at + length > body.length) break;
    packets.push({ kind: 'data', payload: body.subarray(at + 4, at + length) });
    at += length;
  }
  return { packets, rest: body.subarray(at) };
}

/** The data payloads of a packet list, as text lines (newline-trimmed). */
function dataLines(packets: readonly Pkt[]): string[] {
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

/** v2 ls-refs: HEAD (when it matches the prefixes), the filtered refs, peeled tags on request. */
function lsRefs(forge: Forge, repo: RepoRec, packets: readonly Pkt[]): HttpResult {
  // Arguments follow the delim packet; capability lines precede it.
  const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
  const args = delimIndex >= 0 ? dataLines(packets.slice(delimIndex + 1)) : [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: Buffer[] = [];
  const head = headRef(repo);
  const headTip = repo.refs.get(head);
  if (matches('HEAD')) {
    if (headTip !== undefined) lines.push(pktLine(`${headTip} HEAD${symrefs ? ` symref-target:${head}` : ''}\n`));
    else if (unborn) lines.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:${head}` : ''}\n`));
  }
  for (const [name, oid] of forge.sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peel) {
      const object = repo.objects.get(oid);
      if (object !== undefined && object.type === 'tag') {
        const peeled = forge.peelToCommit(repo, oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    lines.push(pktLine(`${line}\n`));
  }
  return { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat([...lines, PKT_FLUSH]) };
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  done: boolean;
}

function parseFetchArgs(lines: readonly string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: null, done: false };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const value = Number.parseInt(line.slice(7).trim(), 10);
      if (Number.isFinite(value) && value > 0) args.depth = value;
    } else if (line === 'done') args.done = true;
  }
  return args;
}

/** Side-band 1 packets carrying `pack`, chunked to the pkt-line maximum. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(offset, offset + CHUNK)])));
  }
  return packets;
}

/** The fetch answer's sections for one parsed request, in the v2 framing. */
function buildFetchV2(forge: Forge, repo: RepoRec, args: FetchArgs): { result: HttpResult; complete: boolean } {
  const selection = forge.fetchSelection(repo, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  const common = args.haves.filter((have, index) => repo.objects.has(have) && args.haves.indexOf(have) === index);
  parts.push(pktLine('acknowledgments\n'));
  if (selection.objects.length === 0) {
    if (common.length > 0) for (const have of common) parts.push(pktLine(`ACK ${have}\n`));
    else parts.push(pktLine('NAK\n'));
    parts.push(PKT_FLUSH);
    return {
      result: { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) },
      complete: selection.complete,
    };
  }
  if (common.length > 0) for (const have of common) parts.push(pktLine(`ACK ${have}\n`));
  else parts.push(pktLine('NAK\n'));
  parts.push(pktLine('ready\n'));
  parts.push(PKT_DELIM);
  if (args.depth !== null || args.shallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(writePack(selection.objects)));
  parts.push(PKT_FLUSH);
  return {
    result: { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) },
    complete: selection.complete,
  };
}

/** The fetch answer in the v0 framing: shallow lines, NAK, then the side-band pack. */
function buildFetchV0(forge: Forge, repo: RepoRec, args: FetchArgs): { result: HttpResult; complete: boolean } {
  const selection = forge.fetchSelection(repo, args.wants, args.haves, args.shallow, args.depth);
  const parts: Buffer[] = [];
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(pktLine('NAK\n'));
  if (selection.objects.length > 0) parts.push(...sidebandPackets(writePack(selection.objects)));
  parts.push(PKT_FLUSH);
  return {
    result: { status: 200, contentType: 'application/x-git-upload-pack-result', body: Buffer.concat(parts) },
    complete: selection.complete,
  };
}

/**
 * The cache key of a fetch answer: the framing plus the fetch's inputs, in order.
 * Object ids are hex and carry no separator, so a plain join names the same tuple
 * JSON.stringify did, without building the intermediate arrays and string escapes.
 */
function fetchCacheKey(args: FetchArgs, framing: string): string {
  return `${framing}|${args.wants.join(',')}|${args.haves.join(',')}|${args.shallow.join(',')}|${args.depth}`;
}

/**
 * A fetch answer from the repository's cache when one was stored for these exact inputs,
 * else built fresh and stored when the selection was complete and every want and have is
 * present in the store: with all inputs present, the objects a fetch sends are immutable,
 * so the same fetch always answers the same bytes. An incomplete selection, or a fetch
 * naming an object the store does not have, is never stored — its answer may change when
 * the object arrives. The bench's 50 concurrent depth-1 clones of one tip are one
 * computation and 49 cache hits.
 */
function fetchCached(
  forge: Forge,
  repo: RepoRec,
  args: FetchArgs,
  framing: string,
  build: () => { result: HttpResult; complete: boolean },
): HttpResult {
  const key = fetchCacheKey(args, framing);
  const cached = repo.fetchCache.get(key);
  if (cached !== undefined) {
    return { status: 200, contentType: 'application/x-git-upload-pack-result', body: cached };
  }
  const built = build();
  const inputsPresent = [...args.wants, ...args.haves].every((oid) => repo.objects.has(oid));
  if (built.complete && inputsPresent) repo.fetchCache.set(key, built.result.body);
  return built.result;
}

/** A v2 fetch, cached. */
function fetchV2(forge: Forge, repo: RepoRec, args: FetchArgs): HttpResult {
  return fetchCached(forge, repo, args, 'v2', () => buildFetchV2(forge, repo, args));
}

/** A v0 fetch, cached. */
function fetchV0(forge: Forge, repo: RepoRec, args: FetchArgs): HttpResult {
  return fetchCached(forge, repo, args, 'v0', () => buildFetchV0(forge, repo, args));
}

function uploadPack(forge: Forge, repo: RepoRec, body: Buffer): HttpResult {
  const split = splitPktStream(body);
  if (split === null || split.packets.length === 0) return json(400, { message: 'Invalid upload-pack request' });
  const first = split.packets[0];
  const firstText = first !== undefined && first.kind === 'data' ? first.payload.toString('utf8') : '';
  if (firstText.startsWith('command=ls-refs')) return lsRefs(forge, repo, split.packets);
  if (firstText.startsWith('command=fetch')) {
    const delimIndex = split.packets.findIndex((packet) => packet.kind === 'delim');
    const argLines = delimIndex >= 0 ? dataLines(split.packets.slice(delimIndex + 1)) : dataLines(split.packets.slice(1));
    return fetchV2(forge, repo, parseFetchArgs(argLines));
  }
  // Protocol v0: want lines up to the first flush, then have lines up to the second.
  const lines: string[] = [];
  for (const packet of split.packets) {
    if (packet.kind === 'data') {
      let text = packet.payload.toString('utf8').replace(/\n$/, '');
      const nul = text.indexOf('\0');
      if (nul >= 0) text = text.slice(0, nul);
      lines.push(text);
    }
  }
  return fetchV0(forge, repo, parseFetchArgs(lines));
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
  capabilities: string[];
}

function receivePack(forge: Forge, repo: RepoRec, body: Buffer): HttpResult {
  const split = splitPktStream(body);
  if (split === null) return json(400, { message: 'Invalid receive-pack request' });
  const commands: PushCommand[] = [];
  let capabilities: string[] = [];
  for (const packet of split.packets) {
    if (packet.kind !== 'data') continue;
    let text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    if (nul >= 0) {
      capabilities = text.slice(nul + 1).split(' ').filter((cap) => cap !== '');
      text = text.slice(0, nul);
    }
    const parts = text.split(' ');
    if (parts.length === 3 && parts[2] !== undefined && parts[2].startsWith('refs/')) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2], capabilities });
    }
  }
  const sideband = capabilities.includes('side-band-64k');
  const reportStatus = capabilities.includes('report-status') || capabilities.includes('report-status-v2');

  let unpackOk = true;
  let unpackDetail = '';
  if (split.rest.length > 0) {
    try {
      const pack = readPack(split.rest, 0, (oid) => repo.objects.get(oid));
      if (!pack.checksumOk) throw new Error('pack checksum mismatch');
      for (const [oid, object] of pack.objects) repo.objects.set(oid, object);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    const fail = (reason: string): void => {
      results.push({ ref: command.ref, ok: false, reason });
    };
    if (!unpackOk) {
      fail('unpack failed');
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.newOid === ZERO_OID) {
      // A delete.
      if (current === ZERO_OID) fail('reference does not exist');
      else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (!repo.objects.has(command.newOid)) {
      fail('missing object');
      continue;
    }
    if (current !== ZERO_OID) {
      if (command.oldOid !== current) {
        fail('stale info');
        continue;
      }
      if (!forge.isAncestor(repo, current, command.newOid)) {
        fail('non-fast-forward');
        continue;
      }
    } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
      fail('stale info');
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    results.push({ ref: command.ref, ok: true, reason: '' });
  }

  if (!reportStatus) {
    return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.alloc(0) };
  }
  const inner: Buffer[] = [];
  inner.push(pktLine(unpackOk ? 'unpack ok\n' : `unpack error ${unpackDetail}\n`));
  for (const result of results) {
    inner.push(pktLine(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  inner.push(PKT_FLUSH);
  const innerBytes = Buffer.concat(inner);
  const outer: Buffer[] = [];
  if (sideband) outer.push(...sidebandPackets(innerBytes));
  else outer.push(innerBytes);
  outer.push(PKT_FLUSH);
  return { status: 200, contentType: 'application/x-git-receive-pack-result', body: Buffer.concat(outer) };
}

/** Route one git smart-HTTP request. `tail` is 'info/refs', 'git-upload-pack' or 'git-receive-pack'. */
export function handleGit(
  forge: Forge,
  owner: string,
  repoName: string,
  tail: string,
  req: IncomingMessage,
  body: Buffer,
  query: URLSearchParams,
): HttpResult {
  const repo = forge.repoFor(owner, repoName);
  if (repo === null) return notFound();
  if (tail === 'info/refs') {
    const service = query.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return notFound();
    if ((req.method ?? 'GET') !== 'GET') return notFound();
    const protocol = req.headers['git-protocol'];
    return infoRefs(forge, repo, service, typeof protocol === 'string' ? protocol : undefined);
  }
  if (tail === 'git-upload-pack') {
    if ((req.method ?? 'POST') !== 'POST') return notFound();
    return uploadPack(forge, repo, body);
  }
  if (tail === 'git-receive-pack') {
    if ((req.method ?? 'POST') !== 'POST') return notFound();
    return receivePack(forge, repo, body);
  }
  return notFound();
}

/** Write an HttpResult to the response. */
export function sendResult(res: ServerResponse, result: HttpResult): void {
  const extra = result.headers;
  if (extra === undefined || Object.keys(extra).length === 0) {
    res.writeHead(result.status, {
      'content-type': result.contentType,
      'content-length': result.body.length,
    });
  } else {
    const headers: Record<string, string | number> = {
      'content-type': result.contentType,
      'content-length': result.body.length,
    };
    for (const name of Object.keys(extra)) headers[name] = extra[name] as string;
    res.writeHead(result.status, headers);
  }
  res.end(result.body);
}
