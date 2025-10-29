#!/bin/bash

# Smart Router Complete Deployment Script
# Safely deploys the smart router system

set -e

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${BLUE}🚀 Smart Router Deployment${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Configuration
DB_FILE="/root/apps/api/data/ai_stupidity.db"
API_DIR="/root/apps/api"
SERVICE_NAME="aistupid"

# Step 1: Backup database
echo -e "${BLUE}Step 1: Backing up database...${NC}"
if [ -f "$DB_FILE" ]; then
    BACKUP_FILE="${DB_FILE}.backup.$(date +%Y%m%d_%H%M%S)"
    cp "$DB_FILE" "$BACKUP_FILE"
    echo -e "${GREEN}✓ Backup created: $BACKUP_FILE${NC}"
else
    echo -e "${RED}✗ Database not found: $DB_FILE${NC}"
    exit 1
fi
echo ""

# Step 2: Run migration
echo -e "${BLUE}Step 2: Running database migration...${NC}"
cd "$API_DIR"
sqlite3 "$DB_FILE" < migrate-smart-router.sql

if [ $? -eq 0 ]; then
    echo -e "${GREEN}✓ Migration completed${NC}"
else
    echo -e "${RED}✗ Migration failed${NC}"
    exit 1
fi
echo ""

# Step 3: Verify tables
echo -e "${BLUE}Step 3: Verifying new tables...${NC}"
TABLES=$(sqlite3 "$DB_FILE" "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'router%';")
echo "Created tables:"
echo "$TABLES"
if echo "$TABLES" | grep -q "router_preferences"; then
    echo -e "${GREEN}✓ Tables verified${NC}"
else
    echo -e "${RED}✗ Table verification failed${NC}"
    exit 1
fi
echo ""

# Step 4: Build backend
echo -e "${BLUE}Step 4: Building backend...${NC}"
if [ -f "package.json" ]; then
    npm run build
    if [ $? -eq 0 ]; then
        echo -e "${GREEN}✓ Build successful${NC}"
    else
        echo -e "${RED}✗ Build failed${NC}"
        exit 1
    fi
else
    echo -e "${YELLOW}⚠ No package.json found${NC}"
fi
echo ""

# Step 5: Restart service
echo -e "${BLUE}Step 5: Restarting service...${NC}"
if systemctl list-units --type=service | grep -q "$SERVICE_NAME"; then
    sudo systemctl restart "$SERVICE_NAME"
    sleep 3
    
    if systemctl is-active --quiet "$SERVICE_NAME"; then
        echo -e "${GREEN}✓ Service restarted${NC}"
    else
        echo -e "${RED}✗ Service failed to start${NC}"
        sudo journalctl -u "$SERVICE_NAME" -n 20 --no-pager
        exit 1
    fi
else
    echo -e "${YELLOW}⚠ Service $SERVICE_NAME not found${NC}"
    echo "Please restart manually"
fi
echo ""

# Step 6: Wait for API
echo -e "${BLUE}Step 6: Waiting for API...${NC}"
API_URL="http://localhost:4000"
MAX_ATTEMPTS=30
ATTEMPT=0

while [ $ATTEMPT -lt $MAX_ATTEMPTS ]; do
    if curl -s "$API_URL/health" > /dev/null 2>&1; then
        echo -e "${GREEN}✓ API is ready${NC}"
        break
    fi
    ATTEMPT=$((ATTEMPT + 1))
    echo -n "."
    sleep 1
done

if [ $ATTEMPT -eq $MAX_ATTEMPTS ]; then
    echo -e "${RED}✗ API failed to start${NC}"
    exit 1
fi
echo ""

# Step 7: Test smart router
echo -e "${BLUE}Step 7: Testing smart router...${NC}"
echo ""

# Test health endpoint
echo "Testing health endpoint..."
HEALTH=$(curl -s "$API_URL/v1/router/health")
if echo "$HEALTH" | grep -q "healthy"; then
    echo -e "${GREEN}✓ Health check passed${NC}"
else
    echo -e "${RED}✗ Health check failed${NC}"
    echo "$HEALTH"
fi
echo ""

# Test analyze endpoint
echo "Testing analyze endpoint..."
ANALYZE=$(curl -s -X POST "$API_URL/v1/analyze" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Create a React component"}')

if echo "$ANALYZE" | grep -q "javascript"; then
    echo -e "${GREEN}✓ Analyze endpoint working${NC}"
    echo "Detected: $(echo "$ANALYZE" | jq -r '.analysis.language') / $(echo "$ANALYZE" | jq -r '.analysis.taskType')"
else
    echo -e "${RED}✗ Analyze endpoint failed${NC}"
    echo "$ANALYZE"
fi
echo ""

# Summary
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}✅ Deployment Complete!${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Smart Router Endpoints:"
echo "  • Health: $API_URL/v1/router/health"
echo "  • Analyze: $API_URL/v1/analyze"
echo "  • Explain: $API_URL/v1/explain"
echo "  • Compare: $API_URL/v1/compare"
echo "  • Auto Route: $API_URL/v1/chat/completions/auto"
echo ""
echo "Run comprehensive tests:"
echo "  bash test-smart-router.sh"
echo ""
