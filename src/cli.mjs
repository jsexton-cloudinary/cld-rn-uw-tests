#!/usr/bin/env node
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// Node 20+ has global fetch, FormData, Blob
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
  node src/cli.mjs --cloud-name <name> --upload-preset <preset> --folder <folder>
  [--batches 5] [--delay-ms 10000] [--dry]
  [--pe <environment name or id>] [--pe-id <environment id>]

Required:
  --cloud-name       Your Cloudinary cloud name. Example: jonathancloudinary
  --upload-preset    Unsigned upload preset name. Example: photos_menus
  --folder           Target folder for all uploads. Example: cloudinary-tests

Optional:
  --batches          Number of batches to run. Default 5
  --delay-ms         Delay between batches in milliseconds. Default 10000
  --dry              Plan only. No uploads. Still logs the plan.
  --pe               Product environment name or id. Example: rn-cld-tests
  --pe-id            Product environment id when your org requires the id
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
        if (st && st.isFile()) files.push({ path: p, size: st.size, name });
    }
    if (files.length < 5) {
        throw new Error(`Expected at least 5 files in ${filesDir}. Found ${files.length}.`);
    }
    // Sort by size ascending and take first 5
    files.sort((a, b) => a.size - b.size);
    return files.slice(0, 5);
}

function humanBytes(n) {
    const kb = 1024, mb = kb * 1024;
    if (n >= mb) return `${(n / mb).toFixed(2)}mb`;
    if (n >= kb) return `${(n / kb).toFixed(2)}kb`;
    return `${n}b`;
}

async function uploadUnsigned({
    cloudName,
    uploadPreset,
    folder,
    filePath,
    publicId,
    signal,
    productEnv,
    productEnvId,
    resourceType = 'image'
}) {
    // Use explicit image upload endpoint to match your preset type
    const url = `https://api.cloudinary.com/v1_1/${cloudName}/${resourceType}/upload`;

    const bytes = await fs.readFile(filePath);
    const fd = new FormData();
    const blob = new Blob([bytes]);
    fd.append('file', blob, path.basename(filePath));
    fd.append('upload_preset', uploadPreset);
    fd.append('folder', folder);
    fd.append('public_id', publicId);

    // Only attach headers that are provided
    const headers = {};
    if (productEnv) headers['X-Product-Environment'] = productEnv;
    if (productEnvId) headers['X-Product-Environment-Id'] = productEnvId;

    const t0 = performance.now();
    const resp = await fetch(url, { method: 'POST', headers, body: fd, signal });
    const t1 = performance.now();

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
    const folder = args['folder'];
    const batches = Number(args['batches'] ?? 5);
    const delayMs = Number(args['delay-ms'] ?? 10000);
    const dry = Boolean(args['dry']);
    const productEnv = args['pe'] ?? args['product-env'];
    const productEnvId = args['pe-id'] ?? args['product-env-id'];


    if (!cloudName || !uploadPreset || !folder) {
        console.error('Missing required args.');
        usage();
        process.exit(1);
    }

    const { outDir, filesDir } = await ensureDirs();
    const runId = nowStamp();
    const logPath = path.join(outDir, `run-${runId}.ndjson`);
    const files = await readFiveFiles(filesDir);

    console.log(`Run ${runId}`);
    console.log(`Cloud: ${cloudName}`);
    console.log(`Preset: ${uploadPreset}`);
    console.log(`Folder: ${folder}`);
    console.log(`Product env: ${productEnv ?? 'not supplied'} Product env id: ${productEnvId ?? 'N/A'}`);
    console.log(`Batches: ${batches}  Delay: ${delayMs} ms  Dry: ${dry}`);
    console.log(`Files:`);
    files.forEach(f => console.log(`  ${f.name}  ${humanBytes(f.size)}`));
    console.log(`Log: ${logPath}`);

    await writeLogLine(logPath, { ts: new Date().toISOString(), runId, event: 'start', cloudName, uploadPreset, folder, batches, delayMs, dry });

    for (let b = 0; b < batches; b++) {
        const batchNo = b + 1;
        console.log(`Starting batch ${batchNo}/${batches}`);
        const startTs = new Date().toISOString();

        if (dry) {
            for (const f of files) {
                const publicId = `${baseNameNoExt(f.name)}-b${String(batchNo).padStart(2, '0')}-${runId}`;
                await writeLogLine(logPath, {
                    ts: new Date().toISOString(),
                    runId, batch: batchNo, file: f.name, path: f.path, size: f.size,
                    publicId, status: 'dry-run', durationMs: 0
                });
            }
        } else {
            const promises = files.map(async (f) => {
                const publicId = `${baseNameNoExt(f.name)}-b${String(batchNo).padStart(2, '0')}-${runId}`;
                let result;
                try {
                    result = await uploadUnsigned({ cloudName, uploadPreset, folder, filePath: f.path, publicId, productEnv, productEnvId });
                    await writeLogLine(logPath, {
                        ts: new Date().toISOString(),
                        runId, batch: batchNo, file: f.name, path: f.path, size: f.size,
                        publicId, status: result.ok ? 'ok' : 'error',
                        httpStatus: result.status, durationMs: result.durationMs,
                        cld: result.data, productEnv, productEnvId
                    });
                    return { file: f.name, ok: result.ok };
                } catch (err) {
                    await writeLogLine(logPath, {
                        ts: new Date().toISOString(),
                        runId, batch: batchNo, file: f.name, path: f.path, size: f.size,
                        publicId, status: 'exception', error: String(err)
                    });
                    return { file: f.name, ok: false };
                }
            });

            const results = await Promise.all(promises);
            const okCount = results.filter(r => r.ok).length;
            console.log(`Batch ${batchNo} complete: ${okCount}/${files.length} succeeded.`);
        }

        const endTs = new Date().toISOString();
        await writeLogLine(logPath, { ts: endTs, runId, event: 'batch_end', batch: batchNo, startTs, endTs });

        if (b < batches - 1 && delayMs > 0) {
            await delay(delayMs);
        }
    }

    await writeLogLine(logPath, { ts: new Date().toISOString(), runId, event: 'end' });
    console.log('All done.');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
