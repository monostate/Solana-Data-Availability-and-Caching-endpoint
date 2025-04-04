#!/bin/bash
set -e

echo "===== Solana RPC Cache Worker Deployment Script ====="

# Check for wrangler
if ! command -v wrangler &> /dev/null; then
    echo "Error: wrangler CLI not found. Please install it with 'npm install -g wrangler'"
    exit 1
fi

# Check logged in status
LOGGED_IN=$(wrangler whoami 2>/dev/null || echo "not logged in")
if [[ $LOGGED_IN == *"not logged in"* ]]; then
    echo "You are not logged in to Cloudflare. Please login first:"
    wrangler login
fi

# R2 bucket creation is now handled by wrangler deploy based on wrangler.jsonc

echo
echo "===== Step 1: Setting up KV Namespace ====="
# For Wrangler 4.0.0, we need to use the correct commands
# First, list existing namespaces
KV_EXISTS=$(wrangler kv namespace list | grep -c "LOOKUP_KV" || echo "0")
if [ "$KV_EXISTS" -eq "0" ]; then
    echo "Creating KV namespace 'LOOKUP_KV'..."
    KV_OUTPUT=$(wrangler kv namespace create LOOKUP_KV)
    echo "$KV_OUTPUT"
    
    # Extract KV ID using pattern matching
    KV_ID=$(echo "$KV_OUTPUT" | grep -o 'id: [^ ]*' | cut -d' ' -f2)
    
    # Create preview KV namespace for development (with --preview flag)
    echo "Creating preview KV namespace..."
    KV_PREVIEW_OUTPUT=$(wrangler kv namespace create LOOKUP_KV --preview)
    echo "$KV_PREVIEW_OUTPUT"
    KV_PREVIEW_ID=$(echo "$KV_PREVIEW_OUTPUT" | grep -o 'id: [^ ]*' | cut -d' ' -f2)
    
    echo "Updating wrangler.jsonc with KV namespace IDs..."
    # Use sed to update the wrangler.jsonc file with the KV namespace IDs
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # macOS
        sed -i '' "s/\"id\": \"YOUR_KV_ID_WILL_BE_POPULATED_BY_DEPLOY_SCRIPT\"/\"id\": \"$KV_ID\"/" wrangler.jsonc
        sed -i '' "s/\"preview_id\": \"YOUR_PREVIEW_KV_ID_WILL_BE_POPULATED_BY_DEPLOY_SCRIPT\"/\"preview_id\": \"$KV_PREVIEW_ID\"/" wrangler.jsonc
    else
        # Linux
        sed -i "s/\"id\": \"YOUR_KV_ID_WILL_BE_POPULATED_BY_DEPLOY_SCRIPT\"/\"id\": \"$KV_ID\"/" wrangler.jsonc
        sed -i "s/\"preview_id\": \"YOUR_PREVIEW_KV_ID_WILL_BE_POPULATED_BY_DEPLOY_SCRIPT\"/\"preview_id\": \"$KV_PREVIEW_ID\"/" wrangler.jsonc
    fi
else
    echo "KV namespace 'LOOKUP_KV' already exists."
    echo "Extracting KV IDs from existing namespaces..."
    
    # Get the JSON output from namespace list, then extract the IDs
    KV_LIST=$(wrangler kv namespace list --json)
    KV_ID=$(echo "$KV_LIST" | grep -o '"id":"[^"]*","title":"LOOKUP_KV"' | cut -d'"' -f4)
    
    # Look for preview namespace
    KV_PREVIEW_ID=$(echo "$KV_LIST" | grep -o '"id":"[^"]*","title":"LOOKUP_KV_preview"' | cut -d'"' -f4)
    
    # Update wrangler.jsonc file
    if [[ -n "$KV_ID" ]]; then
        echo "Found KV ID: $KV_ID"
        if [[ "$OSTYPE" == "darwin"* ]]; then
            # macOS
            sed -i '' "s/\"id\": \"YOUR_KV_ID_WILL_BE_POPULATED_BY_DEPLOY_SCRIPT\"/\"id\": \"$KV_ID\"/" wrangler.jsonc
        else
            # Linux
            sed -i "s/\"id\": \"YOUR_KV_ID_WILL_BE_POPULATED_BY_DEPLOY_SCRIPT\"/\"id\": \"$KV_ID\"/" wrangler.jsonc
        fi
    else
        echo "Warning: Could not find KV ID for LOOKUP_KV. You may need to create it manually."
    fi
    
    if [[ -n "$KV_PREVIEW_ID" ]]; then
        echo "Found KV Preview ID: $KV_PREVIEW_ID"
        if [[ "$OSTYPE" == "darwin"* ]]; then
            # macOS
            sed -i '' "s/\"preview_id\": \"YOUR_PREVIEW_KV_ID_WILL_BE_POPULATED_BY_DEPLOY_SCRIPT\"/\"preview_id\": \"$KV_PREVIEW_ID\"/" wrangler.jsonc
        else
            # Linux
            sed -i "s/\"preview_id\": \"YOUR_PREVIEW_KV_ID_WILL_BE_POPULATED_BY_DEPLOY_SCRIPT\"/\"preview_id\": \"$KV_PREVIEW_ID\"/" wrangler.jsonc
        fi
    else
        echo "Warning: Could not find KV Preview ID. You may need to create it manually."
    fi
