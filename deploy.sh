#!/bin/bash
set -e

echo "===== Solana RPC Cache Worker Deployment Script ====="

# --- Configuration & State Variables ---
DEFAULT_PROJECT_NAME="solana-rpc-cache-worker"
PROJECT_NAME=""
WORKER_NAME=""
KV_NAMESPACE_TITLE=""
R2_BUCKET_NAME=""
KV_ID=""
KV_PREVIEW_ID=""
SOLANA_RPC_URL_SECRET=""
API_KEY_SECRET=""
SHARED_SECRET_SECRET=""
KV_BINDING_NAME_SECRET=""

# --- Helper Functions ---

# Function to load existing state from .dev.vars
load_state() {
    echo "Checking for existing configuration in .dev.vars..."
    if [ -f ".dev.vars" ]; then
        PROJECT_NAME=$(grep -E '^PROJECT_NAME=' .dev.vars | cut -d '=' -f2)
        WORKER_NAME=$(grep -E '^WORKER_NAME=' .dev.vars | cut -d '=' -f2)
        KV_NAMESPACE_TITLE=$(grep -E '^KV_BINDING_NAME=' .dev.vars | cut -d '=' -f2)
        R2_BUCKET_NAME=$(grep -E '^R2_BUCKET_NAME=' .dev.vars | cut -d '=' -f2)
        KV_ID=$(grep -E '^KV_ID=' .dev.vars | cut -d '=' -f2)
        KV_PREVIEW_ID=$(grep -E '^KV_PREVIEW_ID=' .dev.vars | cut -d '=' -f2)
        # Load secrets too, in case user wants to skip setting them
        SOLANA_RPC_URL_SECRET=$(grep -E '^SOLANA_RPC_URL=' .dev.vars | cut -d '=' -f2-) # Get everything after '='
        API_KEY_SECRET=$(grep -E '^API_KEY=' .dev.vars | cut -d '=' -f2)
        SHARED_SECRET_SECRET=$(grep -E '^SHARED_SECRET=' .dev.vars | cut -d '=' -f2)
        KV_BINDING_NAME_SECRET=$(grep -E '^KV_BINDING_NAME=' .dev.vars | cut -d '=' -f2) # Same as KV_NAMESPACE_TITLE

        if [ -n "$PROJECT_NAME" ]; then
            echo "Found existing configuration for project: $PROJECT_NAME"
            return 0 # State loaded
        fi
    fi
    echo "No existing configuration found in .dev.vars."
    return 1 # No state loaded
}

# Function to save state to .dev.vars
save_state() {
    echo "Saving configuration state to .dev.vars..."
    # Ensure .dev.vars exists, create if not
    touch .dev.vars

    # Remove old state lines if they exist
    sed -i.bak '/^# --- Deployment Script State/d' .dev.vars # Remove header
    sed -i.bak '/^PROJECT_NAME=/d' .dev.vars
    sed -i.bak '/^WORKER_NAME=/d' .dev.vars
    sed -i.bak '/^KV_BINDING_NAME=/d' .dev.vars
    sed -i.bak '/^KV_ID=/d' .dev.vars
    sed -i.bak '/^KV_PREVIEW_ID=/d' .dev.vars
    sed -i.bak '/^R2_BUCKET_NAME=/d' .dev.vars
    rm -f .dev.vars.bak # Clean up backup file

    # Append new state
    echo "" >> .dev.vars # Add a newline for separation
    echo "# --- Deployment Script State (Saved by deploy.sh after successful run) ---" >> .dev.vars
    echo "PROJECT_NAME=$PROJECT_NAME" >> .dev.vars
    echo "WORKER_NAME=$WORKER_NAME" >> .dev.vars
    echo "KV_BINDING_NAME=$KV_NAMESPACE_TITLE" >> .dev.vars
    echo "KV_ID=$KV_ID" >> .dev.vars
    echo "KV_PREVIEW_ID=$KV_PREVIEW_ID" >> .dev.vars
    echo "R2_BUCKET_NAME=$R2_BUCKET_NAME" >> .dev.vars

    # Also update API_KEY and SHARED_SECRET if they were generated/set
     if [ -n "$API_KEY_SECRET" ]; then
         if [[ "$OSTYPE" == "darwin"* ]]; then # macOS sed
            sed -i '' "s|^API_KEY=.*|API_KEY=$API_KEY_SECRET|" .dev.vars
        else # Linux sed
             sed -i "s|^API_KEY=.*|API_KEY=$API_KEY_SECRET|" .dev.vars
        fi
    fi
     if [ -n "$SHARED_SECRET_SECRET" ]; then
         if [[ "$OSTYPE" == "darwin"* ]]; then # macOS sed
            sed -i '' "s|^SHARED_SECRET=.*|SHARED_SECRET=$SHARED_SECRET_SECRET|" .dev.vars
        else # Linux sed
             sed -i "s|^SHARED_SECRET=.*|SHARED_SECRET=$SHARED_SECRET_SECRET|" .dev.vars
        fi
    fi
    echo "Configuration saved."
}

