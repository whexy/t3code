#!/usr/bin/env bash
# Uploads an OTA archive to the incoming bucket, publishes it by key, and
# prints the server's JSON response. Exits 3 when the upload fails.
set -euo pipefail

if (($# != 8)); then
  echo "usage: ota-publish.sh <app> <channel> <platform> <runtime-version> <dist.tgz> <expo-config.json> <message> <git-commit>" >&2
  exit 2
fi
app=$1 channel=$2 platform=$3 runtime=$4 dist=$5 expo_config=$6 message=$7 commit=$8
: "${OTA_PUBLISH_TOKEN:?}" "${AWS_ACCESS_KEY_ID:?}" "${AWS_SECRET_ACCESS_KEY:?}"
ota_url="${OTA_URL:-https://ota.clusters.work}"
s3_endpoint="${OTA_S3_ENDPOINT:-https://s3.clusters.work}"
bucket="${OTA_S3_BUCKET:-ota-incoming}"
key="$app/$channel/${GITHUB_RUN_ID:?}-${GITHUB_RUN_ATTEMPT:?}-${commit::7}-$platform.tgz"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export AWS_CONFIG_FILE="$tmp/config"
export AWS_REQUEST_CHECKSUM_CALCULATION=when_required AWS_RESPONSE_CHECKSUM_VALIDATION=when_required
# Cloudflare caps each request at 100 MB.
aws configure set default.s3.multipart_chunksize 64MB
aws configure set default.s3.addressing_style path
# The CRT transfer client can ignore the settings above.
aws configure set default.s3.preferred_transfer_client classic
# The key may only PutObject, so nothing lists or reads the object back.
aws s3 cp "$dist" "s3://$bucket/$key" --endpoint-url "$s3_endpoint" --region us-east-1 \
  --no-progress >&2 || exit 3

# The token reaches curl on a descriptor, never in a process's arguments.
curl -fsS --retry 3 -H @<(printf 'Authorization: Bearer %s\n' "$OTA_PUBLISH_TOKEN") \
  --form-string runtimeVersion="$runtime" \
  --form-string distKey="$key" \
  -F "expoConfig=@$expo_config;type=application/json" \
  --form-string message="$message" --form-string gitCommit="$commit" \
  "$ota_url/api/apps/$app/channels/$channel/updates" || exit 1
