# cld-rn-uw-tests

Unsigned upload batch tester for Cloudinary. CLI only. Cross-platform on macOS and Windows.

Designed to:

- Upload the same local files in parallel within each batch
- Run multiple batches with a fixed delay between batches
- Always pass the `folder` parameter
- Produce structured logs for analysis
- Pair with Wireshark/network capture for later analysis

## Why no SDK?

This tool sends **unsigned** uploads directly to the HTTP API using your **cloud name** in the URL. No signature and no account credentials are required for the script to run. Note: Cloudinary’s **CLI** requires `CLOUDINARY_URL` even for unsigned uploads, but this project does **not** use the CLI or the Node SDK in it's current iteration.

## Requirements

- Node.js 24.11.0 or newer
- macOS Sequoia 15.6.1 or Windows 10/11
- Five local test images in `files/`
- An **unsigned** upload preset configured in your Cloudinary environment
- Dynamic folders enabled if you expect `asset_folder` behavior

## Dependencies

- Runtime: none beyond Node’s built-in `fetch`, `FormData`, `performance` and `Blob`
- Dev tooling: optional (not required)
- Network capture: Wireshark (recommended, cross platform - Mac, Windows, Linux)

  - [Wireshark.org](https://www.wireshark.org/)
  - [Wireshark repo](https://gitlab.com/wireshark/wireshark)
  - `tcpdump` for MacOS provides same functionality but less analysis capabilities

- Network capture for Windows (if not using Wireshark)
  - `netsh trace` is a built-in equivalent of `tcpdump` for Windows based platforms
    1. Open Command Prompt as Administrator: Right-click on the Command Prompt icon and select "Run as administrator"
    2. Start the trace: Run `netsh trace start capture=yes`.
       - You can narrow the capture to a specific IP address with `netsh trace start capture=yes IPv4.Address=<Remote IP>`.
    3. Stop the trace: When you've captured what you need, `run netsh trace stop`.
    4. Find the files: The trace files (ending in `.etl` and `.cab`) will be generated and their location will be shown in the command prompt output. You can convert these files for Wireshark using tools like Microsoft Message Analyzer.
  - `pktmon` is another Windows built-in for Windows 10+ (if not using Wireshark)
    1. Open Command Prompt or PowerShell as Administrator
    2. Start the capture: Use `pktmon create pcapng --etw`.
    3. Stop the capture: Run `pktmon stop`.
    4. The file will be in `pcapng` format and can be opened with Wireshark.
       - To see all available options, type `pktmon --help`.

## Repository layout

```
cld-rn-uw-tests/
  package.json
  README.md
  .gitignore
  src/
    cli.mjs
  files/
    500kb.jpg
    1mb.jpg
    5mb.jpg
    10mb.jpg
    50mb.jpg
  out/          # ndjson logs created at runtime
  captures/     # save your .pcap files here
```

The `.gitignore` in this project already excludes `out/`, `captures/`, and common OS cruft.

## Getting started from GitHub

### 1) Clone

```
git clone <your-repo-url> cld-rn-uw-tests
cd cld-rn-uw-tests
```

### 2) File Placement

Five test images are already in `files/`, named by size:

- `500kb.jpg`
- `1mb.jpg`
- `5mb.jpg`
- `10mb.jpg`
- `50mb.jpg`

> A single file ≥ 50 MB triggers a warning, and ≥ 100 MB is rejected. The 50 MB file may produce a warning but it can be safely ignored.

### 3) Verify Node

```
node -v
```

You should see `v24.11.0` or newer. This repo includes an `.nvmrc` with: `24.11.0`. If you use nvm run: `nvm use` or, if not installed locally: `nvm install`. There’s also a small version guard at the top of `src/cli.mjs` that exits early with a helpful message if your Node version is too old.

### 4) No install step needed

There is no `npm install` for this project. All networking is done with Node’s native APIs.

## Usage

From the repo root:

### Dry run

Validates file discovery, batching, prints image sizes and logging without making network calls.

```
node src/cli.mjs --cloud-name CLOUD-NAME-HERE --upload-preset photos_menus --asset-folder cloudinary-tests --batches 5 --delay-ms 10000 --dry
```

### Real run

Uploads the five files in parallel per batch, for fifty batches, with a ten second pause between batches.

```
node src/cli.mjs --cloud-name CLOUD-NAME-HERE --upload-preset photos_menus --asset-folder cloudinary-tests --batches 50 --delay-ms 10000
```

### Optional: install as a CLI

```
npm link
cld-rn-uw-tests --cloud-name CLOUD-NAME-HERE --upload-preset photos_menus --asset-folder cloudinary-tests --batches 50 --delay-ms 10000
```

### Parameters

- `--cloud-name` Your Cloudinary cloud name, for example `CLOUD-NAME-HERE`
- `--upload-preset` The unsigned preset to use, for example `photos_menus`
- `--asset-folder` Destination folder, for example `cloudinary-tests`
- `--batches` Number of batches to run, for example `5`
- `--delay-ms` Milliseconds to wait between batches, for example `10000`
- `--dry` If present, performs a dry run without HTTP requests

## What the script does

- Reads all files in `files/` and uses that set for every batch
- Starts each batch and uploads all files **in parallel**
- Always passes `asset-folder=<your-folder>`
- Writes one line per attempted upload to `out/run-YYYYMMDD-HHMMSS.ndjson` with:

  - file name
  - batch number
  - start and end timestamps
  - duration
  - HTTP status
  - parsed Cloudinary response (for successful uploads)

## Wireshark quick start

Run Wireshark only during the real run

- Start capture on your active interface
- Optional capture filter: `host api.cloudinary.com` and/or `host res.cloudinary.com`
- Useful display filters:

  - `tcp.port == 443`
  - `http2`
  - `dns and frame contains "api.cloudinary.com" || "res.cloudinary.com"`

- Save your capture as `captures/<your-name>-YYYYMMDD-HHMMSS.pcapng`

## Cloudinary setup checklist

- Cloud name: `CLOUD-NAME-HERE`
- Unsigned preset: `photos_menus`

  - Unsigned enabled
  - Tags include `v2` and `photos_menus`

- Destination folder: `cloudinary-tests`
- Note: the script does not send tags directly; the preset applies them server-side

## Troubleshooting

- **HTTP 400/401/403**

  - Confirm the cloud name, preset spelling, and that the preset is **unsigned enabled**
  - Verify the preset exists in the target cloud and environment

- **One batch succeeds, others fail intermittently**

  - Check local network, VPN state, or any corporate proxy limits

- **Large file issues**

  - Verify your account’s upload limits for large images; if a specific asset fails, re-test with a slightly smaller variant

## Optional: moving to the Cloudinary Node SDK later

If you switch to **signed** uploads (server-side), the SDK becomes useful.

- Install:

  ```
  npm i cloudinary
  ```

- Configure via environment:

  ```
  export CLOUDINARY_URL=cloudinary://<API_KEY>:<API_SECRET>@<CLOUD_NAME>
  ```

- Then use `v2.uploader.upload()` with `{ asset-folder: 'cloudinary-tests', tags: ['v2','photos_menus'] }`.
  This changes auth, logging, and error semantics, so keep it as a separate branch or PR.