# --- Main Script Logic ---

# Check for wrangler first
if ! command -v wrangler &> /dev/null; then
    echo "Error: wrangler CLI not found. Please install it with 'pnpm install -g wrangler'"
    exit 1
fi

# Try loading existing state FIRST
if load_state; then
    # State loaded, confirm reuse or start fresh
    echo "Existing configuration found for project '$PROJECT_NAME'."
    read -p "Do you want to reuse this configuration? (y/n) [y]: " REUSE_CONFIG
    REUSE_CONFIG=${REUSE_CONFIG:-y}
    if [[ $REUSE_CONFIG == "y" || $REUSE_CONFIG == "Y" ]]; then
        echo "Reusing existing configuration."
        # Ensure derived names are set correctly from loaded state
        WORKER_NAME="$PROJECT_NAME"
        KV_NAMESPACE_TITLE="$PROJECT_NAME-kv"
        R2_BUCKET_NAME="$PROJECT_NAME-cache"
    else
        echo "Starting fresh configuration..."
        PROJECT_NAME="" # Clear loaded state
    fi
fi

# If no project name (either not loaded or user chose not to reuse)
if [ -z "$PROJECT_NAME" ]; then
    read -p "Enter a unique name for this new deployment [$DEFAULT_PROJECT_NAME]: " PROJECT_NAME
    PROJECT_NAME=${PROJECT_NAME:-$DEFAULT_PROJECT_NAME}
    # Basic validation for project name
    while ! [[ "$PROJECT_NAME" =~ ^[a-z0-9][a-z0-9-]*[a-z0-9]$ ]]; do
        echo "Error: Project name must be alphanumeric, lowercase, and can contain dashes (but not start/end with them)."
        read -p "Please enter a valid project name: " PROJECT_NAME
        if [ -z "$PROJECT_NAME" ]; then echo "Exiting."; exit 1; fi
    done
    echo "Using new project name: $PROJECT_NAME"
    # Define resource names based on project name
    KV_NAMESPACE_TITLE="${PROJECT_NAME}-kv"
    R2_BUCKET_NAME="${PROJECT_NAME}-cache"
    WORKER_NAME="$PROJECT_NAME"
    # Clear potentially loaded IDs
    KV_ID=""
    KV_PREVIEW_ID=""
fi

