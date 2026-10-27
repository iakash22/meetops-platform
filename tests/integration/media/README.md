# Media e2e suite

`media-e2e.test.ts` drives dummy media through the API upload and recording-session routes, a presigned PUT into
a throwaway MinIO bucket, the `process_upload` job over BullMQ/Redis, the worker content scan (real ffprobe),
normalization, and the presigned download (attachment disposition, fixed content type, private bucket).

Env (never commit values): `QA_MINIO_ENDPOINT`, `QA_MINIO_ACCESS_KEY`, `QA_MINIO_SECRET_KEY`,
`QA_EXTERNAL_REDIS_URL`. `QA_MEDIA_LARGE=1` also generates and runs 2 min and 30 min files with ffmpeg.
The suite skips with a reason when MinIO, Redis, ffmpeg or the scan worker (#269/#274) are missing.

Each run uses a unique bucket `qa-media-<hex>` and Redis prefix `qa:it:media:<hex>`, both deleted in teardown.

`fixtures/`: synthetic only (lavfi sine, silence, band-passed pink noise). No recordings, no personal data. Each
file is under 330 KB. `truncated.*`, `really_png.mp4` and `bomb_*` are deliberately bad. ELF, polyglot, sparse,
oversize and forged-duration inputs are built in the test, not committed.

Known open bugs are `it.fails` with their reference: #269 M-1 (container duration trusted, also the truncation
variant), #269 M-2 (MediaRecorder WebM without Duration rejected), #269 L-1 (WebM + HTML marked clean), and
zero-width/invisible characters accepted in upload filenames.
