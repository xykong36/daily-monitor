#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE_DIR="/opt/ph-daily-monitor"
HOST="lbot-useast"
ENV_FILE="$SCRIPT_DIR/.env.remote"
N8N_PORT=5678

# --- Usage ---
usage() {
  cat <<EOF
Usage: ./setup.sh

First-time setup for PH Daily Monitor on $HOST.
This script handles everything: Docker check, file sync, service start,
n8n owner creation, credential setup, workflow import, and activation.
EOF
  exit 0
}

[[ "${1:-}" == "-h" || "${1:-}" == "--help" ]] && usage

if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found." >&2
  exit 1
fi

# --- Load env vars ---
load_env_var() {
  local key="$1"
  grep "^${key}=" "$ENV_FILE" | head -1 | cut -d'=' -f2- | tr -d '"'
}

OWNER_EMAIL=$(load_env_var OWNER_EMAIL)
OWNER_PASS=$(load_env_var OWNER_PASS)
PH_TOKEN=$(load_env_var PRODUCTHUNT_API_TOKEN)
DEEPSEEK_KEY=$(load_env_var DEEPSEEK_API_KEY)

echo "=========================================="
echo "  First-time setup: $HOST"
echo "=========================================="

# --- Step 1: Check remote Docker ---
echo ""
echo "==> Step 1: Checking Docker on $HOST..."
ssh "$HOST" "docker --version && docker compose version" || {
  echo "ERROR: Docker or docker compose not available on $HOST" >&2
  exit 1
}

# --- Step 2: Create remote directories ---
echo ""
echo "==> Step 2: Creating remote directories..."
ssh "$HOST" "sudo mkdir -p $REMOTE_DIR/data $REMOTE_DIR/workflow && sudo chown -R \$(whoami):\$(id -gn) $REMOTE_DIR"

# --- Step 3: Sync all files ---
echo ""
echo "==> Step 3: Syncing files to $HOST..."
scp "$SCRIPT_DIR/docker-compose.yml" "$SCRIPT_DIR/init-data.sh" "$HOST:$REMOTE_DIR/"
scp "$SCRIPT_DIR/workflow/ph-daily-monitor.json" "$HOST:$REMOTE_DIR/workflow/"
scp "$ENV_FILE" "$HOST:$REMOTE_DIR/.env"
ssh "$HOST" "chmod +x $REMOTE_DIR/init-data.sh && chmod 600 $REMOTE_DIR/.env"

# --- Step 4: Pull images & start services ---
echo ""
echo "==> Step 4: Pulling images and starting services..."
ssh "$HOST" "cd $REMOTE_DIR && docker compose pull && docker compose up -d"

# --- Step 5: Wait for health ---
echo ""
echo "==> Step 5: Waiting for services to be healthy..."
ssh "$HOST" "
  echo 'Waiting for PostgreSQL...'
  for i in \$(seq 1 30); do
    if cd $REMOTE_DIR && docker compose ps postgres 2>/dev/null | grep -q healthy; then
      echo 'PostgreSQL: healthy'
      break
    fi
    if [ \$i -eq 30 ]; then echo 'ERROR: PostgreSQL not healthy after 60s'; exit 1; fi
    sleep 2
  done
  echo 'Waiting for n8n...'
  for i in \$(seq 1 30); do
    if curl -sf http://localhost:${N8N_PORT}/healthz >/dev/null 2>&1; then
      echo 'n8n: responding on port ${N8N_PORT}'
      break
    fi
    if [ \$i -eq 30 ]; then echo 'ERROR: n8n not responding after 60s'; exit 1; fi
    sleep 2
  done
"

# --- Step 6: Fix data directory permissions ---
echo ""
echo "==> Step 6: Fixing data directory permissions..."
ssh "$HOST" "cd $REMOTE_DIR && docker compose exec -T n8n chown -R node:node /data/ph-monitor 2>/dev/null || true"

# --- Step 7: Create n8n owner account ---
echo ""
echo "==> Step 7: Creating n8n owner account..."
OWNER_RESULT=$(ssh "$HOST" "curl -s -w '\n%{http_code}' -X POST http://localhost:${N8N_PORT}/rest/owner/setup \
  -H 'Content-Type: application/json' \
  -d '{
    \"email\": \"${OWNER_EMAIL}\",
    \"password\": \"${OWNER_PASS}\",
    \"firstName\": \"PH\",
    \"lastName\": \"Monitor\"
  }'")