# Update wrangler.jsonc with dynamic names *before* login check
echo
echo "===== Step 1: Configure wrangler.jsonc (Names) ====="
echo "Overwriting wrangler.jsonc with worker name ('$WORKER_NAME'), KV binding ('$KV_NAMESPACE_TITLE'), and R2 bucket name ('$R2_BUCKET_NAME')..."
# Overwrite wrangler.jsonc with the correct names using a heredoc
cat << EOF > wrangler.jsonc
/**
 * For more details on how to configure Wrangler, refer to:
 * https://developers.cloudflare.com/workers/wrangler/configuration/
 */
{
	"\$schema": "node_modules/wrangler/config-schema.json",
	"name": "$WORKER_NAME", // Updated
	"main": "src/index.ts",
	"compatibility_date": "2025-03-13",
	"observability": {
		"enabled": true
	},
	/**
	 * R2 Bucket Configuration
	 * https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2-bindings
	 */
	"r2_buckets": [
		{
			"binding": "DATA_BUCKET", // Binding name remains constant in code
			"bucket_name": "$R2_BUCKET_NAME" // Updated
		}
	],
	/**
	 * KV Namespace Configuration
	 * https://developers.cloudflare.com/workers/wrangler/configuration/#kv-namespaces
	 */
	"kv_namespaces": [
		{
			"binding": "$KV_NAMESPACE_TITLE", // Updated
			// ID and preview_id will be populated by the deploy.sh script
			"id": "YOUR_KV_ID_WILL_BE_POPULATED_BY_DEPLOY_SCRIPT", // Placeholder
			"preview_id": "YOUR_PREVIEW_KV_ID_WILL_BE_POPULATED_BY_DEPLOY_SCRIPT" // Placeholder
		}
	],
	/**
	 * Smart Placement
	 * Docs: https://developers.cloudflare.com/workers/configuration/smart-placement/#smart-placement
	 */
	"placement": { "mode": "smart" },

	/**
	 * Bindings
	 * Bindings allow your Worker to interact with resources on the Cloudflare Developer Platform, including
	 * databases, object storage, AI inference, real-time communication and more.
	 * https://developers.cloudflare.com/workers/runtime-apis/bindings/
	 */

	/**
	 * Environment Variables
	 * https://developers.cloudflare.com/workers/wrangler/configuration/#environment-variables
	 */
	"vars": {
		"CACHE_TTL_MINUTES": "5" // Note: Default TTL is now set higher in src/index.ts
		// API_KEY should ONLY be a secret, not a plain text var. Removed from here.
	},
	/**
	 * Note: Use secrets to store sensitive data.
	 * API_KEY and SHARED_SECRET should be added via wrangler secret:
	 * Run: wrangler secret put API_KEY
	 * Run: wrangler secret put SHARED_SECRET
	 * https://developers.cloudflare.com/workers/configuration/secrets/
	 */

	// Removed: "assets" section

	/**
	 * Service Bindings (communicate between multiple Workers)
	 * https://developers.cloudflare.com/workers/wrangler/configuration/#service-bindings
	 */
	// "services": [{ "binding": "MY_SERVICE", "service": "my-service" }]
}
EOF
echo "wrangler.jsonc overwritten with dynamic names."
sleep 1 # Add a short delay to ensure filesystem sync

# Add verification step
echo "Verifying wrangler.jsonc update..."
# Use grep -E to match the line containing the name, allowing for whitespace and no trailing comma
MATCHED_LINE=$(grep -E "^\s*\"name\": \"$WORKER_NAME\"" wrangler.jsonc || echo "GREP_FAILED")
if [[ "$MATCHED_LINE" == "GREP_FAILED" ]]; then
    echo "Error: Failed to verify update of 'name' in wrangler.jsonc!"
    echo "Expected name: $WORKER_NAME"
    echo "Current content of wrangler.jsonc:"
    cat wrangler.jsonc
    exit 1
fi
echo "Verification successful. Matched line: $MATCHED_LINE"

# Removed explicit login check block - Wrangler will prompt if needed by subsequent commands.

echo
echo "===== Step 2: Setting up KV Namespace ====="
# Only create if KV_ID is not already set (from loaded state)
if [ -z "$KV_ID" ]; then
    echo "Attempting to create KV namespace '$KV_NAMESPACE_TITLE'..."
    if KV_OUTPUT=$(wrangler kv namespace create "$KV_NAMESPACE_TITLE" 2>&1); then
        echo "Successfully created '$KV_NAMESPACE_TITLE'."
        echo "$KV_OUTPUT"
        KV_ID=$(echo "$KV_OUTPUT" | grep '"id":' | sed -E 's/.*"id": "([^"]+)".*/\1/')
        if [ -z "$KV_ID" ]; then
           echo "Error: Failed to parse ID from create output. Please check manually."
           exit 1
        fi
    else
        if echo "$KV_OUTPUT" | grep -q "already exists"; then
             echo "Error: KV namespace '$KV_NAMESPACE_TITLE' already exists but was not found in .dev.vars."
             echo "This script expects to create a new namespace or reuse one defined in .dev.vars."
             echo "Please delete the existing namespace or update .dev.vars and wrangler.jsonc manually."
             exit 1
        else
            echo "Error: Failed to create KV namespace '$KV_NAMESPACE_TITLE'."
            echo "$KV_OUTPUT" # Print the actual error
            exit 1
        fi
    fi
