#!/usr/bin/env bash
# Deploy the middleware to Cloud Run.
#
# Requires:
#   - gcloud CLI logged in and pointing at your project
#   - Artifact Registry enabled
#   - The three secrets HUBSPOT_ACCESS_TOKEN, AIRTABLE_API_KEY, AIRTABLE_WEBHOOK_SECRET
#     already created in Secret Manager (see below).
#
# Usage:
#   ./scripts/deploy.sh <gcp-project-id> <region> [service-name]
#
# Example:
#   ./scripts/deploy.sh wendt-integrations us-central1 wendt-airtable-sync

set -euo pipefail

PROJECT_ID="${1:?usage: deploy.sh <project-id> <region> [service-name]}"
REGION="${2:?usage: deploy.sh <project-id> <region> [service-name]}"
SERVICE_NAME="${3:-wendt-airtable-sync}"
AR_REPO="wendt-integrations"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${AR_REPO}/${SERVICE_NAME}:$(git rev-parse --short HEAD 2>/dev/null || date +%s)"

echo "[deploy] project=${PROJECT_ID} region=${REGION} service=${SERVICE_NAME}"
echo "[deploy] image=${IMAGE}"

gcloud config set project "${PROJECT_ID}"
gcloud config set run/region "${REGION}"

# Ensure Artifact Registry repo exists (no-op if it already does).
gcloud artifacts repositories describe "${AR_REPO}" --location="${REGION}" >/dev/null 2>&1 || \
  gcloud artifacts repositories create "${AR_REPO}" \
    --repository-format=docker \
    --location="${REGION}" \
    --description="Wendt HubSpot integrations"

# Build & push via Cloud Build (avoids requiring a local Docker daemon).
gcloud builds submit --tag "${IMAGE}" .

# Deploy. Secrets are mounted as env vars — never bake them into the image.
gcloud run deploy "${SERVICE_NAME}" \
  --image="${IMAGE}" \
  --allow-unauthenticated \
  --port=8080 \
  --min-instances=0 \
  --max-instances=5 \
  --cpu=1 \
  --memory=512Mi \
  --timeout=60 \
  --set-secrets=HUBSPOT_ACCESS_TOKEN=HUBSPOT_ACCESS_TOKEN:latest,AIRTABLE_API_KEY=AIRTABLE_API_KEY:latest,AIRTABLE_WEBHOOK_SECRET=AIRTABLE_WEBHOOK_SECRET:latest \
  --set-env-vars=LOG_LEVEL=info

URL="$(gcloud run services describe "${SERVICE_NAME}" --format='value(status.url)')"
echo ""
echo "Deployed. Webhook URL to paste into every Airtable Automation:"
echo "  ${URL}/webhook/airtable?token=<AIRTABLE_WEBHOOK_SECRET>"
