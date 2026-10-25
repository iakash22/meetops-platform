# Production object storage (R2 / S3): lifecycle and CORS

The compose MinIO fork is **local dev only**. In production, StorageService talks to
Cloudflare R2 or AWS S3 (`STORAGE_PROVIDER=r2|s3`). Apply the following to the bucket
out of band (Terraform, `wrangler`, or `aws s3api`). The bucket stays **private**: no public
access and no anonymous policy. Browsers only use presigned URLs.

## Lifecycle

- Session chunks live under the flat prefix `tmp/session-chunks/`
  (`tmp/session-chunks/org/{orgId}/meetings/{meetingId}/sessions/{sessionId}/{seq}.part`).
  Lifecycle filters are prefix-only (no wildcards), which is why the prefix is flat. They expire after 1 day.
- Incomplete multipart uploads are aborted after 1 day.

AWS S3 (`aws s3api put-bucket-lifecycle-configuration --bucket <bucket> --lifecycle-configuration file://lifecycle.json`):

```json
{
  "Rules": [
    {
      "ID": "expire-session-chunks",
      "Status": "Enabled",
      "Filter": { "Prefix": "tmp/session-chunks/" },
      "Expiration": { "Days": 1 }
    },
    {
      "ID": "abort-incomplete-multipart",
      "Status": "Enabled",
      "Filter": { "Prefix": "" },
      "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }
    }
  ]
}
```

Cloudflare R2 supports the same S3 lifecycle API (the same JSON via `aws s3api --endpoint-url https://<account>.r2.cloudflarestorage.com`),
or the dashboard/`wrangler r2 bucket lifecycle add <bucket> expire-session-chunks tmp/session-chunks/ --expire-days 1`
plus an abort-multipart rule.

## CORS

Allow only the production web origin (the same value as API `WEB_ORIGINS`, single origin per env), and expose `ETag` for multipart:

```json
{
  "CORSRules": [
    {
      "AllowedOrigins": ["https://app.example.com"],
      "AllowedMethods": ["GET", "PUT", "POST", "HEAD"],
      "AllowedHeaders": ["*"],
      "ExposeHeaders": ["ETag"],
      "MaxAgeSeconds": 3600
    }
  ]
}
```

`aws s3api put-bucket-cors --bucket <bucket> --cors-configuration file://cors.json` (R2: same with `--endpoint-url`, or the dashboard).
Never use `"*"` as an origin.