else
    echo "Using existing KV Namespace ID from .dev.vars: $KV_ID"
fi

# Only create preview if KV_PREVIEW_ID is not already set
if [ -z "$KV_PREVIEW_ID" ]; then
    echo "Attempting to create KV namespace '$KV_NAMESPACE_TITLE' (preview)..."
    if KV_PREVIEW_OUTPUT=$(wrangler kv namespace create "$KV_NAMESPACE_TITLE" --preview 2>&1); then
        echo "Successfully created '$KV_NAMESPACE_TITLE' (preview)."
        echo "$KV_PREVIEW_OUTPUT"
        KV_PREVIEW_ID=$(echo "$KV_PREVIEW_OUTPUT" | grep '"id":' | sed -E 's/.*"id": "([^"]+)".*/\1/')
         if [ -z "$KV_PREVIEW_ID" ]; then
           echo "Warning: Failed to parse ID from preview create output."
        fi
    else
         if echo "$KV_PREVIEW_OUTPUT" | grep -q "already exists"; then
            echo "'$KV_NAMESPACE_TITLE' (preview) already exists but was not found in .dev.vars. Will attempt to use."
            # Try to find existing preview ID
            KV_LIST_OUTPUT=$(wrangler kv namespace list)
            KV_PREVIEW_ID=$(echo "$KV_LIST_OUTPUT" | grep "$KV_NAMESPACE_TITLE" | grep 'preview' | awk '{ for(i=1; i<=NF; i++) if ($i == "id:") print $(i+1) }')
            if [ -z "$KV_PREVIEW_ID" ]; then
                echo "Warning: Could not automatically find ID for existing '$KV_NAMESPACE_TITLE' (preview)."
            else
                echo "Found existing Preview KV ID: $KV_PREVIEW_ID"
            fi
        else
            echo "Warning: Failed to create KV namespace '$KV_NAMESPACE_TITLE' (preview)."
            echo "$KV_PREVIEW_OUTPUT" # Print the actual error
        fi
    fi
else
     echo "Using existing KV Namespace Preview ID from .dev.vars: $KV_PREVIEW_ID"
fi

# Update wrangler.jsonc with the final IDs using simple placeholder replacement
echo "Updating wrangler.jsonc with KV namespace IDs..."
if [[ -n "$KV_ID" ]]; then
     if [[ "$OSTYPE" == "darwin"* ]]; then # macOS sed
        sed -i '' "s|\"id\": \"YOUR_KV_ID_WILL_BE_POPULATED_BY_DEPLOY_SCRIPT\"|\"id\": \"$KV_ID\"|" wrangler.jsonc
    else # Linux sed
        sed -i "s|\"id\": \"YOUR_KV_ID_WILL_BE_POPULATED_BY_DEPLOY_SCRIPT\"|\"id\": \"$KV_ID\"|" wrangler.jsonc
    fi # Correctly closing the inner OS check
    echo "Updated production KV ID in wrangler.jsonc."
else
    echo "Error: Production KV ID is missing. Cannot update wrangler.jsonc."
    exit 1
fi

if [[ -n "$KV_PREVIEW_ID" ]]; then
     if [[ "$OSTYPE" == "darwin"* ]]; then # macOS sed
        sed -i '' "s|\"preview_id\": \"YOUR_PREVIEW_KV_ID_WILL_BE_POPULATED_BY_DEPLOY_SCRIPT\"|\"preview_id\": \"$KV_PREVIEW_ID\"|" wrangler.jsonc
    else # Linux sed
        sed -i "s|\"preview_id\": \"YOUR_PREVIEW_KV_ID_WILL_BE_POPULATED_BY_DEPLOY_SCRIPT\"|\"preview_id\": \"$KV_PREVIEW_ID\"|" wrangler.jsonc
    fi # Correctly closing the inner OS check
     echo "Updated preview KV ID in wrangler.jsonc."
