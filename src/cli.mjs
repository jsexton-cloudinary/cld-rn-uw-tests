#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import dc from 'node:diagnostics_channel';
import { randomUUID } from 'node:crypto';
import { fetch, FormData, Agent, setGlobalDispatcher } from 'undici';
import { openAsBlob } from 'node:fs';

// Node 20+ has global fetch, FormData, Blob, performance
const required = '24.11.0';
const [majReq, minReq] = required.split('.').map(Number);
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < majReq || (maj === majReq && min < minReq)) {
  console.error(
    `Node ${required}+ required. You are on ${process.versions.node}. Run "nvm use" or "nvm install".`
  );
  process.exit(1);
}

// ---------- __dirname in ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------- Arg parsing & usage
function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      const key = tok.replace(/^--/, '');
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        args[key] = true;
      } else {
        args[key] = next;
        i++;
      }
    }
  }
  return args;
}

function usage() {
  console.log(`
Usage:
  node src/cli.mjs --cloud-name <name> --upload-preset <preset> --asset-folder <asset-folder>
                   [--batches 5] [--delay-ms 10000] [--concurrency 6] [--keepalive true]
                   [--timeout-ms 0] [--resource-type image] [--dry]

Required:
  --cloud-name       Your Cloudinary cloud name. Example: rn-cld-tests
  --upload-preset    Unsigned upload preset name. Example: photos_menus
  --asset-folder     Target asset-folder for all uploads. Example: cloudinary-tests

Optional:
  --batches          Number of batches to run (default 5)
  --delay-ms         Delay between batches in ms (default 10000)
  --concurrency      Max simultaneous uploads per batch (default 6; Chrome-ish for HTTP/1.1)
  --keepalive        Reuse TCP connections (true|false, default true)
  --timeout-ms       Per-request timeout in ms (0 = no timeout; default 0)
  --resource-type    Cloudinary resource type: image|video|raw (default image)
  --dry              Preflight only: validates files and prints sizes. No uploads.
`);
}

// ---------- Utilities
function nowStamp() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(
    d.getHours()
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

async function ensureDirs() {
  const outDir = path.resolve(__dirname, '..', 'out');
  const filesDir = path.resolve(__dirname, '..', 'files');
  const capsDir = path.resolve(__dirname, '..', 'captures');
  await fs.mkdir(outDir, { recursive: true });
  await fs.mkdir(filesDir, { recursive: true });
  await fs.mkdir(capsDir, { recursive: true });
  return { outDir, filesDir, capsDir };
}

function delay(ms) {
  return new Promise((res) => setTimeout(res, ms));
}
function baseNameNoExt(p) {
  const b = path.basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(0, i) : b;
}
function humanBytes(n) {
  const kb = 1024,
    mb = kb * 1024;
  if (n >= mb) return `${(n / mb).toFixed(2)}mb`;
  if (n >= kb) return `${(n / kb).toFixed(2)}kb`;
  return `${n}b`;
}
function mbps(bytes, ms) {
  if (!ms || ms <= 0) return 0;
  return (bytes * 8) / (ms / 1000) / 1e6;
}
function shuffle(a) {
  const b = a.slice();
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
}

// ---------- Read exactly 5 files (smallest five), as in your original
async function readFiveFiles(filesDir) {
  const entries = await fs.readdir(filesDir);
  const files = [];
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const p = path.join(filesDir, name);
    const st = await fs.stat(p).catch(() => null);
    if (st && st.isFile()) {
      await fs.access(p).catch(() => {
        throw new Error(`Not readable: ${p}`);
      });
      files.push({ path: p, size: st.size, name });
    }
  }
  if (files.length < 5)
    throw new Error(
      `Expected at least 5 files in ${filesDir}. Found ${files.length}.`
    );
  files.sort((a, b) => a.size - b.size);
  const selected = files.slice(0, 5);

  // Validate all 5 files have different sizes (important for per-size stats)
  const sizes = new Set(selected.map((f) => f.size));
  if (sizes.size !== 5) {
    console.warn(
      'Warning: Not all 5 files have unique sizes. Per-size statistics may be less meaningful.'
    );
  }

  return selected;
}

