# cld-rn-uw-tests

CLI to run unsigned upload tests to Cloudinary using local images. macOS and Windows.

## Requirements

- Node 24.11.0 or newer
- Five images in `files/` named by size
- Your unsigned preset `photos_menus`
- Cloud name `cloud-name-here`
- Folder `cloudinary-tests`

## Install

1. Place your five images into `files/`.
2. Install nothing, Node provides all runtime dependencies.

## Usage

Prod run:
-- ```bash
node src/cli.mjs --cloud-name jonathancloudinary --upload-preset photos_menus --folder cloudinary-tests --batches 5 --delay-ms 10000

Dry run:

```bash
node src/cli.mjs --cloud-name <cloud-name-here> --upload-preset photos_menus --folder cloudinary-tests --batches 5 --delay-ms 10000 --dry
```
