# Hosted world generation

The viewer at the Vercel deployment can turn an uploaded photo into an explorable Marble world. Generation runs in `app/api`. API keys stay in Vercel env. The browser only sends a gate secret.

## Env vars

Set these on the Vercel project `image-blaster` for **Production** and **Preview**.

| Variable | Required for a world | What it does |
| --- | --- | --- |
| `WORLD_LABS_API_KEY` | Yes | Marble `worlds:generate`. Already set on Production and Preview. |
| `BLOB_READ_WRITE_TOKEN` | Yes | Stores the source image, splat, collider, panorama, thumbnail, and world manifest. **Not set yet.** |
| `BLAST_GATE_SECRET` | Yes | Shared secret the viewer sends as `x-blast-secret`. **Not set yet.** You invent this value. |
| `FAL_KEY` | No | Unused by world generation. `/api/blast` is a stub for later Hunyuan meshes and ambient SFX. Leave it unset until that work starts. |

Do not add a `VITE_` copy of any of these. Vite would bake it into the client bundle.

### Blob token

1. Open the Vercel project `image-blaster` (team `fjordskiis-projects`).
2. Storage → Create Blob store → connect it to this project.
3. Connecting the store writes `BLOB_READ_WRITE_TOKEN`. Include Production and Preview.

### Gate secret

Pick a long random string and set it as `BLAST_GATE_SECRET` on Production and Preview. Use the same value in both if both deployments should accept the same browser.

In the viewer, open **Generate a world**, paste the secret once, and leave the field. The app stores it in `localStorage` under `image-blaster.gate-secret` and sends it on later requests. It is not an API key. It only stops anonymous visitors from starting paid Marble jobs.

Clear the site data for that origin to forget it.

## What the user does

1. Open the deployed site.
2. Enter the gate secret once.
3. Choose an image, and optionally a name and prompt.
4. Start generation. The page polls until Marble finishes, then saves assets into Blob one file at a time.
5. The viewer opens `/{world-slug}` when the manifest is ready.

A phone photo is resized in the browser before upload so the request stays under Vercel's body limit.

## Routes

| Route | Role |
| --- | --- |
| `POST /api/generate` | Check the gate, store the image, submit Marble, return an operation id. |
| `GET /api/generate?operationId=` | One poll step. Copies a single finished asset when Marble is done. |
| `GET /api/worlds` | List stored world manifests and any in-progress jobs. |
| `GET` or `POST /api/blast` | Stub. Returns 501. Does not call FAL. |

`app/vercel.json` keeps `/api/*` out of the SPA rewrite. Viewer routes such as `/harbor` still serve `index.html`.

Asset copies use `maxDuration` 60. One large splat is one request. If a copy times out, the next poll retries it. `FAL_KEY` is not read.

## Local API

`bun run dev` from the repo root mounts the same handlers at `/api/*` and loads the repo `.env`. The hosted project still uses the Vercel env vars above.

## Follow-up, not in this path

Object meshes and ambient SFX stay on the local Claude skills. `/api/blast` describes the intended FAL queue handoff: explicit object images in, one submit or download per request, then URLs written onto the same manifest. Do not turn that on until `FAL_KEY` is set.
