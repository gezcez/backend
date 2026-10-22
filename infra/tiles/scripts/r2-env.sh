# Shared by the upload scripts: checks the R2 credentials and points the AWS CLI at R2.
# R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY come from an R2 API token with
# Object Read & Write on the tiles bucket (README.md, one-time setup).

: "${R2_ACCOUNT_ID:?set R2_ACCOUNT_ID}"
: "${R2_ACCESS_KEY_ID:?set R2_ACCESS_KEY_ID}"
: "${R2_SECRET_ACCESS_KEY:?set R2_SECRET_ACCESS_KEY}"
R2_BUCKET_TILES="${R2_BUCKET_TILES:-gezcez-tiles}"

export AWS_ACCESS_KEY_ID="$R2_ACCESS_KEY_ID"
export AWS_SECRET_ACCESS_KEY="$R2_SECRET_ACCESS_KEY"
export AWS_DEFAULT_REGION=auto
R2_ENDPOINT="https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com"

if ! command -v aws >/dev/null 2>&1; then
	echo "The AWS CLI is required (https://aws.amazon.com/cli/); R2 speaks the S3 API" >&2
	exit 1
fi

r2() {
	aws s3 --endpoint-url "$R2_ENDPOINT" "$@"
}
