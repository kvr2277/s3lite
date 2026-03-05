# S3 Browser

A web application for browsing and managing AWS S3 buckets. Deployed as a CloudFormation stack with CloudFront, Cognito authentication (email OTP), and a Lambda-backed API with SigV4 signing.

## ⚠️ Important Cautions

- This is a simple S3 management tool intended for admins in small AWS accounts. It is not a replacement for the AWS Console.
- All authenticated users get broad S3 access (list, read, write, delete across all buckets). Only add users you trust with full S3 admin privileges.
- There is no support for S3 versioning, delete markers, or object lock. Objects deleted through this tool are permanently removed and cannot be restored.
- There is no audit trail, access logging, or fine-grained permissions. If you need these, use the AWS Console or a purpose-built tool.
- Storage class changes (e.g., bulk convert to Intelligent-Tiering) use S3 copy operations. This incurs standard S3 request and storage costs.
- Use at your own risk. Understand what each action does before clicking.

## Features

- Dashboard with account-level metrics (bucket count, total objects, total size)
- Browse buckets with sorting (name, size, date) and pagination
- Navigate folder structures with folder/bucket-level stats
- Object details with storage class, size, ETag, last modified
- Download individual files (with size confirmation) or bulk download as ZIP
- Upload files with drag-and-drop, choose storage class on upload
- Delete objects with typed confirmation (type "DELETE FILE" to confirm)
- Change object storage class (Standard, Standard-IA, Intelligent-Tiering, Glacier, etc.)
- Bulk convert S3 Standard objects to Intelligent-Tiering (async for large buckets)
- Intelligent-Tiering transition timeline visualization
- Search buckets by name
- Cognito email OTP login (no passwords)

## Deploy

Prerequisites: [AWS CLI](https://docs.aws.amazon.com/cli/latest/userguide/cli-configure-sign-in.html) configured with appropriate permissions.

```bash
chmod +x deploy.sh
./deploy.sh
```

The script will:
1. Deploy the CloudFormation stack (S3, CloudFront, Cognito, API Gateway, Lambda)
2. Generate `website/config.js` with stack outputs
3. Upload website files to S3
4. Invalidate the CloudFront cache
5. Print the website URL


## Add Users

After deploying, add users with:

```bash
ADD_USER_EMAIL=youremail@example.com ./add-user.sh
```

Replace `youremail@example.com` with the actual email address. Repeat for each user.

# URL
To get the URL later (replace region if needed):

```bash
aws cloudformation describe-stacks --stack-name s3-browser-stack --region us-east-1 \
  --query "Stacks[0].Outputs[?OutputKey=='WebsiteURL'].OutputValue" --output text
```

## Project Structure

```
├── website/
│   ├── index.html      # Main application page
│   ├── login.html      # Login page (email OTP)
│   ├── styles.css      # Styling
│   ├── config.js       # Generated config (do not edit manually)
│   └── app.js          # Application logic
├── infrastructure/
│   └── template.yaml   # CloudFormation template (all infra + Lambda code)
└── deploy.sh           # Deployment script
```

## Cost Estimate (us-east-1)

This stack uses serverless/pay-per-use services. Below is what gets invoked and approximate monthly costs.

### Infrastructure (always-on)

| Service | What | Monthly Cost |
|---------|------|-------------|
| CloudFront | Distribution (PriceClass_100) | Free tier covers 1TB/10M requests. Minimal beyond that (~$0.085/GB) |
| S3 | Static website bucket (HTML/JS/CSS ~100KB) | < $0.01 |
| Cognito User Pool | User store + email OTP auth | Free for first 50,000 MAUs |
| Cognito Identity Pool | Federated identity for SigV4 | Free |
| Lambda (auth-edge) | Viewer-request auth check on every page load | Included in CloudFront requests |
| API Gateway | REST API (IAM auth) | $3.50 per million requests |
| Lambda (API) | 256MB, up to 900s timeout | $0.0000042/request + $0.0000133/GB-s |

### What happens on each page load

**Home page** (3 Lambda invocations):
- `GET /metrics` — calls `s3:ListBuckets` + CloudWatch `GetMetricData` (batched, up to 500 queries per call) for every bucket to get total size/object counts
- `GET /buckets` — calls `s3:ListBuckets` + `s3:GetBucketLocation` for each bucket
- `GET /bucket-sizes` — calls `s3:ListBuckets` + CloudWatch `GetMetricData` (same pattern as metrics)

**Bucket view** (3 Lambda invocations):
- `GET /buckets/{name}/objects` — `s3:ListObjectsV2` (50 objects per page)
- `GET /buckets/{name}/storage-breakdown` — `s3:ListObjectsV2` (iterates all objects, up to 20s)
- `GET /buckets/{name}/version-info` — `s3:GetBucketVersioning` + `s3:ListObjectVersions` (up to 20s)

**Object detail** (1 Lambda invocation):
- `GET /buckets/{name}/object-detail` — `s3:HeadObject`

### Approximate monthly cost by usage pattern

| Usage | Lambda Invocations | CloudWatch GetMetricData | API Gateway | Est. Total |
|-------|-------------------|------------------------|-------------|------------|
| 1 user, ~10 page loads/day | ~1,500/mo | ~1,000 queries/mo | ~1,500 requests/mo | **< $1/mo** |
| 3 users, ~30 loads/day | ~5,000/mo | ~3,000 queries/mo | ~5,000 requests/mo | **~$1–2/mo** |
| 10 users, active daily | ~15,000/mo | ~10,000 queries/mo | ~15,000 requests/mo | **~$2–5/mo** |

### Key cost drivers

- **CloudWatch GetMetricData**: $0.01 per 1,000 metrics queried. The home page queries 8 storage types × N buckets, so an account with 50 buckets = ~400 metric queries per home page load. This is the main cost if you have many buckets and refresh frequently.
- **Lambda duration**: The `metrics`, `bucket-sizes`, `storage-breakdown`, and `version-info` endpoints can run for several seconds on large accounts. At 256MB, this is ~$0.0000033/second.
- **S3 API requests**: `ListObjectsV2` and `ListObjectVersions` are $0.005 per 1,000 requests. The storage-breakdown and version-info endpoints paginate through all objects, so a bucket with 100K objects = ~100 list calls per view.
- **Data transfer**: CloudFront to internet is $0.085/GB after the 1TB free tier. The app itself is tiny; transfer costs only matter if you download large files through the presigned URLs.

### What's free

- Cognito (under 50K MAUs)
- CloudFront (first 1TB transfer + 10M requests/month)
- Lambda (first 1M requests + 400,000 GB-seconds/month)
- API Gateway (first 1M requests in first 12 months)

For a small team (1–5 users) with under 100 buckets, expect **under $2/month** in total. The biggest variable is how many buckets you have and how often you load the home page, since each load queries CloudWatch for every bucket.