// ---------- Diagnostics (DevTools-like phases via Undici channels)
const reqMap = new Map(); // traceId -> record
const lastConnectByOrigin = new Map(); // origin -> last connect info

const now = () => performance.now();
function headerLookup(headers, name) {
  if (!Array.isArray(headers)) return null;
  const lower = name.toLowerCase();
  for (let i = 0; i < headers.length; i += 2) {
    if (String(headers[i]).toLowerCase() === lower)
      return String(headers[i + 1]);
  }
  return null;
}

// Connection established (TCP/TLS). Associate by origin.
dc.subscribe('undici:client:connected', ({ socket, connectParams }) => {
  const origin =
    connectParams?.origin ??
    `${connectParams?.protocol}//${connectParams?.host}:${
      connectParams?.port || 443
    }`;
  lastConnectByOrigin.set(origin, {
    t: now(),
    remote: socket?.remoteAddress ?? null,
    alpn: socket?.alpnProtocol ?? null,
    tls: socket?.getProtocol ? socket.getProtocol() : null,
    cipher: socket?.getCipher ? socket.getCipher()?.name : null,
  });
});

// Request lifecycle
dc.subscribe('undici:request:create', ({ request }) => {
  const traceId = headerLookup(request.headers, 'x-trace-id');
  if (!traceId) return;
  reqMap.set(traceId, { origin: request.origin, createdAt: now() });
});

dc.subscribe('undici:client:sendHeaders', ({ request }) => {
  const traceId = headerLookup(request.headers, 'x-trace-id');
  const rec = traceId && reqMap.get(traceId);
  if (!rec) return;
  rec.sendHeadersAt = now();
  const conn = lastConnectByOrigin.get(request.origin);
  if (conn)
    Object.assign(rec, {
      connectAt: conn.t,
      remote: conn.remote,
      alpn: conn.alpn,
      tls: conn.tls,
      cipher: conn.cipher,
    });
});

dc.subscribe('undici:request:bodySent', ({ request }) => {
  const traceId = headerLookup(request.headers, 'x-trace-id');
  const rec = traceId && reqMap.get(traceId);
  if (rec) rec.bodySentAt = now();
});

dc.subscribe('undici:request:headers', ({ request }) => {
  const traceId = headerLookup(request.headers, 'x-trace-id');
  const rec = traceId && reqMap.get(traceId);
  if (rec) rec.headersAt = now(); // TTFB
});

dc.subscribe('undici:request:trailers', ({ request }) => {
  const traceId = headerLookup(request.headers, 'x-trace-id');
  const rec = traceId && reqMap.get(traceId);
  if (rec) rec.doneAt = now(); // download complete
});

function newTraceId() {
  return randomUUID();
}
function collectTimings(traceId) {
  const r = reqMap.get(traceId);
  if (!r) return null;
  const timings = {
    queueMs:
      r.sendHeadersAt && r.createdAt
        ? Math.round(r.sendHeadersAt - r.createdAt)
        : null,
    uploadMs:
      r.bodySentAt && r.sendHeadersAt
        ? Math.round(r.bodySentAt - r.sendHeadersAt)
        : null,
    ttfbMs:
      r.headersAt && r.bodySentAt
        ? Math.round(r.headersAt - r.bodySentAt)
        : null,
    downloadMs:
      r.doneAt && r.headersAt ? Math.round(r.doneAt - r.headersAt) : null,
    connectMs:
      r.connectAt && r.sendHeadersAt
        ? Math.round(r.sendHeadersAt - r.connectAt)
        : null,
    remoteIp: r.remote ?? null,
    alpn: r.alpn ?? null,
    tlsProtocol: r.tls ?? null,
    tlsCipher: r.cipher ?? null,
  };
  reqMap.delete(traceId);
  return timings;
}

