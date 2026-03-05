#!/bin/bash
set -e

if [ -z "$ADD_USER_EMAIL" ]; then
  echo "Usage: ADD_USER_EMAIL=user@example.com ./add-user.sh"
  exit 1
fi

STACK_NAME="s3-lite-stack"
REGION="${AWS_DEFAULT_REGION:-us-east-1}"

POOL_ID=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='UserPoolId'].OutputValue" --output text)

echo "Adding user: $ADD_USER_EMAIL"

aws cognito-idp admin-create-user \
  --user-pool-id "$POOL_ID" \
  --username "$ADD_USER_EMAIL" \
  --user-attributes Name=email,Value="$ADD_USER_EMAIL" Name=email_verified,Value=true \
  --message-action SUPPRESS \
  --region "$REGION"

aws ses verify-email-identity \
  --email-address "$ADD_USER_EMAIL" \
  --region "$REGION"

CF_DOMAIN=$(aws cloudformation describe-stacks --stack-name "$STACK_NAME" --region "$REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='CloudFrontDomain'].OutputValue" --output text)

echo "Done! $ADD_USER_EMAIL has been added. They will receive a verification email (check spam) — once they verify, they can log in."
echo ""
echo "Website: https://$CF_DOMAIN"
echo ""