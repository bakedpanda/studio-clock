#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "Rebuilding studio-clock..."
docker-compose up -d --build --force-recreate

IP=$(hostname -I | awk '{print $1}')
echo ""
echo "Done."
echo "  Viewer   http://$IP:7823/"
echo "  Operator http://$IP:7823/operator"
