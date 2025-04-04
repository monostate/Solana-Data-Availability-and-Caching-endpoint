# Detailed Setup Guide

[![Monostate Logo](../Logo%20monostate%20completo%20png%20preto.png)](../README.md)

This guide provides detailed steps for setting up the necessary Cloudflare resources (KV Namespace, R2 Bucket) and configuring the worker, complementing the Quick Start guide and the automated `deploy.sh` script.

## Prerequisites

- [Cloudflare Account](https://dash.cloudflare.com/sign-up)
- [Node.js](https://nodejs.org/) installed
- [pnpm](https://pnpm.io/installation) installed
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed and logged in (`wrangler login`)

## 1. Clone Repository & Install Dependencies

```bash
git clone https://github.com/monostate-org/Helius-Data-Availability-Layer.git # Replace if forked
cd Helius-Data-Availability-Layer
pnpm install
```

## 2. Cloudflare Resource Setup (Manual)

The `deploy.sh` script attempts to automate this, but you can also create these resources manually via the Wrangler CLI or the Cloudflare dashboard.

### KV Namespace (`LOOKUP_KV`)

The KV namespace is used for indexing cache entries (e.g., mapping transaction IDs to R2 keys) and storing metrics.

**Using Wrangler CLI:**

1.  **Create Production Namespace:**
    ```bash
    wrangler kv namespace create LOOKUP_KV
    ```
    Take note of the `id` provided in the output.

2.  **Create Preview Namespace:** (Used for local development with `pnpm run dev`)
    ```bash
    wrangler kv namespace create LOOKUP_KV --preview
    ```
    Take note of the `preview_id` provided in the output.

**Using Cloudflare Dashboard:**

1.  Navigate to Workers & Pages -> KV.
2.  Click "Create a namespace".
3.  Enter `LOOKUP_KV` as the name and click "Add".
4.  Note the **ID** displayed for the created namespace. This is your production `id`.
5.  Repeat steps 2-4, but name the second namespace `LOOKUP_KV_preview`. Note its **ID**. This is your `preview_id`.

### R2 Bucket (`DATA_BUCKET`)

The R2 bucket stores the actual cached RPC response data.

**Using Wrangler CLI:**

```bash
# Use the bucket name defined in wrangler.jsonc (default: solana-rpc-cache)
wrangler r2 bucket create solana-rpc-cache
```

**Using Cloudflare Dashboard:**

1.  Navigate to R2.
2.  Click "Create bucket".
3.  Enter `solana-rpc-cache` (or the name specified in `wrangler.jsonc`) as the bucket name.
4.  Choose a location and click "Create bucket".

## 3. Configure `wrangler.jsonc`

Ensure your `wrangler.jsonc` file correctly references the resources.

-   **`name`**: Should match the desired worker name (e.g., `solana-rpc-cache-worker`).
-   **`kv_namespaces`**: Update the `id` and `preview_id` with the values obtained in Step 2 if you created them manually or if the `deploy.sh` script failed to update them.
    ```jsonc
    "kv_namespaces": [
      {
        "binding": "LOOKUP_KV",
        // Replace with your actual IDs if needed
        "id": "YOUR_PRODUCTION_KV_ID",
        "preview_id": "YOUR_PREVIEW_KV_ID"
      }
    ],
    ```
-   **`r2_buckets`**: Ensure the `binding` is `DATA_BUCKET` and `bucket_name` matches the R2 bucket you created (e.g., `solana-rpc-cache`).
    ```jsonc
     "r2_buckets": [
       {
         "binding": "DATA_BUCKET",
         "bucket_name": "solana-rpc-cache"
       }
     ],
    ```

## 4. Configure Environment Variables & Secrets

### Local Development (`.dev.vars`)

1.  Copy the example file: `cp .dev.vars.example .dev.vars`
2.  Edit `.dev.vars` and set:
    *   `SOLANA_RPC_URL`: Your Solana RPC endpoint URL.
    *   `API_KEY`: A secret key for authenticating requests during local development.
    *   `SHARED_SECRET`: A secret key for accessing admin endpoints during local development.
    *   `CACHE_TTL_MINUTES`: Default cache duration (optional, defaults to 5).

### Production Deployment (Secrets)

Use Wrangler secrets to securely store sensitive variables for your deployed worker. The `deploy.sh` script prompts for these, or you can set them manually:

1.  **Set Solana RPC URL:**
    ```bash
    wrangler secret put SOLANA_RPC_URL
    # Paste your production RPC URL when prompted
    ```

2.  **Set API Key:**
    ```bash
    wrangler secret put API_KEY
    # Enter your desired production API key when prompted
    ```

3.  **Set Shared Secret:**
    ```bash
    wrangler secret put SHARED_SECRET
    # Enter your desired production shared secret when prompted
    ```

4.  **(Optional) Set Cache TTL:** If you want a different TTL in production than the default.
    ```bash
    wrangler secret put CACHE_TTL_MINUTES
    # Enter the desired TTL in minutes when prompted
    ```

## 5. Deploy

Once configured, deploy the worker:

```bash
# If you haven't used the deploy.sh script
wrangler deploy

# Or use the script (recommended as it handles KV ID injection)
chmod +x deploy.sh
./deploy.sh
```

Refer to the main [README.md](../README.md) for testing and usage instructions.

---

*For questions or inquiries, please contact [hey@monostate.ai](mailto:hey@monostate.ai).*