fi

echo
echo "===== Step 2: Setting up secrets ====="
echo "Do you want to set up or update the secrets? (y/n)"
read -r SETUP_SECRETS

if [[ $SETUP_SECRETS == "y" || $SETUP_SECRETS == "Y" ]]; then
    echo "Enter your Solana RPC URL."
    echo "RECOMMENDED: Use a dedicated provider like Helius (public RPCs often block Cloudflare)."
    echo "Example Helius URL: https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_API_KEY"
    read -r SOLANA_RPC_URL
    echo "Setting SOLANA_RPC_URL secret..."
    echo "$SOLANA_RPC_URL" | wrangler secret put SOLANA_RPC_URL

    echo "Enter your desired API_KEY (used to authenticate requests to the worker):"
    read -r API_KEY
    echo "Setting API_KEY secret..."
    echo "$API_KEY" | wrangler secret put API_KEY

    echo "Enter your desired SHARED_SECRET (used to authenticate admin endpoints like /admin/metrics):"
    read -r SHARED_SECRET
    echo "Setting SHARED_SECRET secret..."
    echo "$SHARED_SECRET" | wrangler secret put SHARED_SECRET
else
    echo "Skipping secrets setup."
fi

echo
echo "===== Step 3: Deploying Worker ====="
echo "Deploying Solana RPC Cache Worker..."
wrangler deploy

echo
echo "===== Step 4: Custom Domain Setup ====="
echo "Do you want to set up a custom domain for your worker? (y/n)"
read -r SETUP_DOMAIN

if [[ $SETUP_DOMAIN == "y" || $SETUP_DOMAIN == "Y" ]]; then
    echo "Enter your custom domain (e.g., solana-cache.yourdomain.com):"
    read -r CUSTOM_DOMAIN

    # Check if domain is already added to Cloudflare account
    echo "Is this domain already added to your Cloudflare account? (y/n)"
    read -r DOMAIN_ADDED
    
    if [[ $DOMAIN_ADDED == "n" || $DOMAIN_ADDED == "N" ]]; then
        echo "Please add your domain to Cloudflare first:"
        echo "1. Go to Cloudflare dashboard"
        echo "2. Click 'Add site'"
        echo "3. Enter your domain and follow the instructions"
        echo "4. Update nameservers at your domain registrar"
        echo "5. Wait for DNS propagation (can take up to 24-48 hours)"
        echo "After completing these steps, run this script again to add the custom domain to your worker."
    else
        echo "Adding custom domain to your worker..."
        echo "Note: This may fail if the domain is not properly set up in Cloudflare."
        echo "Since you're using Wrangler 4.0.0+, please use the Cloudflare dashboard to add a custom domain:"
        echo "1. Go to Cloudflare dashboard"
        echo "2. Navigate to 'Workers & Pages'"
        echo "3. Find your 'solana-rpc-cache-worker' and click on it"
        echo "4. Go to the 'Triggers' tab"
        echo "5. Under 'Custom Domains', click 'Add Custom Domain'"
        echo "6. Enter '$CUSTOM_DOMAIN' and follow the instructions"
        
        echo "Would you like to open the Cloudflare dashboard now? (y/n)"
        read -r OPEN_DASHBOARD
        if [[ $OPEN_DASHBOARD == "y" || $OPEN_DASHBOARD == "Y" ]]; then
            open "https://dash.cloudflare.com/?to=/:account/workers/services/view/solana-rpc-cache-worker/triggers"
        fi
    fi
fi

echo
echo "===== Deployment Complete ====="
echo "Your Solana RPC Cache Worker is now deployed!"

# Get the worker URL from wrangler
WORKER_URL=$(wrangler deploy --dry-run 2>/dev/null | grep -o 'https://solana-rpc-cache-worker.[^[:space:]]*' || echo "https://solana-rpc-cache-worker.<your-subdomain>.workers.dev")

echo "You can access it at: $WORKER_URL"
echo
echo "To test your deployment, run:"
echo "curl $WORKER_URL/status"
echo
echo "To make Solana RPC calls (replace YOUR_API_KEY), use:"
echo "curl $WORKER_URL/ -X POST -H \"Content-Type: application/json\" -H \"Authorization: Bearer YOUR_API_KEY\" -d '{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccountInfo\",\"params\":[\"4fYNw3dojWmQ4dXtSGE9epjRGy9pFSx62YypT7avPYvA\"]}'"
echo
echo "To check admin metrics (replace YOUR_SHARED_SECRET), use:"
echo "curl $WORKER_URL/admin/metrics -H \"Authorization: Bearer YOUR_SHARED_SECRET\""


if [[ $SETUP_DOMAIN == "y" && $DOMAIN_ADDED == "y" ]]; then
    echo
    echo "Once your custom domain is set up, you can also access your worker at:"
    echo "https://$CUSTOM_DOMAIN"
fi

echo
echo "Thank you for using the Solana RPC Cache Worker template!"
