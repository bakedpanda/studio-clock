#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

echo "Building and starting studio-clock..."
docker-compose up -d --build

echo ""
echo "Done. Running at http://$(hostname -I | awk '{print $1}'):3000"