else
     echo "Warning: Preview KV ID not found or parsing failed. wrangler.jsonc preview_id not updated."
fi


echo
echo "===== Step 3: Setting up R2 Bucket ====="
echo "Attempting to create R2 bucket '$R2_BUCKET_NAME' (if it doesn't exist)..."
# Removed --jurisdiction=auto flag
wrangler r2 bucket create "$R2_BUCKET_NAME" || echo "R2 Bucket '$R2_BUCKET_NAME' likely already exists."


echo
echo "===== Step 4: Setting up secrets ====="
echo "Secrets (API_KEY, SHARED_SECRET) will be automatically generated."
echo "Do you want to set/update secrets now? (y/n)"
read -r SETUP_SECRETS

GENERATED_API_KEY=""
GENERATED_SHARED_SECRET=""

if [[ $SETUP_SECRETS == "y" || $SETUP_SECRETS == "Y" ]]; then
    # Set Solana RPC URL
    echo "Enter your Solana RPC URL."
    echo "RECOMMENDED: Use a dedicated provider like Helius (public RPCs often block Cloudflare)."
    echo "Example Helius URL: https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_API_KEY"
    read -r SOLANA_RPC_URL
    echo "Setting SOLANA_RPC_URL secret for worker '$WORKER_NAME'..."
    # Use input redirection and add explicit error check
    wrangler secret put SOLANA_RPC_URL --name "$WORKER_NAME" <<< "$SOLANA_RPC_URL"
    if [ $? -ne 0 ]; then echo "Error: Failed to set SOLANA_RPC_URL secret."; exit 1; fi # Add check and exit

    # Generate and set API_KEY
    echo "Generating API_KEY for worker '$WORKER_NAME'..."
    GENERATED_API_KEY=$(openssl rand -base64 32)
    echo "--------------------------------------------------"
    echo "Generated API_KEY: $GENERATED_API_KEY"
    echo "(Use this key in 'Authorization: Bearer <key>' header for requests)"
    echo "--------------------------------------------------"
    echo "Setting API_KEY secret for worker '$WORKER_NAME'..."
    # Use input redirection and add explicit error check
    wrangler secret put API_KEY --name "$WORKER_NAME" <<< "$GENERATED_API_KEY"
    if [ $? -ne 0 ]; then
        echo "Error: Initial attempt to set API_KEY secret failed."
        # Don't exit immediately, let the loop try again
    fi

    # Loop to verify and retry setting API_KEY
    API_KEY_SET=false
    RETRY_COUNT=0
    MAX_RETRIES=5
    while [ "$API_KEY_SET" = false ] && [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
        echo "Verifying API_KEY secret (Attempt $((RETRY_COUNT + 1))/$MAX_RETRIES)..."
        SECRET_LIST_OUTPUT=$(wrangler secret list --name "$WORKER_NAME")
        if echo "$SECRET_LIST_OUTPUT" | grep -q '"name": "API_KEY"'; then
            echo "✅ API_KEY secret confirmed in list."
            API_KEY_SET=true
        else
            echo "⚠️ API_KEY not found in list. Retrying in 5 seconds..."
            RETRY_COUNT=$((RETRY_COUNT + 1))
            sleep 5
            if [ $RETRY_COUNT -lt $MAX_RETRIES ]; then
                 echo "Retrying: wrangler secret put API_KEY --name \"$WORKER_NAME\""
                 wrangler secret put API_KEY --name "$WORKER_NAME" <<< "$GENERATED_API_KEY"
                 if [ $? -ne 0 ]; then
                     echo "Error: Retry attempt to set API_KEY secret failed."
                 fi
            fi
        fi
    done

    if [ "$API_KEY_SET" = false ]; then
        echo "Error: Failed to confirm API_KEY secret was set after $MAX_RETRIES attempts."
        exit 1
    fi


    # Generate and set SHARED_SECRET
    echo "Generating SHARED_SECRET for worker '$WORKER_NAME'..."
    GENERATED_SHARED_SECRET=$(openssl rand -base64 32)
     echo "--------------------------------------------------"
    echo "Generated SHARED_SECRET: $GENERATED_SHARED_SECRET"
    echo "(Use this key in 'Authorization: Bearer <key>' header for /admin requests)"
    echo "--------------------------------------------------"
    echo "Setting SHARED_SECRET secret for worker '$WORKER_NAME'..."
    # Use input redirection and add explicit error check
    wrangler secret put SHARED_SECRET --name "$WORKER_NAME" <<< "$GENERATED_SHARED_SECRET"
    if [ $? -ne 0 ]; then echo "Error: Failed to set SHARED_SECRET secret."; exit 1; fi # Add check and exit

    # Set KV_BINDING_NAME secret (needed by the worker code)
    echo "Setting KV_BINDING_NAME secret for worker '$WORKER_NAME'..."
    # Use input redirection and add explicit error check
    wrangler secret put KV_BINDING_NAME --name "$WORKER_NAME" <<< "$KV_NAMESPACE_TITLE"
    if [ $? -ne 0 ]; then echo "Error: Failed to set KV_BINDING_NAME secret."; exit 1; fi # Add check and exit

    # Optionally update .dev.vars
    echo "Do you want to update your local .dev.vars file with these generated secrets for local testing? (y/n)"
    read -r UPDATE_DEV_VARS
    if [[ $UPDATE_DEV_VARS == "y" || $UPDATE_DEV_VARS == "Y" ]]; then
        if [ -f ".dev.vars" ]; then
            echo "Updating .dev.vars..."
            # Use a temporary delimiter for sed to handle base64 characters
            if [[ "$OSTYPE" == "darwin"* ]]; then # macOS sed
                sed -i '' "s|^API_KEY=.*|API_KEY=$GENERATED_API_KEY|" .dev.vars
                sed -i '' "s|^SHARED_SECRET=.*|SHARED_SECRET=$GENERATED_SHARED_SECRET|" .dev.vars
            else # Linux sed
                 sed -i "s|^API_KEY=.*|API_KEY=$GENERATED_API_KEY|" .dev.vars
                 sed -i "s|^SHARED_SECRET=.*|SHARED_SECRET=$GENERATED_SHARED_SECRET|" .dev.vars
            fi
            echo ".dev.vars updated."
        else
            echo "Warning: .dev.vars file not found. Skipping update."
        fi
    fi
else
    echo "Skipping secrets setup."
fi

# Removed sleep 15 - verification loop handles potential delays

echo
echo "===== Step 5: Deploying Worker ====="
echo "Deploying Worker '$WORKER_NAME'..."
# Deploy using the updated wrangler.jsonc and capture output
DEPLOY_OUTPUT=$(wrangler deploy)
echo "$DEPLOY_OUTPUT" # Show deployment output

# Check if deploy command failed (exit code non-zero), though set -e should handle this
if [ $? -ne 0 ]; then
    echo "Error: wrangler deploy command failed."
    exit 1
fi

echo
echo "===== Step 6: Custom Domain Setup ====="
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
        echo "3. Find your '$WORKER_NAME' worker and click on it"
        echo "4. Go to the 'Triggers' tab"
        echo "5. Under 'Custom Domains', click 'Add Custom Domain'"
        echo "6. Enter '$CUSTOM_DOMAIN' and follow the instructions"
        
        echo "Would you like to open the Cloudflare dashboard now? (y/n)"
        read -r OPEN_DASHBOARD
        if [[ $OPEN_DASHBOARD == "y" || $OPEN_DASHBOARD == "Y" ]]; then
            # Construct the dashboard URL dynamically
            ACCOUNT_ID=$(wrangler whoami | grep 'Account ID' | awk '{print $NF}')
            if [[ -n "$ACCOUNT_ID" ]]; then
                 open "https://dash.cloudflare.com/?to=/:$ACCOUNT_ID/workers/services/view/$WORKER_NAME/triggers"
            else
                echo "Could not determine Account ID automatically. Please navigate manually."
            fi
        fi
    fi
fi

echo
echo "===== Deployment Complete ====="
echo "Your Worker '$WORKER_NAME' is now deployed!"

# Get the worker URL from the captured deploy output
echo "Retrieving deployment details from output..."
# Try to parse the URL from the captured output
WORKER_URL=$(echo "$DEPLOY_OUTPUT" | grep -o 'https://[^ ]*\.workers\.dev')

if [[ -z "$WORKER_URL" ]]; then
    # Fallback if parsing failed - construct based on worker name
    WORKER_URL="https://$WORKER_NAME.<your-subdomain>.workers.dev"
    echo "Could not automatically determine worker URL. It should be available at approximately:"
    echo "$WORKER_URL"
else
     echo "You can access it at: $WORKER_URL"
fi

echo
echo "===== Verifying Deployment ====="
echo "Attempting to fetch status from deployed worker..."
# Add a short delay to allow deployment to propagate
sleep 5 
if curl -sf "$WORKER_URL/status" > /dev/null; then
    echo "✅ Deployment verified successfully! Worker is responding at $WORKER_URL/status"
else
    echo "⚠️ Warning: Could not automatically verify worker status at $WORKER_URL/status."
    echo "   Deployment might still be in progress, or there might be an issue."
    echo "   Please check the Cloudflare dashboard and try accessing the URL manually."
fi

echo
echo "Further testing commands:"
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

# Optionally: Reset wrangler.jsonc back to placeholders for next run
# echo "Resetting wrangler.jsonc to placeholder values..."
# cp wrangler.jsonc.template wrangler.jsonc # If a template file exists
# Or use sed again:
# if [[ "$OSTYPE" == "darwin"* ]]; then # macOS sed
#     sed -i '' -E "s|^(\s*\"name\":\s*)\"[^\"]*\"|\1\"PLACEHOLDER_WORKER_NAME\"|" wrangler.jsonc
#     sed -i '' -E "/\"kv_namespaces\": \[/,/\]/ s|(\"binding\":\s*)\"[^\"]*\"|\1\"PLACEHOLDER_KV_BINDING_NAME\"|" wrangler.jsonc
#     sed -i '' -E "/\"r2_buckets\": \[/,/\]/ s|(\"bucket_name\":\s*)\"[^\"]*\"|\1\"PLACEHOLDER_R2_BUCKET_NAME\"|" wrangler.jsonc
#     sed -i '' -E "/\"kv_namespaces\": \[/,/\]/ s|(\"id\":\s*)\"[^\"]*\"|\1\"YOUR_KV_ID_WILL_BE_POPULATED_BY_DEPLOY_SCRIPT\"|" wrangler.jsonc
#     sed -i '' -E "/\"kv_namespaces\": \[/,/\]/ s|(\"preview_id\":\s*)\"[^\"]*\"|\1\"YOUR_PREVIEW_KV_ID_WILL_BE_POPULATED_BY_DEPLOY_SCRIPT\"|" wrangler.jsonc
# else # Linux sed
#     sed -i -E "s|^(\s*\"name\":\s*)\"[^\"]*\"|\1\"PLACEHOLDER_WORKER_NAME\"|" wrangler.jsonc
#     sed -i -E "/\"kv_namespaces\": \[/,/\]/ s|(\"binding\":\s*)\"[^\"]*\"|\1\"PLACEHOLDER_KV_BINDING_NAME\"|" wrangler.jsonc
#     sed -i -E "/\"r2_buckets\": \[/,/\]/ s|(\"bucket_name\":\s*)\"[^\"]*\"|\1\"PLACEHOLDER_R2_BUCKET_NAME\"|" wrangler.jsonc
#     sed -i -E "/\"kv_namespaces\": \[/,/\]/ s|(\"id\":\s*)\"[^\"]*\"|\1\"YOUR_KV_ID_WILL_BE_POPULATED_BY_DEPLOY_SCRIPT\"|" wrangler.jsonc
#     sed -i -E "/\"kv_namespaces\": \[/,/\]/ s|(\"preview_id\":\s*)\"[^\"]*\"|\1\"YOUR_PREVIEW_KV_ID_WILL_BE_POPULATED_BY_DEPLOY_SCRIPT\"|" wrangler.jsonc
# fi
# echo "wrangler.jsonc reset."

# Removed final secret verification block - handled by the loop above

exit 0 # Explicitly exit successfully