// ---------- Promise pool for controlled concurrency
async function mapPool(items, limit, fn) {
  if (!Number.isFinite(limit) || limit < 1) limit = items.length;
  const ret = new Array(items.length);
  let i = 0,
    inFlight = 0,
    resolveAll;
  const done = new Promise((res) => {
    resolveAll = res;
  });
  const next = () => {
    if (i >= items.length && inFlight === 0) return resolveAll();
    while (inFlight < limit && i < items.length) {
      const idx = i++;
      inFlight++;
      Promise.resolve(fn(items[idx], idx))
        .then(
          (v) => {
            ret[idx] = v;
          },
          (e) => {
            ret[idx] = Promise.reject(e);
          }
        )
        .finally(() => {
          inFlight--;
          next();
        });
    }
  };
  next();
  await done;
  return ret;
}

// ---------- Upload
async function uploadUnsigned({
  cloudName,
  uploadPreset,
  assetFolder,
  filePath,
  publicId,
  signal,
  resourceType = 'image',
  timeoutMs = 0,
  extraHeaders = {},
}) {
  const url = `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`;
  const blob = await openAsBlob(filePath);
  const fd = new FormData();
  fd.set('file', blob, path.basename(filePath));
  fd.set('upload_preset', uploadPreset);
  fd.set('asset_folder', assetFolder);
  fd.set('public_id', publicId);

  const traceId = newTraceId();
  const controller = new AbortController();
  let timer = null;

  // If external signal provided, listen to it and clear our timer
  if (signal) {
    signal.addEventListener('abort', () => {
      if (timer) clearTimeout(timer);
    });
  }

  if (timeoutMs > 0) {
    timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  }

  const t0 = performance.now();
  let resp;
  try {
    resp = await fetch(url, {
      method: 'POST',
      body: fd,
      signal: signal ?? controller.signal,
      headers: {
        'x-trace-id': traceId,
        'x-cld-upload-source': 'browserish-script',
        ...extraHeaders,
      },
    });
  } catch (e) {
    if (timer) clearTimeout(timer);
    // Extract the actual underlying error (often nested in e.cause)
    const root = e.cause || e;
    const enhanced = new Error(`Fetch failed: ${e.message}`);
    enhanced.cause = e;
    enhanced.code = root.code || e.code;
    enhanced.errno = root.errno || e.errno;
    enhanced.syscall = root.syscall || e.syscall;
    enhanced.address = root.address || e.address;
    enhanced.port = root.port || e.port;
    throw enhanced;
  }
  if (timer) clearTimeout(timer);
  const t1 = performance.now();

  const reqId = resp.headers.get('x-request-id') || null;
  const cldErrHeader = resp.headers.get('x-cld-error') || null;

  let data = null;
  try {
    data = await resp.json();
  } catch (e) {
    data = { parse_error: String(e) };
  }

  const phases = collectTimings(traceId);

  return {
    ok: resp.ok,
    status: resp.status,
    durationMs: Math.round(t1 - t0),
    requestId: reqId,
    cldErrorHeader: cldErrHeader,
    timings: phases,
    data,
  };
}

async function writeLogLine(logPath, record) {
  const line = JSON.stringify(record) + '\n';
  await fs.appendFile(logPath, line, 'utf8');
}

// ---------- Stats helpers
function summarize(arr) {
  const n = arr.length;
  if (!n)
    return { count: 0, avg: null, p50: null, p95: null, min: null, max: null };
  const s = arr.slice().sort((a, b) => a - b);
  const avg = s.reduce((a, b) => a + b, 0) / n;

  // Percentile calculation with linear interpolation
  const percentile = (p) => {
    const pos = (p / 100) * (n - 1);
    const base = Math.floor(pos);
    const rest = pos - base;
    if (s[base + 1] !== undefined) {
      return Math.round(s[base] + rest * (s[base + 1] - s[base]));
    }
    return s[base];
  };

  return {
    count: n,
    avg: +avg.toFixed(2),
    p50: percentile(50),
    p95: percentile(95),
    min: s[0],
    max: s[n - 1],
  };
}

function cleanupOrphanedTraces() {
  // Remove trace records older than 5 minutes to prevent memory leaks
  const cutoff = now() - 300_000; // 5 minutes
  for (const [traceId, rec] of reqMap.entries()) {
    if (rec.createdAt < cutoff) {
      reqMap.delete(traceId);
    }
  }
}

