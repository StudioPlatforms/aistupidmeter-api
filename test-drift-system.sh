#!/bin/bash

# PRODUCTION-READY: Drift System Integration Test
# Tests all drift endpoints, caching, and error handling

echo "🧪 Testing Drift Detection System"
echo "=================================="
echo ""

API_URL="http://localhost:4000"
ERRORS=0

# Color codes
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test helper function
test_endpoint() {
    local name="$1"
    local url="$2"
    local expected_status="$3"
    
    echo -n "Testing $name... "
    
    response=$(curl -s -w "\n%{http_code}" "$url")
    status_code=$(echo "$response" | tail -n 1)
    body=$(echo "$response" | head -n -1)
    
    if [ "$status_code" = "$expected_status" ]; then
        echo -e "${GREEN}✓ PASS${NC} (HTTP $status_code)"
        echo "$body" | jq '.' > /dev/null 2>&1
        if [ $? -ne 0 ]; then
            echo -e "${YELLOW}⚠ Warning: Response is not valid JSON${NC}"
        fi
        return 0
    else
        echo -e "${RED}✗ FAIL${NC} (Expected $expected_status, got $status_code)"
        echo "Response: $body"
        ERRORS=$((ERRORS + 1))
        return 1
    fi
}

# Test 1: Health check
echo "Test 1: API Health Check"
echo "------------------------"
test_endpoint "Health" "$API_URL/health" "200"
echo ""

# Test 2: Drift health endpoint
echo "Test 2: Drift System Health"
echo "---------------------------"
test_endpoint "Drift Health" "$API_URL/api/drift/health" "200"
echo ""

# Test 3: Individual drift signature (should be slow first time)
echo "Test 3: Individual Drift Signature"
echo "-----------------------------------"
echo "Testing model ID 42 (gemini-2.0-flash-exp)..."
start_time=$(date +%s%3N)
test_endpoint "Drift Signature" "$API_URL/api/drift/signature/42" "200"
end_time=$(date +%s%3N)
duration=$((end_time - start_time))
echo "Duration: ${duration}ms"
if [ $duration -lt 5000 ]; then
    echo -e "${GREEN}✓ Fast response (<5s)${NC}"
else
    echo -e "${YELLOW}⚠ Slow response (>${duration}ms) - may be computing${NC}"
fi
echo ""

# Test 4: Same signature again (should be cached and fast)
echo "Test 4: Cached Drift Signature"
echo "-------------------------------"
start_time=$(date +%s%3N)
test_endpoint "Cached Signature" "$API_URL/api/drift/signature/42" "200"
end_time=$(date +%s%3N)
duration=$((end_time - start_time))
echo "Duration: ${duration}ms"
if [ $duration -lt 200 ]; then
    echo -e "${GREEN}✓ Cache hit (<200ms)${NC}"
else
    echo -e "${YELLOW}⚠ Possible cache miss (${duration}ms)${NC}"
fi
echo ""

# Test 5: Batch endpoint (most important!)
echo "Test 5: Batch Drift Endpoint"
echo "-----------------------------"
echo "Fetching all models in one request..."
start_time=$(date +%s%3N)
response=$(curl -s -w "\n%{http_code}" "$API_URL/api/drift/batch")
status_code=$(echo "$response" | tail -n 1)
body=$(echo "$response" | head -n -1)
end_time=$(date +%s%3N)
duration=$((end_time - start_time))

if [ "$status_code" = "200" ]; then
    echo -e "${GREEN}✓ PASS${NC} (HTTP $status_code)"
    echo "Duration: ${duration}ms"
    
    # Parse response
    total=$(echo "$body" | jq -r '.meta.total')
    cached=$(echo "$body" | jq -r '.meta.cached')
    computed=$(echo "$body" | jq -r '.meta.computed')
    errors=$(echo "$body" | jq -r '.meta.errors')
    
    echo "Results:"
    echo "  Total models: $total"
    echo "  Cached: $cached"
    echo "  Computed: $computed"
    echo "  Errors: $errors"
    
    if [ "$errors" -gt 5 ]; then
        echo -e "${YELLOW}⚠ Warning: High error rate${NC}"
    fi
    
    if [ $duration -lt 10000 ]; then
        echo -e "${GREEN}✓ Good batch performance (<10s)${NC}"
    else
        echo -e "${YELLOW}⚠ Slow batch response (${duration}ms)${NC}"
    fi
else
    echo -e "${RED}✗ FAIL${NC} (HTTP $status_code)"
    echo "Response: $body"
    ERRORS=$((ERRORS + 1))
fi
echo ""

# Test 6: Drift status endpoint
echo "Test 6: Drift Status Aggregation"
echo "---------------------------------"
test_endpoint "Drift Status" "$API_URL/api/drift/status" "200"
echo ""

# Test 7: Drift metrics endpoint
echo "Test 7: Drift System Metrics"
echo "-----------------------------"
response=$(curl -s "$API_URL/api/drift/metrics")
echo "$response" | jq '.'
cache_pct=$(echo "$response" | jq -r '.data.cachePercentage')
echo "Cache coverage: $cache_pct"
echo ""

# Test 8: Invalid model ID (error handling)
echo "Test 8: Error Handling"
echo "----------------------"
test_endpoint "Invalid Model" "$API_URL/api/drift/signature/99999" "200"
echo ""

# Test 9: Manual precompute trigger (optional - commented out)
echo "Test 9: Manual Pre-computation"
echo "-------------------------------"
echo "Skipping (use: curl -X POST $API_URL/api/drift/precompute)"
echo ""

# Summary
echo "=================================="
echo "Test Summary"
echo "=================================="
if [ $ERRORS -eq 0 ]; then
    echo -e "${GREEN}✓ All tests passed!${NC}"
    echo ""
    echo "Next steps:"
    echo "1. Monitor API logs: tail -f /path/to/api.log"
    echo "2. Check drift scheduler: grep 'Drift pre-computation' /path/to/api.log"
    echo "3. Deploy to production"
    exit 0
else
    echo -e "${RED}✗ $ERRORS test(s) failed${NC}"
    echo ""
    echo "Troubleshooting:"
    echo "1. Check if API is running: curl $API_URL/health"
    echo "2. Check Redis: redis-cli ping"
    echo "3. Check database: sqlite3 data.db 'SELECT COUNT(*) FROM scores;'"
    echo "4. Review API logs for errors"
    exit 1
fi
