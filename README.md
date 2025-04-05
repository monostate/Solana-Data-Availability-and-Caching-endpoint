# Solana RPC Cache Worker

![monostate-img-github](https://github.com/user-attachments/assets/d956284f-d3bd-4e5c-b370-d3003ca73c5b)


A high-performance Solana RPC caching layer built on Cloudflare Workers, KV, and R2 storage. Deploy this worker to provide a fast, reliable, and rate-limited caching proxy for your Solana RPC endpoint.

## Features

- **🚀 High-Performance Caching**: Leverages Cloudflare's global network, KV, and R2 for low-latency cached responses.
- **⚡️ Smart Caching / Data Availability**: Uses different cache Time-To-Live (TTL) values based on the RPC method's data volatility (configurable default, e.g., 7 days, with shorter/longer overrides for specific methods). TTL can be disabled entirely (`DISABLE_TTL` env var) for pure data availability use cases where data should persist indefinitely (up to R2 storage limits).
- **🛡️ Rate Limiting**: Protects your underlying RPC endpoint from excessive load (configurable, defaults to ~35 requests/minute per IP).
- **📡 WebSocket Subscriptions**: Supports real-time data subscriptions via WebSockets.
- **📊 Admin Endpoints**: Includes endpoints for monitoring cache metrics, listing/viewing cached data, and triggering cache cleanup (protected by `SHARED_SECRET`).
- **⚙️ Configurable**: Set RPC endpoint, cache TTL, API key, and admin secret via environment variables.
- **↔️ Batch Request Handling**: Processes JSON-RPC batch requests efficiently.
- **🔑 API Key Authentication**: Secure your worker endpoint with bearer token authentication.

## Prerequisites

- [Cloudflare Account](https://dash.cloudflare.com/sign-up) (Free plan works, Paid plan recommended for higher limits)
- [Node.js](https://nodejs.org/) (v18 or later recommended)
- [pnpm](https://pnpm.io/installation) (for package management)
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) (`pnpm install -g wrangler`)

## Solana RPC Endpoint Recommendation

While this worker can proxy any Solana RPC endpoint, public endpoints often have strict rate limits and may block requests originating from Cloudflare IPs.

**We strongly recommend using a dedicated RPC provider like Helius.** Public endpoints (like the default `api.mainnet-beta.solana.com`) often block requests originating from Cloudflare IPs, which will cause this worker to fail.

- **Helius:** [https://helius.xyz/](https://helius.xyz/) - Offers reliable infrastructure and generous free tiers. ([Docs](https://docs.helius.xyz/))
  - Your Helius RPC URL will look like: `https://mainnet.helius-rpc.com/?api-key=YOUR_HELIUS_API_KEY` (Replace `YOUR_HELIUS_API_KEY` with your actual key).

Using a dedicated provider like Helius ensures better performance and reliability for your caching worker. You can use other providers, but ensure they permit requests from Cloudflare's IP ranges.

## Quick Start

1.  **Clone the Repository:**
    ```bash
    git clone https://github.com/monostate-org/Helius-Data-Availability-Layer.git # Replace with your repo URL if forked
    cd Helius-Data-Availability-Layer
    ```

2.  **Install Dependencies:**
    ```bash
    pnpm install
    ```

3.  **Configure for Local Development:**
    - Copy the example environment file:
      ```bash
      cp .dev.vars.example .dev.vars
      ```
    - **Edit `.dev.vars`:**
      - Set `SOLANA_RPC_URL` to your chosen Solana RPC endpoint (e.g., your Helius URL).
      - Set `API_KEY` to a secret key you will use to authenticate requests.
      - Set `SHARED_SECRET` to a different secret key for accessing admin endpoints.
      - Adjust `CACHE_TTL_MINUTES` if needed (default is 10080 minutes = 7 days).
      - Set `DISABLE_TTL="true"` if you want data to persist indefinitely (no automatic expiry). Otherwise, leave as `"false"` or remove the line.

4.  **Run Locally:**
    ```bash
    pnpm run dev
    ```
    The worker will be available at `http://localhost:8787`.

5.  **Test Locally:**
    *   **Status:**
        ```bash
        curl http://localhost:8787/status
        ```
    *   **RPC Call (replace `your-api-key-for-local-dev` with your actual API_KEY from `.dev.vars`):**
        ```bash
        curl http://localhost:8787/ \
          -X POST \
          -H "Content-Type: application/json" \
          -H "Authorization: Bearer your-api-key-for-local-dev" \
          -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}'
        ```
    *   **Admin Metrics (replace `your-secure-secret-here` with your SHARED_SECRET):**
        ```bash
        curl http://localhost:8787/admin/metrics \
          -H "Authorization: Bearer your-secure-secret-here"
        ```

## Deployment

The easiest way to deploy is using the provided script:

```bash
chmod +x deploy.sh
./deploy.sh
```

This script automates the deployment process:

1.  **Checks for Existing Config:** Looks for a previous deployment configuration in `.dev.vars`. If found, asks if you want to reuse it.
2.  **Prompts for Name:** If no existing config is found or you choose not to reuse, it prompts for a unique deployment name (e.g., `my-solana-cache`). This name is used to derive the worker name, KV namespace title, and R2 bucket name.
3.  **Updates `wrangler.jsonc`:** Overwrites `wrangler.jsonc` with the derived worker name, KV binding name, and R2 bucket name. It verifies this update.
4.  **Creates KV Namespace:** Creates the necessary KV namespace (e.g., `my-solana-cache-kv`) and its preview version if they don't exist. It then updates `wrangler.jsonc` with the obtained KV namespace IDs.
5.  **Creates R2 Bucket:** Creates the R2 bucket (e.g., `my-solana-cache-cache`) if it doesn't exist.
6.  **Sets Secrets:** Prompts if you want to set secrets now. If yes:
    *   Asks for your Solana RPC URL (e.g., your Helius URL).
    *   Generates a secure `API_KEY` and `SHARED_SECRET`.
    *   Uses `wrangler secret put` to set `SOLANA_RPC_URL`, `API_KEY`, `SHARED_SECRET`, and `KV_BINDING_NAME` for the deployed worker.
    *   Includes a verification loop for `API_KEY` to handle potential propagation delays.
    *   Asks if you want to update your local `.dev.vars` with the generated secrets for local testing.
7.  **Deploys Worker:** Runs `wrangler deploy` to deploy the worker with the configured settings, bindings, and secrets.
8.  **Custom Domain (Optional):** Asks if you want to set up a custom domain and guides you to the Cloudflare dashboard if needed.
9.  **Verification:** Attempts to verify the deployment by fetching the `/status` endpoint.

After deployment, the script will output your worker's URL (e.g., `https://my-solana-cache.<your-subdomain>.workers.dev`) and example `curl` commands.

## Usage

Interact with your deployed worker URL like you would with a standard Solana RPC endpoint, but include your `API_KEY` as a Bearer token in the `Authorization` header.

**Example `curl`:**

```bash
# Replace YOUR_WORKER_URL and YOUR_API_KEY
curl YOUR_WORKER_URL \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getAccountInfo","params":["4fYNw3dojWmQ4dXtSGE9epjRGy9pFSx62YypT7avPYvA"]}'
```

**Admin Endpoints:** Access admin endpoints using your `SHARED_SECRET`.

```bash
# Replace YOUR_WORKER_URL and YOUR_SHARED_SECRET
curl YOUR_WORKER_URL/admin/metrics \
  -H "Authorization: Bearer YOUR_SHARED_SECRET"
```

**WebSockets:** Connect to the WebSocket endpoint at your worker URL (e.g., `wss://your-worker-url/`). See `docs/WEBSOCKETS.md` for details.

## Verifying Cache Functionality

1.  Make the same RPC call twice using `curl` (with your `API_KEY`).
2.  Observe the `cacheHit` field in the JSON response: it should be `false` on the first call and `true` on the second.
3.  Observe the `responseTime` field: it should be significantly lower on the second (cached) call.
4.  Check the `/admin/metrics` endpoint (using your `SHARED_SECRET`) to see cache hit/miss counts increase.

## Further Documentation

- **[API Reference](docs/API_REFERENCE.md):** Detailed information about all HTTP endpoints.
- **[WebSocket Guide](docs/WEBSOCKETS.md):** How to use WebSocket subscriptions.
- **[Detailed Setup](docs/SETUP.md):** Manual Cloudflare setup steps.
- **[Testing Guide](docs/TESTING.md):** Running unit tests and detailed verification.
- **[Advanced Configuration](docs/ADVANCED.md):** Extending and optimizing the worker.

## Contributing

Contributions are welcome! Please refer to the [Contributing Guide](docs/CONTRIBUTING.md).

## Support & Inquiries

For questions or inquiries, please contact [hey@monostate.ai](mailto:hey@monostate.ai).

## License

[MIT](LICENSE)
