#!/usr/bin/env bash
set -euo pipefail

REMOTE_HOST="lbot-useast"
REMOTE_DIR="/home/xkong/rss-daily-digest"
IMAGE_NAME="rss-daily-digest:latest"

echo "==> Step 1: Building Docker image..."
docker build -t "$IMAGE_NAME" .

echo "==> Step 2: Transferring image to $REMOTE_HOST..."
docker save "$IMAGE_NAME" | gzip | ssh "$REMOTE_HOST" 'docker load'

echo "==> Step 3: Syncing config files..."
ssh "$REMOTE_HOST" "mkdir -p $REMOTE_DIR/data $REMOTE_DIR/logs $REMOTE_DIR/output"
scp docker-compose.yml run.sh "$REMOTE_HOST:$REMOTE_DIR/"
scp systemd/rss-digest.service systemd/rss-digest.timer "$REMOTE_HOST:$REMOTE_DIR/"
ssh "$REMOTE_HOST" "chmod +x $REMOTE_DIR/run.sh"

# 首次部署时需手动 scp .env:
# scp .env lbot-useast:/opt/rss-daily-digest/.env

echo "==> Step 4: Setting up systemd timer..."
ssh "$REMOTE_HOST" "
  sudo cp $REMOTE_DIR/rss-digest.service $REMOTE_DIR/rss-digest.timer /etc/systemd/system/
  # Clean up old cron entry if present
  if crontab -l 2>/dev/null | grep -q 'rss-daily-digest'; then
    crontab -l | grep -v 'rss-daily-digest' | crontab -
    echo 'Old cron entry removed.'
  fi
  sudo systemctl daemon-reload
  sudo systemctl enable --now rss-digest.timer
  echo 'Timer status:'
  systemctl status rss-digest.timer --no-pager
"

echo "==> Done! Deployed to $REMOTE_HOST:$REMOTE_DIR"
echo "    First time? Run: scp .env $REMOTE_HOST:$REMOTE_DIR/.env"
echo "    Test run:        ssh $REMOTE_HOST '$REMOTE_DIR/run.sh --limit 1'"
