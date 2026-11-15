// main.ts — the forge entry's lifecycle: everything in this file exists to
// walk the process through its handshake with the harness env, and nothing
// else. app.ts builds the server that gets scored; this file starts it,
// introduces it to the env, and keeps the process alive until the env
// declares the trial finished.
//
// The handshake, step by step:
//
//   - The env's origin is handed over in the MAKEFUN_ENV_URL variable. No
//     variable, no env — there is nobody to register with, so the process
//     refuses to start at all.
//   - The server binds port 0 and lets the kernel choose a free port. Port
//     8080 is never requested: that one belongs to the env.
//   - The chosen port is announced with POST /register and a {"port": N}
//     body. The env notes the address the request arrived from together
//     with N and dials that combination from then on. Only the first
//     announcement counts; a repeat is answered 409, which is a perfectly
//     good outcome for this process.
//   - GET /done is polled until its JSON body carries done: true. The env
//     answers every poll immediately ({"done": false} while its suite is
//     still running), so polling — never a held-open request — is the only
//     way to wait, and leaving before done is not an option.
//   - Once done arrives, the server closes and the process exits 0.
//
// Both requests ride out an env that is still starting: each one gets a
// long timeout, and failures are retried behind a wait that doubles until
// it reaches a ceiling.

import { createApp } from "./app.ts";

const envOrigin = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");

if (envOrigin === "") {
  process.stderr.write("MAKEFUN_ENV_URL is not set: no env to register with\n");
  process.exit(1);
}

/** One register or poll request may take this long before it counts as failed. */
const REQUEST_LIMIT_MS = 30_000;
/** The wait after the first failure, and the ceiling the doubling stops at. */
const FIRST_WAIT_MS = 250;
const LONGEST_WAIT_MS = 2_000;

const pause = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** How long to wait after `failures` failures in a row: doubling, capped. */
function waitAfter(failures: number): number {
  return Math.min(LONGEST_WAIT_MS, FIRST_WAIT_MS * 2 ** failures);
}

/** Register answers that mean the announcement landed: 200, or 409 when one already did. */
const REGISTER_ACCEPTED: ReadonlySet<number> = new Set([200, 409]);
/** Register answers that mean the request itself is wrong: retrying could never help. */
const REGISTER_FATAL: ReadonlySet<number> = new Set([400, 405]);

/**
 * Announce the bound port to the env, retrying while it is not ready to
 * hear it. Network trouble and unexpected statuses are waited out; a fatal
 * status throws, because the env has rejected the request on its merits.
 */
async function announcePort(port: number): Promise<void> {
  let failures = 0;
  for (;;) {
    let status = -1;
    try {
      const reply = await fetch(envOrigin + "/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port: port }),
        signal: AbortSignal.timeout(REQUEST_LIMIT_MS),
      });
      status = reply.status;
    } catch {
      status = -1; // no answer at all: the env is probably still coming up
    }
    if (REGISTER_ACCEPTED.has(status)) return;
    if (REGISTER_FATAL.has(status)) {
      throw new Error("the env rejected the register request, HTTP " + status);
    }
    await pause(waitAfter(failures));
    failures += 1;
  }
}

/**
 * Poll the env's /done until it reports the trial over. Every answer that
 * is not a clear {"done": true} — a false, a failure, a garbled body —
 * simply means "not yet", and the polling continues behind the same
 * growing wait the register loop uses.
 */
async function pollUntilDone(): Promise<void> {
  let failures = 0;
  for (;;) {
    try {
      const reply = await fetch(envOrigin + "/done", {
        signal: AbortSignal.timeout(REQUEST_LIMIT_MS),
      });
      if (reply.ok) {
        const body = (await reply.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env did not answer cleanly; that is not the same as done.
    }
    await pause(waitAfter(failures));
    failures += 1;
  }
}

/** The process's whole life: bind, announce, wait for done, close, finish. */
async function runLifecycle(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (bound === null || typeof bound !== "object") {
    throw new Error("the server bound no TCP port to announce");
  }
  process.stdout.write("forge listening on port " + bound.port + "\n");

  await announcePort(bound.port);
  process.stdout.write("registered; waiting for the env to say done\n");

  await pollUntilDone();
  server.close();
  process.stdout.write("the env says done; exiting\n");
}

runLifecycle().then(
  () => {
    process.exit(0);
  },
  (err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write("entry failed: " + detail + "\n");
    process.exit(1);
  },
);
