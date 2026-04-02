#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REMOTE_DIR="/opt/ph-daily-monitor"
HOST="lbot-useast"
ENV_FILE="$SCRIPT_DIR/.env.remote"

# --- Usage ---
usage() {
  cat <<EOF
Usage: ./deploy.sh [--import-workflow] [--sync-data]

Deploy PH Daily Monitor to $HOST.

Options:
  --import-workflow  Import workflow into n8n after deploy
  --sync-data        Sync local data/ directory to remote
  -h, --help         Show this help
EOF
  exit 0
}

# --- Parse args ---
IMPORT_WORKFLOW=false
SYNC_DATA=false

for arg in "$@"; do
  case "$arg" in
    --import-workflow) IMPORT_WORKFLOW=true ;;
    --sync-data)      SYNC_DATA=true ;;
    -h|--help)        usage ;;
    -*)               echo "Unknown option: $arg" >&2; usage ;;
    *)                echo "Unknown argument: $arg" >&2; usage ;;
  esac
done

# Validate env file exists
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found." >&2
  exit 1
fi

echo ""
echo "=========================================="
echo "  Deploying to: $HOST"
echo "=========================================="

# Step 1: Sync config files
echo "==> Step 1: Syncing files..."
ssh "$HOST" "sudo mkdir -p $REMOTE_DIR/data $REMOTE_DIR/workflow && sudo chown -R \$(whoami):\$(id -gn) $REMOTE_DIR && sudo chown 1000:1000 $REMOTE_DIR/data"
scp "$SCRIPT_DIR/docker-compose.yml" "$SCRIPT_DIR/init-data.sh" "$SCRIPT_DIR/weekly-report.mjs" "$HOST:$REMOTE_DIR/"
scp "$SCRIPT_DIR/workflow/ph-daily-monitor.json" "$HOST:$REMOTE_DIR/workflow/"
ssh "$HOST" "chmod +x $REMOTE_DIR/init-data.sh"

# Step 2: Sync env file
echo "==> Step 2: Syncing .env..."
scp "$ENV_FILE" "$HOST:$REMOTE_DIR/.env"
ssh "$HOST" "chmod 600 $REMOTE_DIR/.env"

# Step 3 (optional): Sync data
if [[ "$SYNC_DATA" == true ]]; then
  echo "==> Step 3: Syncing data/..."
  rsync -avz "$SCRIPT_DIR/data/" "$HOST:$REMOTE_DIR/data/"
fi

# Step 4: Pull images
echo "==> Step 4: Pulling Docker images..."
ssh "$HOST" "cd $REMOTE_DIR && docker compose pull"

# Step 5: Start/restart services
echo "==> Step 5: Starting services..."
ssh "$HOST" "cd $REMOTE_DIR && docker compose up -d"

# Step 6: Verify health
echo "==> Step 6: Verifying services..."
ssh "$HOST" "
  for i in \$(seq 1 30); do
    if cd $REMOTE_DIR && docker compose ps postgres 2>/dev/null | grep -q healthy; then
      echo 'PostgreSQL: healthy'
      break
    fi
    sleep 2
  done
  for i in \$(seq 1 15); do
    if curl -sf http://localhost:5678/healthz >/dev/null 2>&1; then
      echo 'n8n: responding on port 5678'
      break
    fi
    sleep 2
  done
"

# Step 7 (optional): Import workflow
if [[ "$IMPORT_WORKFLOW" == true ]]; then
  echo "==> Step 7: Importing workflow..."
  ssh "$HOST" "cd $REMOTE_DIR && docker compose exec -T n8n n8n import:workflow --input=/home/node/workflow/ph-daily-monitor.json"
  echo "    Workflow imported."
fi

echo ""
echo "==> Done!"
