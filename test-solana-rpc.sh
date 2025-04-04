#!/bin/bash

# Solana Data Availability MCP Test Script
# This script tests various RPC methods with the MCP worker

# Configuration
ENDPOINT="http://localhost:8787"
SHARED_SECRET=""
API_KEY=""

if [ -z "$1" ]; then
  echo "Usage: ./test-solana-rpc.sh <ENDPOINT_URL> [SHARED_SECRET] [API_KEY]"
  echo "Example (local): ./test-solana-rpc.sh http://localhost:8787 your_admin_secret your_api_key"
  exit 1
fi

ENDPOINT="$1"
SHARED_SECRET="$2" # Optional: for admin tests
API_KEY="$3"       # Optional: for RPC tests

echo "Testing Solana RPC Caching with endpoint: $ENDPOINT"
if [ ! -z "$API_KEY" ]; then
  echo "Using API Key: YES"
else
  echo "Using API Key: NO (RPC tests might fail if auth is required)"
fi
if [ ! -z "$SHARED_SECRET" ]; then
  echo "Using Shared Secret: YES (Admin tests will run)"
else
  echo "Using Shared Secret: NO (Admin tests will be skipped)"
fi
echo "=================================================="
echo

# Test status endpoint
echo "Testing status endpoint..."
curl -s "$ENDPOINT/status" | jq
echo
echo

# Test common account
TEST_ACCOUNT="4fYNw3dojWmQ4dXtSGE9epjRGy9pFSx62YypT7avPYvA"

# Test getAccountInfo
# Add API Key header if provided
AUTH_HEADER=""
if [ ! -z "$API_KEY" ]; then
  AUTH_HEADER="-H \"Authorization: Bearer $API_KEY\""
fi

echo "Testing getAccountInfo..."
echo "First request (cache miss expected):"
# Use eval to correctly handle the potentially empty AUTH_HEADER string
eval time curl -s "$ENDPOINT" \
  -X POST \
  -H \"Content-Type: application/json\" \
  $AUTH_HEADER \
  -d "'{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccountInfo\",\"params\":[\"$TEST_ACCOUNT\"]}'" | jq

echo
echo "Second request (cache hit expected):"
eval time curl -s "$ENDPOINT" \
  -X POST \
  -H \"Content-Type: application/json\" \
  $AUTH_HEADER \
  -d "'{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccountInfo\",\"params\":[\"$TEST_ACCOUNT\"]}'" | jq
echo
echo

# Test getLatestBlockhash
echo "Testing getLatestBlockhash..."
eval curl -s "$ENDPOINT" \
  -X POST \
  -H \"Content-Type: application/json\" \
  $AUTH_HEADER \
  -d "'{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getLatestBlockhash\"}'" | jq
echo
echo

# Test getSignaturesForAddress
echo "Testing getSignaturesForAddress..."
eval curl -s "$ENDPOINT" \
  -X POST \
  -H \"Content-Type: application/json\" \
  $AUTH_HEADER \
  -d "'{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getSignaturesForAddress\",\"params\":[\"$TEST_ACCOUNT\",{\"limit\":3}]}'" | jq
echo
echo

# Test batch request
echo "Testing batch request..."
eval curl -s "$ENDPOINT" \
  -X POST \
  -H \"Content-Type: application/json\" \
  $AUTH_HEADER \
  -d "'[{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccountInfo\",\"params\":[\"$TEST_ACCOUNT\"]},{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"getSlot\"}]'" | jq
echo
echo

# Test cache cleanup (requires shared secret)
if [ ! -z "$SHARED_SECRET" ]; then
  echo "Testing cache cleanup..."
  curl -s "$ENDPOINT/admin/cleanup" \
    -H "Authorization: Bearer $SHARED_SECRET" | jq
  echo
  echo
else
  echo "Skipping cache cleanup test (no SHARED_SECRET provided)"
  echo "To test cleanup, provide SHARED_SECRET as the second argument."
  echo
fi

echo "Test complete!"
