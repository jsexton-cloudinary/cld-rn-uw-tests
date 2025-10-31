#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// Node 20+ has global fetch, FormData, Blob, performance
const required = '24.11.0';
const [majReq, minReq] = required.split('.').map(Number);
const [maj, min] = process.versions.node.split('.').map(Number);
if (maj < majReq || (maj === majReq && min < minReq)) {
  console.error(`Node ${required}+ required. You are on ${process.versions.node}. Run "nvm use" or "nvm install".`);
  process.exit(1);
}
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith('--')) {
      const key = tok.replace(/^--/, '');
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        args[key] = true; // boolean flag
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
                   [--batches 5] [--delay-ms 10000] [--dry]

Required:
  --cloud-name       Your Cloudinary cloud name. Example: rn-cld-tests
  --upload-preset    Unsigned upload preset name. Example: photos_menus
  --asset-folder     Target asset-folder for all uploads. Example: cloudinary-tests

Optional:
  --batches          Number of batches to run. Default 5
  --delay-ms         Delay between batches in milliseconds. Default 10000
  --dry              Preflight only: validates files and prints sizes. No uploads.
`);
}

function nowStamp() {
  const d = new Date();
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
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
  return new Promise(res => setTimeout(res, ms));
}

function baseNameNoExt(p) {
  const b = path.basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(0, i) : b;
}

async function readFiveFiles(filesDir) {
  const entries = await fs.readdir(filesDir);
  const files = [];
  for (const name of entries) {
    if (name.startsWith('.')) continue;
    const p = path.join(filesDir, name);
    const st = await fs.stat(p).catch(() => null);
    if (st && st.isFile()) {
      await fs.access(p).catch(() => { throw new Error(`Not readable: ${p}`); });
      files.push({ path: p, size: st.size, name });
    }
  }
  if (files.length < 5) {
    throw new Error(`Expected at least 5 files in ${filesDir}. Found ${files.length}.`);
  }
  files.sort((a, b) => a.size - b.size);
  return files.slice(0, 5);
}

function humanBytes(n) {
  const kb = 1024, mb = kb * 1024;
  if (n >= mb) return `${(n / mb).toFixed(2)}mb`;
  if (n >= kb) return `${(n / kb).toFixed(2)}kb`;
  return `${n}b`;
}

function mbps(bytes, ms) {
  if (!ms || ms <= 0) return 0;
  return ((bytes * 8) / (ms / 1000)) / 1e6;
}

async function uploadUnsigned({
  cloudName,
  uploadPreset,
  assetFolder,
  filePath,
  publicId,
  signal,
  resourceType = 'image'
}) {
  const url = `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`;

  const bytes = await fs.readFile(filePath);
  const fd = new FormData();
  const blob = new Blob([bytes]);
  fd.append('file', blob, path.basename(filePath));
  fd.append('upload_preset', uploadPreset);
  fd.append('asset_folder', assetFolder);
  fd.append('public_id', publicId);

  const t0 = performance.now();
  const resp = await fetch(url, { method: 'POST', body: fd, signal });
  const t1 = performance.now();

  const reqId = resp.headers.get('x-request-id') || null;
  const cldErrHeader = resp.headers.get('x-cld-error') || null;

  let data = null;
  try {
    data = await resp.json();
  } catch (e) {
    data = { parse_error: String(e) };
  }

  return {
    ok: resp.ok,
    status: resp.status,
    durationMs: Math.round(t1 - t0),
    requestId: reqId,
    cldErrorHeader: cldErrHeader,
    data
  };
}

async function writeLogLine(logPath, record) {
  const line = JSON.stringify(record) + '\n';
  await fs.appendFile(logPath, line, 'utf8');
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help || Object.keys(args).length === 0) {
    usage();
    process.exit(0);
  }

  const cloudName = args['cloud-name'];
  const uploadPreset = args['upload-preset'];
  const assetFolder = args['asset-folder'];
  const batches = Number(args['batches'] ?? 5);
  const delayMs = Number(args['delay-ms'] ?? 10000);
  const dry = Boolean(args['dry']);

  if (!cloudName || !uploadPreset || !assetFolder) {
    console.error('Missing required args.');
    usage();
    process.exit(1);
  }

  const { outDir, filesDir } = await ensureDirs();
  const runId = nowStamp();
  const logPath = path.join(outDir, `run-${runId}.ndjson`);
  const files = await readFiveFiles(filesDir);

  // Header (matches your preferred format, without product env line)
  console.log(`Run ${runId}`);
  console.log(`Cloud: ${cloudName}`);
  console.log(`Preset: ${uploadPreset}`);
  console.log(`Asset Folder: ${assetFolder}`);
  console.log(`Batches: ${batches}  Delay: ${delayMs} ms  Dry: ${dry}`);
  console.log(`Files:`);
  files.forEach(f => console.log(`  ${f.name}  ${humanBytes(f.size)}`));
  console.log(`Log: ${logPath}`);

  await writeLogLine(logPath, { ts: new Date().toISOString(), runId, event: 'start', cloudName, uploadPreset, assetFolder, batches, delayMs, dry });

  // Dry = preflight only
  if (dry) {
    process.exit(0);
  }

  let totalOk = 0;
  let totalTried = 0;

  for (let b = 0; b < batches; b++) {
    const batchNo = b + 1;
    console.log(`Starting batch ${batchNo}/${batches}`);

    const results = await Promise.all(
      files.map(async (f) => {
        const publicId = `${baseNameNoExt(f.name)}-b${String(batchNo).padStart(2, '0')}-${runId}`;
        try {
          const result = await uploadUnsigned({
            cloudName, uploadPreset, assetFolder, filePath: f.path, publicId
          });
          const speed = mbps(f.size, result.durationMs);
          if (result.ok) {
            console.log(`OK   ${f.name} ${humanBytes(f.size)} ${speed.toFixed(2)} Mb/s http=${result.status} req=${result.requestId ?? 'n/a'}`);
          } else {
            const msg = result.data?.error?.message ?? result.cldErrorHeader ?? 'unknown';
            console.error(`ERR  ${f.name} http=${result.status} req=${result.requestId ?? 'n/a'} x-cld-error=${result.cldErrorHeader ?? 'n/a'} msg=${msg}`);
          }
          await writeLogLine(logPath, {
            ts: new Date().toISOString(),
            runId, batch: batchNo, file: f.name, path: f.path, size: f.size,
            publicId, status: result.ok ? 'ok' : 'error',
            httpStatus: result.status, durationMs: result.durationMs,
            requestId: result.requestId, cldErrorHeader: result.cldErrorHeader,
            cld: result.data
          });
          return { ok: result.ok };
        } catch (err) {
          console.error(`ERR  ${f.name} exception=${String(err)}`);
          await writeLogLine(logPath, {
            ts: new Date().toISOString(),
            runId, batch: batchNo, file: f.name, path: f.path, size: f.size,
            publicId, status: 'exception', error: String(err)
          });
          return { ok: false };
        }
      })
    );

    const okCount = results.filter(r => r.ok).length;
    totalOk += okCount;
    totalTried += results.length;

    // Batch summary (unchanged)
    console.log(`Batch ${batchNo} complete: ${okCount}/${results.length} succeeded.`);

    if (b < batches - 1 && delayMs > 0) {
      await delay(delayMs);
    }
  }

  await writeLogLine(logPath, { ts: new Date().toISOString(), runId, event: 'end', totalOk, totalTried });

  // Final summary
  if (totalOk === totalTried) {
    console.log('All done.');
  } else {
    console.log('All done.');
    console.error(`Note: ${totalTried - totalOk} of ${totalTried} uploads failed. See log for details: ${path.basename(logPath)}`);
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
