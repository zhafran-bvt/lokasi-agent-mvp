#!/bin/bash
# Quick deployment helper for Surge

set -e

echo "🚀 Starting Surge.sh deployment..."
echo ""
echo "📋 What would you like to do?"
echo "1) Deploy with auto-generated domain (simple)"
echo "2) Deploy with custom domain"
echo ""
read -p "Enter choice (1 or 2): " choice

case $choice in
  1)
    echo ""
    echo "Deploying to Surge..."
    cd "$(dirname "$0")"
    npx surge dist/
    ;;
  2)
    read -p "Enter your desired domain (e.g., lokasi-reports.surge.sh): " domain
    echo ""
    echo "Deploying to ${domain}..."
    cd "$(dirname "$0")"
    npx surge dist/ --domain "$domain"
    ;;
  *)
    echo "Invalid choice"
    exit 1
    ;;
esac

echo ""
echo "✅ Deployment complete!"