OWNER_HTTP_CODE=$(echo "$OWNER_RESULT" | tail -1)
OWNER_BODY=$(echo "$OWNER_RESULT" | sed '$d')

if [[ "$OWNER_HTTP_CODE" == "200" ]]; then
  echo "    Owner account created successfully."
elif echo "$OWNER_BODY" | grep -q "already set up"; then
  echo "    Owner account already exists, skipping."
else
  echo "    WARNING: Owner setup returned HTTP $OWNER_HTTP_CODE"
  echo "    $OWNER_BODY"
fi

# --- Step 8: Login and create credentials ---
echo ""
echo "==> Step 8: Logging in and creating credentials..."

# Login to get cookies
ssh "$HOST" "curl -s -c /tmp/n8n-cookies -X POST http://localhost:${N8N_PORT}/rest/login \
  -H 'Content-Type: application/json' \
  -d '{\"emailOrLdapLoginId\":\"${OWNER_EMAIL}\",\"password\":\"${OWNER_PASS}\"}' > /dev/null"

# Create Product Hunt API credential (httpHeaderAuth)
echo "    Creating 'Product Hunt API' credential..."
PH_CRED_RESULT=$(ssh "$HOST" "curl -s -b /tmp/n8n-cookies -X POST http://localhost:${N8N_PORT}/rest/credentials \
  -H 'Content-Type: application/json' \
  -d '{
    \"name\": \"Product Hunt API\",
    \"type\": \"httpHeaderAuth\",
    \"data\": {
      \"name\": \"Authorization\",
      \"value\": \"Bearer ${PH_TOKEN}\"
    }
  }'")

PH_CRED_ID=$(echo "$PH_CRED_RESULT" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
if [[ -n "$PH_CRED_ID" ]]; then
  echo "    Created with ID: $PH_CRED_ID"
else
  echo "    WARNING: Could not extract credential ID"
  echo "    $PH_CRED_RESULT"
fi

# Create DeepSeek API credential (httpHeaderAuth)
echo "    Creating 'DeepSeek API' credential..."
DS_CRED_RESULT=$(ssh "$HOST" "curl -s -b /tmp/n8n-cookies -X POST http://localhost:${N8N_PORT}/rest/credentials \
  -H 'Content-Type: application/json' \
  -d '{
    \"name\": \"DeepSeek API\",
    \"type\": \"httpHeaderAuth\",
    \"data\": {
      \"name\": \"Authorization\",
      \"value\": \"Bearer ${DEEPSEEK_KEY}\"
    }
  }'")