// ---------- Main
async function main() {
  const args = parseArgs(process.argv);
  if (args.help || Object.keys(args).length === 0) {
    usage();
    process.exit(0);
  }

  const cloudName = args['cloud-name'];
  const uploadPreset = args['upload-preset'];
  const assetFolder = args['asset-folder'];
  const resourceType = String(args['resource-type'] ?? 'image');
  const batches = Number(args['batches'] ?? 5);
  const delayMs = Number(args['delay-ms'] ?? 10000);
  const dry = Boolean(args['dry']);
  const concurrency = Number(args['concurrency'] ?? 6); // Chrome-ish HTTP/1.1 limit per host
  const keepAlive = args['keepalive'] === 'false' ? false : true;
  const timeoutMs = Number(args['timeout-ms'] ?? 0);

  if (!cloudName || !uploadPreset || !assetFolder) {
    console.error('Missing required args.');
    usage();
    process.exit(1);
  }

  // Browser-ish connection behavior (HTTP/1.1): keep-alive with ~6 concurrent sockets/origin
  // Note: undici requires pipelining: 0 when using connection pooling
  const agent = new Agent({
    connections: concurrency,
    pipelining: 0,
    keepAliveTimeout: keepAlive ? 60_000 : undefined,
    keepAliveMaxTimeout: keepAlive ? 90_000 : undefined,
  });
  setGlobalDispatcher(agent);

  const { outDir, filesDir } = await ensureDirs();
  const runId = nowStamp();
  const logPath = path.join(outDir, `run-${runId}.ndjson`);
  const summaryPath = path.join(outDir, `run-${runId}-summary.json`);
  const files = await readFiveFiles(filesDir);

  // Header
  console.log(`Run ${runId}`);
  console.log(`Cloud: ${cloudName}`);
  console.log(`Preset: ${uploadPreset}`);
  console.log(`Asset Folder: ${assetFolder}`);
  console.log(`Resource Type: ${resourceType}`);
  console.log(`Batches: ${batches}  Delay: ${delayMs} ms  Dry: ${dry}`);
  console.log(
    `Concurrency: ${concurrency}  KeepAlive: ${keepAlive}  Timeout: ${timeoutMs} ms`
  );
  console.log(
    `Node: ${process.version}  OS: ${process.platform} ${process.arch}`
  );
  console.log(
    `Env proxies: HTTP_PROXY=${process.env.HTTP_PROXY ?? 'n/a'} HTTPS_PROXY=${
      process.env.HTTPS_PROXY ?? 'n/a'
    } NO_PROXY=${process.env.NO_PROXY ?? 'n/a'}`
  );
  console.log(`Files:`);
  files.forEach((f) => console.log(`  ${f.name}  ${humanBytes(f.size)}`));
  console.log(`Log: ${logPath}`);

  await writeLogLine(logPath, {
    ts: new Date().toISOString(),
    runId,
    event: 'start',
    cloudName,
    uploadPreset,
    assetFolder,
    resourceType,
    batches,
    delayMs,
    dry,
    concurrency,
    keepAlive,
    timeoutMs,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  });

  if (dry) process.exit(0);

  // Stats collectors
  const perFile = new Map(); // name -> { size, ok, fail, durations[], uploadMs[], ttfbMs[], connectMs[] }
  const alpnSet = new Set();
  const remoteIps = new Set();
  const exceptions = []; // Track exceptions separately

  function pushStats(map, key, size, rec) {
    if (!map.has(key))
      map.set(key, {
        size,
        ok: 0,
        fail: 0,
        durations: [],
        uploadMs: [],
        ttfbMs: [],
        connectMs: [],
      });
    const s = map.get(key);
    if (rec.ok) s.ok++;
    else s.fail++;
    // Only push finite values to avoid skewing statistics
    if (Number.isFinite(rec.durationMs)) s.durations.push(rec.durationMs);
    const t = rec.timings || {};
    if (Number.isFinite(t.uploadMs)) s.uploadMs.push(t.uploadMs);
    if (Number.isFinite(t.ttfbMs)) s.ttfbMs.push(t.ttfbMs);
    if (Number.isFinite(t.connectMs)) s.connectMs.push(t.connectMs);
    // Collect connection info globally (not per-upload since it's shared)
    if (t.alpn) alpnSet.add(t.alpn);
    if (t.remoteIp) remoteIps.add(t.remoteIp);
  }

  let totalOk = 0;
  let totalTried = 0;

  for (let b = 0; b < batches; b++) {
    const batchNo = b + 1;
    console.log(`Starting batch ${batchNo}/${batches}`);

    // Shuffle file order per batch to avoid systematic warm-connection bias
    const batchFiles = shuffle(files);

    const results = await mapPool(batchFiles, concurrency, async (f) => {
      const publicId = `${baseNameNoExt(f.name)}-b${String(batchNo).padStart(
        2,
        '0'
      )}-${runId}`;
      try {
        const result = await uploadUnsigned({
          cloudName,
          uploadPreset,
          assetFolder,
          filePath: f.path,
          publicId,
          resourceType,
          timeoutMs,
        });

        const speed = mbps(
          f.size,
          result.timings?.uploadMs ?? result.durationMs
        );
        if (result.ok) {
          console.log(
            `OK   ${f.name} ${humanBytes(f.size)} ${speed.toFixed(
              2
            )} Mb/s http=${result.status} req=${result.requestId ?? 'n/a'}`
          );
        } else {
          const msg =
            result.data?.error?.message ?? result.cldErrorHeader ?? 'unknown';
          console.error(
            `ERR  ${f.name} http=${result.status} req=${
              result.requestId ?? 'n/a'
            } x-cld-error=${result.cldErrorHeader ?? 'n/a'} msg=${msg}`
          );
        }

        const record = {
          ts: new Date().toISOString(),
          runId,
          batch: batchNo,
          file: f.name,
          path: f.path,
          size: f.size,
          publicId,
          status: result.ok ? 'ok' : 'error',
          httpStatus: result.status,
          durationMs: result.durationMs,
          requestId: result.requestId,
          cldErrorHeader: result.cldErrorHeader,
          timings: result.timings,
          mbpsUpload: Number.isFinite(speed) ? Number(speed.toFixed(2)) : null,
          cld: result.data,
        };
        await writeLogLine(logPath, record);

        // stats
        pushStats(perFile, f.name, f.size, {
          ok: result.ok,
          durationMs: result.durationMs,
          timings: result.timings,
        });

        return { ok: result.ok };
      } catch (err) {
        const errDetails = {
          message: err.message || String(err),
          code: err.code,
          errno: err.errno,
          syscall: err.syscall,
          address: err.address,
          port: err.port,
          cause: err.cause?.message,
          stack: err.stack?.split('\n').slice(0, 3).join(' | '), // First 3 lines of stack
        };
        console.error(
          `ERR  ${f.name} exception=${errDetails.message} code=${
            errDetails.code || 'n/a'
          } syscall=${errDetails.syscall || 'n/a'} address=${
            errDetails.address || 'n/a'
          }`
        );
        exceptions.push({
          batch: batchNo,
          file: f.name,
          error: String(err),
          ...errDetails,
        });
        await writeLogLine(logPath, {
          ts: new Date().toISOString(),
          runId,
          batch: batchNo,
          file: f.name,
          path: f.path,
          size: f.size,
          publicId,
          status: 'exception',
          error: String(err),
          errorDetails: errDetails,
        });
        // Don't push NaN values - just count the failure
        pushStats(perFile, f.name, f.size, { ok: false, timings: {} });
        return { ok: false };
      }
    });

    const okCount = results.filter((r) => r.ok).length;
    totalOk += okCount;
    totalTried += results.length;
    console.log(
      `Batch ${batchNo} complete: ${okCount}/${results.length} succeeded.`
    );

    // Cleanup orphaned trace records to prevent memory leaks
    cleanupOrphanedTraces();

    if (b < batches - 1 && delayMs > 0) await delay(delayMs);
  }

  await writeLogLine(logPath, {
    ts: new Date().toISOString(),
    runId,
    event: 'end',
    totalOk,
    totalTried,
  });

  // ---------- Final summary (console + JSON file)
  function summarizeGroup(map) {
    const out = [];
    for (const [k, v] of map.entries()) {
      out.push({
        key: k,
        size: v.size,
        ok: v.ok,
        fail: v.fail,
        duration: summarize(v.durations.filter(Number.isFinite)),
        upload: summarize(v.uploadMs.filter(Number.isFinite)),
        ttfb: summarize(v.ttfbMs.filter(Number.isFinite)),
        connect: summarize(v.connectMs.filter(Number.isFinite)),
      });
    }
    // Sort by size ascending if sizes available, else by key
    out.sort((a, b) => (a.size ?? 0) - (b.size ?? 0));
    return out;
  }

  const perFileSummary = summarizeGroup(perFile);

  // Build overall stats from raw collections
  const allD = [];
  const allU = [];
  const allT = [];
  const allC = [];
  for (const v of perFile.values()) {
    allD.push(...v.durations.filter(Number.isFinite));
    allU.push(...v.uploadMs.filter(Number.isFinite));
    allT.push(...v.ttfbMs.filter(Number.isFinite));
    allC.push(...v.connectMs.filter(Number.isFinite));
  }
  const overall = {
    totals: {
      tried: totalTried,
      ok: totalOk,
      fail: totalTried - totalOk,
      exceptions: exceptions.length,
    },
    duration: summarize(allD),
    upload: summarize(allU),
    ttfb: summarize(allT),
    connect: summarize(allC),
    distinctRemoteIPs: [...remoteIps],
    alpnSeen: [...alpnSet],
    exceptionDetails: exceptions,
  };

  // Print concise console summary
  console.log('\n=== Overall ===');
  console.log(
    `Tried: ${overall.totals.tried}  OK: ${overall.totals.ok}  Fail: ${overall.totals.fail}  Exceptions: ${overall.totals.exceptions}`
  );
  console.log(
    `Duration ms: avg=${overall.duration.avg} p50=${overall.duration.p50} p95=${overall.duration.p95} min=${overall.duration.min} max=${overall.duration.max}`
  );
  console.log(
    `Upload   ms: avg=${overall.upload.avg}   p50=${overall.upload.p50}   p95=${overall.upload.p95}   min=${overall.upload.min}   max=${overall.upload.max}`
  );
  console.log(
    `TTFB     ms: avg=${overall.ttfb.avg}     p50=${overall.ttfb.p50}     p95=${overall.ttfb.p95}     min=${overall.ttfb.min}     max=${overall.ttfb.max}`
  );
  console.log(
    `Connect  ms: avg=${overall.connect.avg}  p50=${overall.connect.p50}  p95=${overall.connect.p95}  min=${overall.connect.min}  max=${overall.connect.max}`
  );
  console.log(
    `ALPN seen: ${overall.alpnSeen.join(', ') || 'n/a'}  Remote IPs: ${
      overall.distinctRemoteIPs.join(', ') || 'n/a'
    }`
  );
  if (exceptions.length > 0) {
    console.log(`\nExceptions encountered:`);
    exceptions.forEach((e) =>
      console.log(`  Batch ${e.batch}, ${e.file}: ${e.error}`)
    );
  }

  console.log('\n=== Per File ===');
  for (const s of perFileSummary) {
    console.log(
      `${s.key} (${humanBytes(s.size)}): ok=${s.ok} fail=${s.fail}` +
        ` | dur avg=${s.duration.avg} p50=${s.duration.p50} p95=${s.duration.p95}` +
        ` | up p50=${s.upload.p50} p95=${s.upload.p95} | ttfb p50=${s.ttfb.p50} p95=${s.ttfb.p95}`
    );
  }

  const summary = {
    runId,
    cloudName,
    uploadPreset,
    assetFolder,
    resourceType,
    concurrency,
    keepAlive,
    timeoutMs,
    perFile: perFileSummary,
    overall,
  };
  await fs.writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
  console.log(`\nSummary written: ${path.basename(summaryPath)}`);

  // Final note
  if (totalOk === totalTried) {
    console.log('All done.');
  } else {
    console.log('All done.');
    console.error(
      `Note: ${
        totalTried - totalOk
      } of ${totalTried} uploads failed. See log for details: ${path.basename(
        logPath
      )}`
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
