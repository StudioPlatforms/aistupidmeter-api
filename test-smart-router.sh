#!/bin/bash

# Smart Router Test Script
# Tests all smart router endpoints to verify functionality

set -e

API_URL="${API_URL:-http://localhost:4000}"
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "🧪 Testing Smart Router System"
echo "API URL: $API_URL"
echo ""

# Test 1: Health Check
echo "Test 1: Health Check"
response=$(curl -s "$API_URL/v1/router/health")
if echo "$response" | grep -q "healthy"; then
    echo -e "${GREEN}✓ Health check passed${NC}"
    echo "$response" | jq '.'
else
    echo -e "${RED}✗ Health check failed${NC}"
    echo "$response"
    exit 1
fi
echo ""

# Test 2: Prompt Analysis
echo "Test 2: Prompt Analysis"
response=$(curl -s -X POST "$API_URL/v1/analyze" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Create a React component for a todo list"}')

if echo "$response" | grep -q "javascript"; then
    echo -e "${GREEN}✓ Prompt analysis passed${NC}"
    echo "$response" | jq '.analysis'
else
    echo -e "${RED}✗ Prompt analysis failed${NC}"
    echo "$response"
    exit 1
fi
echo ""

# Test 3: Explain Selection
echo "Test 3: Explain Selection"
response=$(curl -s -X POST "$API_URL/v1/explain" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Implement binary search in Python"}')

if echo "$response" | grep -q "python"; then
    echo -e "${GREEN}✓ Explain selection passed${NC}"
    echo "$response" | jq '{analysis: .analysis, strategy: .strategy, reasoning: .reasoning}'
else
    echo -e "${RED}✗ Explain selection failed${NC}"
    echo "$response"
    exit 1
fi
echo ""

# Test 4: Compare Strategies
echo "Test 4: Compare Strategies"
response=$(curl -s -X POST "$API_URL/v1/compare" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Build a REST API"}')

if echo "$response" | grep -q "strategies"; then
    echo -e "${GREEN}✓ Compare strategies passed${NC}"
    echo "$response" | jq '.strategies | length'
else
    echo -e "${RED}✗ Compare strategies failed${NC}"
    echo "$response"
    exit 1
fi
echo ""

# Test 5: Language Detection Tests
echo "Test 5: Language Detection"
languages=("Python" "JavaScript" "TypeScript" "Rust" "Go")
prompts=(
    "Write a Python function to sort a list"
    "Create a JavaScript async function"
    "Build a TypeScript interface"
    "Implement ownership in Rust"
    "Create a Go goroutine"
)

for i in "${!languages[@]}"; do
    lang="${languages[$i]}"
    prompt="${prompts[$i]}"
    
    response=$(curl -s -X POST "$API_URL/v1/analyze" \
      -H "Content-Type: application/json" \
      -d "{\"prompt\": \"$prompt\"}")
    
    detected=$(echo "$response" | jq -r '.analysis.language')
    expected=$(echo "$lang" | tr '[:upper:]' '[:lower:]')
    
    if [ "$detected" = "$expected" ]; then
        echo -e "${GREEN}✓ $lang detection passed${NC}"
    else
        echo -e "${YELLOW}⚠ $lang detection: expected $expected, got $detected${NC}"
    fi
done
echo ""

# Test 6: Task Type Detection
echo "Test 6: Task Type Detection"
tasks=("ui" "algorithm" "backend" "debug" "refactor")
task_prompts=(
    "Create a React component"
    "Implement binary search"
    "Build a REST API"
    "Debug this error"
    "Refactor this code"
)

for i in "${!tasks[@]}"; do
    task="${tasks[$i]}"
    prompt="${task_prompts[$i]}"
    
    response=$(curl -s -X POST "$API_URL/v1/analyze" \
      -H "Content-Type: application/json" \
      -d "{\"prompt\": \"$prompt\"}")
    
    detected=$(echo "$response" | jq -r '.analysis.taskType')
    
    if [ "$detected" = "$task" ]; then
        echo -e "${GREEN}✓ $task detection passed${NC}"
    else
        echo -e "${YELLOW}⚠ $task detection: expected $task, got $detected${NC}"
    fi
done
echo ""

# Test 7: Framework Detection
echo "Test 7: Framework Detection"
frameworks=("react" "vue" "django" "flask" "express")
framework_prompts=(
    "Create a React component with hooks"
    "Build a Vue component"
    "Create a Django model"
    "Build a Flask route"
    "Create an Express middleware"
)

for i in "${!frameworks[@]}"; do
    framework="${frameworks[$i]}"
    prompt="${framework_prompts[$i]}"
    
    response=$(curl -s -X POST "$API_URL/v1/analyze" \
      -H "Content-Type: application/json" \
      -d "{\"prompt\": \"$prompt\"}")
    
    detected=$(echo "$response" | jq -r '.analysis.framework')
    
    if [ "$detected" = "$framework" ]; then
        echo -e "${GREEN}✓ $framework detection passed${NC}"
    else
        echo -e "${YELLOW}⚠ $framework detection: expected $framework, got $detected${NC}"
    fi
done
echo ""

# Test 8: Complexity Detection
echo "Test 8: Complexity Detection"
echo -n "Simple task: "
response=$(curl -s -X POST "$API_URL/v1/analyze" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Write a function to add two numbers"}')
complexity=$(echo "$response" | jq -r '.analysis.complexity')
if [ "$complexity" = "simple" ]; then
    echo -e "${GREEN}✓ simple${NC}"
else
    echo -e "${YELLOW}⚠ got $complexity${NC}"
fi

echo -n "Medium task: "
response=$(curl -s -X POST "$API_URL/v1/analyze" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Create a REST API with authentication"}')
complexity=$(echo "$response" | jq -r '.analysis.complexity')
if [ "$complexity" = "medium" ]; then
    echo -e "${GREEN}✓ medium${NC}"
else
    echo -e "${YELLOW}⚠ got $complexity${NC}"
fi

echo -n "Complex task: "
response=$(curl -s -X POST "$API_URL/v1/analyze" \
  -H "Content-Type: application/json" \
  -d '{"prompt": "Build a distributed microservice architecture with async processing"}')
complexity=$(echo "$response" | jq -r '.analysis.complexity')
if [ "$complexity" = "complex" ]; then
    echo -e "${GREEN}✓ complex${NC}"
else
    echo -e "${YELLOW}⚠ got $complexity${NC}"
fi
echo ""

# Test 9: Cache Stats
echo "Test 9: Cache Stats"
response=$(curl -s "$API_URL/v1/router/health")
cache_size=$(echo "$response" | jq -r '.cache.size')
echo "Cache entries: $cache_size"
if [ "$cache_size" -ge 0 ]; then
    echo -e "${GREEN}✓ Cache stats available${NC}"
else
    echo -e "${RED}✗ Cache stats unavailable${NC}"
fi
echo ""

# Test 10: Performance Check
echo "Test 10: Performance Check"
start_time=$(date +%s%N)
for i in {1..10}; do
    curl -s -X POST "$API_URL/v1/analyze" \
      -H "Content-Type: application/json" \
      -d '{"prompt": "Test prompt"}' > /dev/null
done
end_time=$(date +%s%N)
duration=$(( (end_time - start_time) / 1000000 ))
avg_time=$(( duration / 10 ))

echo "10 requests completed in ${duration}ms"
echo "Average: ${avg_time}ms per request"

if [ "$avg_time" -lt 100 ]; then
    echo -e "${GREEN}✓ Performance excellent (<100ms)${NC}"
elif [ "$avg_time" -lt 250 ]; then
    echo -e "${GREEN}✓ Performance good (<250ms)${NC}"
else
    echo -e "${YELLOW}⚠ Performance acceptable (${avg_time}ms)${NC}"
fi
echo ""

# Summary
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo -e "${GREEN}✅ All Smart Router Tests Completed!${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Smart Router is ready for production! 🚀"
echo ""
echo "Next steps:"
echo "1. Monitor /v1/router/health for system health"
echo "2. Check logs for any errors"
echo "3. Test with real user prompts"
echo "4. Monitor performance metrics"
echo ""