DS_CRED_ID=$(echo "$DS_CRED_RESULT" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
if [[ -n "$DS_CRED_ID" ]]; then
  echo "    Created with ID: $DS_CRED_ID"
else
  echo "    WARNING: Could not extract credential ID"
  echo "    $DS_CRED_RESULT"
fi

# --- Step 9: Import workflow ---
echo ""
echo "==> Step 9: Importing workflow..."
ssh "$HOST" "cd $REMOTE_DIR && docker compose exec -T n8n n8n import:workflow --input=/home/node/workflow/ph-daily-monitor.json"
echo "    Workflow imported."

# --- Step 10: Update workflow credential references ---
echo ""
echo "==> Step 10: Updating workflow credential references..."

# Get all workflows to find the imported one
WORKFLOWS=$(ssh "$HOST" "curl -s -b /tmp/n8n-cookies http://localhost:${N8N_PORT}/rest/workflows")
WORKFLOW_ID=$(echo "$WORKFLOWS" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [[ -z "$WORKFLOW_ID" ]]; then
  echo "    WARNING: Could not find workflow ID. You may need to manually assign credentials."
else
  echo "    Found workflow ID: $WORKFLOW_ID"

  # Get full workflow
  WORKFLOW_JSON=$(ssh "$HOST" "curl -s -b /tmp/n8n-cookies http://localhost:${N8N_PORT}/rest/workflows/${WORKFLOW_ID}")

  # Update credential references in the workflow JSON
  # Replace credential IDs for httpHeaderAuth nodes
  if [[ -n "$PH_CRED_ID" && -n "$DS_CRED_ID" ]]; then
    UPDATED_JSON=$(echo "$WORKFLOW_JSON" | ssh "$HOST" "python3 -c \"
import sys, json

data = json.load(sys.stdin)
workflow = data.get('data', data)

for node in workflow.get('nodes', []):
    creds = node.get('credentials', {})
    if 'httpHeaderAuth' in creds:
        cred_name = creds['httpHeaderAuth'].get('name', '')
        if 'Product Hunt' in cred_name:
            creds['httpHeaderAuth']['id'] = '${PH_CRED_ID}'
        elif 'DeepSeek' in cred_name:
            creds['httpHeaderAuth']['id'] = '${DS_CRED_ID}'

json.dumps(workflow)
print(json.dumps(workflow))
\"" 2>/dev/null) || true

    if [[ -n "$UPDATED_JSON" ]]; then
      # PUT the updated workflow back
      UPDATE_RESULT=$(ssh "$HOST" "curl -s -w '\n%{http_code}' -b /tmp/n8n-cookies -X PUT \
        http://localhost:${N8N_PORT}/rest/workflows/${WORKFLOW_ID} \
        -H 'Content-Type: application/json' \
        -d '${UPDATED_JSON}'")
      UPDATE_CODE=$(echo "$UPDATE_RESULT" | tail -1)
      if [[ "$UPDATE_CODE" == "200" ]]; then
        echo "    Credential references updated."
      else
        echo "    WARNING: Failed to update credentials (HTTP $UPDATE_CODE). Manual assignment may be needed."
      fi
    else
      echo "    WARNING: JSON processing failed. Manual credential assignment may be needed."
    fi
  else
    echo "    WARNING: Missing credential IDs. Manual assignment needed."
  fi
fi

# --- Step 11: Activate workflow ---
echo ""
echo "==> Step 11: Activating workflow..."
if [[ -n "$WORKFLOW_ID" ]]; then
  ACTIVATE_RESULT=$(ssh "$HOST" "curl -s -w '\n%{http_code}' -b /tmp/n8n-cookies -X PATCH \
    http://localhost:${N8N_PORT}/rest/workflows/${WORKFLOW_ID} \
    -H 'Content-Type: application/json' \
    -d '{\"active\": true}'")
  ACTIVATE_CODE=$(echo "$ACTIVATE_RESULT" | tail -1)
  if [[ "$ACTIVATE_CODE" == "200" ]]; then
    echo "    Workflow activated!"
  else
    echo "    WARNING: Activation returned HTTP $ACTIVATE_CODE"
  fi
else
  echo "    WARNING: No workflow ID — activate manually in the n8n UI."
fi

# --- Cleanup ---
ssh "$HOST" "rm -f /tmp/n8n-cookies" 2>/dev/null || true

# --- Summary ---
echo ""
echo "=========================================="
echo "  Setup complete: $HOST"
echo "=========================================="
echo ""
echo "Verification commands:"
echo "  ssh $HOST 'cd $REMOTE_DIR && docker compose ps'"
echo "  ssh $HOST 'docker exec \$(docker ps -qf name=n8n) printenv | grep NODE_FUNCTION'"
echo "  ssh -L 5678:localhost:5678 $HOST  # then open http://localhost:5678"
echo ""
if [[ -n "${WORKFLOW_ID:-}" ]]; then
  echo "Workflow ID: $WORKFLOW_ID"
  echo ""
  echo "Manual trigger test:"
  echo "  ssh $HOST \"curl -s -c /tmp/n8n-cookies -X POST http://localhost:${N8N_PORT}/rest/login \\"
  echo "    -H 'Content-Type: application/json' \\"
  echo "    -d '{\\\"emailOrLdapLoginId\\\":\\\"${OWNER_EMAIL}\\\",\\\"password\\\":\\\"${OWNER_PASS}\\\"}' > /dev/null && \\"
  echo "    curl -s -b /tmp/n8n-cookies -X POST http://localhost:${N8N_PORT}/rest/workflows/${WORKFLOW_ID}/run \\"
  echo "    -H 'Content-Type: application/json' -d '{}'\""
fi
