# Testing Guide

[![Monostate Logo](../Logo%20monostate%20completo%20png%20preto.png)](../README.md)

This guide covers how to run automated tests and manually verify the functionality of the Solana RPC Cache Worker.

## Running Unit Tests

The project includes unit tests using Vitest and the Cloudflare Workers test environment.

1.  **Install Dependencies:**
    ```bash
    pnpm install
    ```

2.  **Run Tests:**
    ```bash
    pnpm test
    ```

This command will execute the test suite defined in `test/index.spec.ts` and report the results. Ensure tests pass before deploying changes.

## Manual Verification

You can manually test the deployed worker (or the local development server) using `curl` or a similar tool.

**Prerequisites:**

*   Worker running (locally via `pnpm run dev` or deployed).
*   Your `API_KEY` (for RPC/WebSocket access).
*   Your `SHARED_SECRET` (for `/admin/*` access).

### 1. Test Status Endpoint

Check if the worker is running and responsive.

```bash
curl YOUR_WORKER_URL/status
```

**Expected:** A JSON response with `"status": "ok"`.

### 2. Test Basic RPC Call

Make a simple RPC call.

```bash
# Replace YOUR_WORKER_URL and YOUR_API_KEY
curl YOUR_WORKER_URL/ \
  -X POST \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}'
```

**Expected:** A valid JSON-RPC response containing the current slot.

### 3. Verify Caching Functionality

Test if responses are being cached correctly.

1.  **Make an RPC call twice:** Choose a method like `getAccountInfo` and use the same parameters for both calls.
    ```bash
    # First Call (Replace YOUR_WORKER_URL, YOUR_API_KEY, and Solana address)
    curl YOUR_WORKER_URL/ \
      -X POST \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer YOUR_API_KEY" \
      -d '{"jsonrpc":"2.0","id":10,"method":"getAccountInfo","params":["4fYNw3dojWmQ4dXtSGE9epjRGy9pFSx62YypT7avPYvA"]}'

    # Second Call (Identical to the first)
    curl YOUR_WORKER_URL/ \
      -X POST \
      -H "Content-Type: application/json" \
      -H "Authorization: Bearer YOUR_API_KEY" \
      -d '{"jsonrpc":"2.0","id":11,"method":"getAccountInfo","params":["4fYNw3dojWmQ4dXtSGE9epjRGy9pFSx62YypT7avPYvA"]}'
    ```

2.  **Observe Responses:**
    *   The first response should have `"cacheHit": false`. Note the `responseTime`.
    *   The second response should have `"cacheHit": true` and a significantly lower `responseTime`.

3.  **Check Cache Metrics:**
    ```bash
    # Replace YOUR_WORKER_URL and YOUR_SHARED_SECRET
    curl YOUR_WORKER_URL/admin/metrics \
      -H "Authorization: Bearer YOUR_SHARED_SECRET"
    ```
    *   Look at the `hits` and `misses` count, and the stats for the `getAccountInfo` method. They should reflect the two calls you made (1 miss, 1 hit).

4.  **(Optional) Check R2 Storage:** List data in R2 to see the cached item.
    ```bash
    # Replace YOUR_WORKER_URL and YOUR_SHARED_SECRET
    # URL encode the prefix: solana-rpc:getAccountInfo: -> solana-rpc%3AgetAccountInfo%3A
    curl "YOUR_WORKER_URL/admin/list-data?prefix=solana-rpc%3AgetAccountInfo%3A" \
      -H "Authorization: Bearer YOUR_SHARED_SECRET"
    ```
    *   You should see the key corresponding to your request (e.g., `solana-rpc:getAccountInfo:["4fYNw3dojWmQ4dXtSGE9epjRGy9pFSx62YypT7avPYvA"]`).

5.  **(Optional) Check KV Lookup Table:** See if the account address was added to the lookup table.
    ```bash
    # Replace YOUR_WORKER_URL and YOUR_SHARED_SECRET
    curl "YOUR_WORKER_URL/admin/lookup?prefix=acct:" \
      -H "Authorization: Bearer YOUR_SHARED_SECRET"
    ```
    *   You should see the key `acct:4fYNw3dojWmQ4dXtSGE9epjRGy9pFSx62YypT7avPYvA`.

### 4. Test Admin Endpoints

Verify the admin endpoints are working and require the `SHARED_SECRET`.

*   **Metrics:** (Tested above)
*   **Cleanup:**
    ```bash
    # Replace YOUR_WORKER_URL and YOUR_SHARED_SECRET
    curl YOUR_WORKER_URL/admin/cleanup \
      -H "Authorization: Bearer YOUR_SHARED_SECRET"
    ```
*   **List Data / Get Data / Lookup:** (Tested above)

### 5. Test WebSocket Subscriptions

Use a WebSocket client tool (like `websocat`, `wscat`, or a browser console) to connect and test subscriptions as described in [WebSocket Guide](WEBSOCKETS.md).

---

*For questions or inquiries, please contact [hey@monostate.ai](mailto:hey@monostate.ai).*
