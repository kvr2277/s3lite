#!/bin/bash
set -e
STACK_NAME="s3-browser-stack"
BUCKET_NAME="s3-browser-$(aws sts get-caller-identity --query Account --output text)"
REGION="${AWS_DEFAULT_REGION:-us-east-1}"

echo "Deploying S3 Browser..."
echo "Stack: $STACK_NAME | Bucket: $BUCKET_NAME | Region: $REGION"

echo "1. Deploying infrastructure..."
echo "Takes around 5 minutes to deploy.."
# Create CF templates bucket if it doesn't exist
CF_BUCKET="cf-templates-$(aws sts get-caller-identity --query Account --output text)-$REGION"
if ! aws s3 head-bucket --bucket "$CF_BUCKET" 2>/dev/null; then
  echo "Creating CloudFormation templates bucket: $CF_BUCKET"
  if [ "$REGION" = "us-east-1" ]; then
    aws s3 mb "s3://$CF_BUCKET" --region "$REGION"
  else
    aws s3 mb "s3://$CF_BUCKET" --region "$REGION" --create-bucket-configuration LocationConstraint="$REGION"
  fi
fi
aws cloudformation deploy \
  --template-file infrastructure/template.yaml \
  --stack-name "$STACK_NAME" \
  --parameter-overrides BucketName="$BUCKET_NAME" \
  --capabilities CAPABILITY_NAMED_IAM \
  --region "$REGION" \
  --s3-bucket "$CF_BUCKET" \
  --no-fail-on-empty-changeset

# Get outputs
get_output() {
  aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

CF_DOMAIN=$(get_output CloudFrontDomain)
POOL_ID=$(get_output UserPoolId)
CLIENT_ID=$(get_output UserPoolClientId)
IDENTITY_POOL_ID=$(get_output IdentityPoolId)
API_ENDPOINT=$(get_output ApiEndpoint)

# Generate config.js with real values
echo "2. Generating config.js..."
cat > website/config.js << EOF
window.S3B_CONFIG = {
  region: '$REGION',
  userPoolId: '$POOL_ID',
  clientId: '$CLIENT_ID',
  identityPoolId: '$IDENTITY_POOL_ID',
  apiEndpoint: '$API_ENDPOINT'
};
EOF

echo "3. Uploading website files..."
aws s3 sync website/ "s3://$BUCKET_NAME/" --region "$REGION" --delete --cache-control "max-age=3600"
# Set correct content types and no-cache for HTML
for f in index.html login.html; do
  aws s3 cp "s3://$BUCKET_NAME/$f" "s3://$BUCKET_NAME/$f" --content-type "text/html" --cache-control "no-cache" --metadata-directive REPLACE --region "$REGION" 2>/dev/null || true
done
aws s3 cp "s3://$BUCKET_NAME/config.js" "s3://$BUCKET_NAME/config.js" --content-type "application/javascript" --cache-control "no-cache" --metadata-directive REPLACE --region "$REGION"

echo "4. Invalidating CloudFront cache..."
DIST_ID=$(get_output CloudFrontDistributionId 2>/dev/null || echo "")
if [ -n "$DIST_ID" ]; then
  aws cloudfront create-invalidation --distribution-id "$DIST_ID" --paths "/*" --region "$REGION" > /dev/null
fi

echo ""
echo "Done! Website: https://$CF_DOMAIN"
echo ""
echo "Next step - Add users to login"
echo ""