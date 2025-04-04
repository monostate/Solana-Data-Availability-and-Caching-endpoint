# API Reference

[![Monostate Logo](../Logo%20monostate%20completo%20png%20preto.png)](../README.md)

This document details the HTTP endpoints provided by the Solana RPC Cache Worker.

## Authentication

- **RPC Proxy & WebSocket:** Requests to the main endpoint (`/`) for JSON-RPC calls (POST) or WebSocket upgrades require authentication using the `API_KEY` environment variable, provided as a Bearer token in the `Authorization` header.
  ```
  Authorization: Bearer YOUR_API_KEY
  ```
- **Admin Endpoints:** Requests to `/admin/*` endpoints require authentication using the `SHARED_SECRET` environment variable, provided as a Bearer token.
  ```
  Authorization: Bearer YOUR_SHARED_SECRET
  ```

## Endpoints

### `/` (Root Endpoint)

- **Method:** `POST`
- **Authentication:** `API_KEY` (Bearer Token)
- **Content-Type:** `application/json`
- **Description:** Proxies standard Solana JSON-RPC requests to the configured `SOLANA_RPC_URL`. Responses are cached based on method and parameters. Supports single and batch requests.
- **Example Request (Single):**
  ```bash
  curl YOUR_WORKER_URL/ \
    -X POST \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer YOUR_API_KEY" \
    -d '{"jsonrpc":"2.0","id":1,"method":"getSlot"}'
  ```
- **Example Request (Batch):**
  ```bash
  curl YOUR_WORKER_URL/ \
    -X POST \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer YOUR_API_KEY" \
    -d '[
          {"jsonrpc":"2.0","id":1,"method":"getSlot"},
          {"jsonrpc":"2.0","id":2,"method":"getEpochInfo"}
        ]'
  ```
- **Example Response (Cached):**
  ```json
  {
    "jsonrpc": "2.0",
    "id": 1,
    "result": 184567890,
    "responseTime": 15, // Milliseconds
    "cacheHit": true
  }
  ```

- **Method:** `GET` (WebSocket Upgrade)
- **Authentication:** None for the upgrade request itself, but subsequent messages might require auth depending on implementation (currently none).
- **Description:** Upgrades the HTTP connection to a WebSocket for real-time subscriptions. See [WebSocket Guide](WEBSOCKETS.md).

### `/status`

- **Method:** `GET`
- **Authentication:** None
- **Description:** Returns the current status of the worker, including version, timestamp, and basic cache metrics.
- **Example Request:**
  ```bash
  curl YOUR_WORKER_URL/status
  ```
- **Example Response:**
  ```json
  {
    "status": "ok",
    "version": "1.0.0",
    "timestamp": 1678886400000,
    "cacheMetrics": {
      "hits": 150,
      "misses": 50,
      "hitRate": 75
    }
  }
  ```

### `/admin/metrics`

- **Method:** `GET`
- **Authentication:** `SHARED_SECRET` (Bearer Token)
- **Description:** Returns detailed cache performance metrics, including overall hits/misses and stats per RPC method.
- **Example Request:**
  ```bash
  curl YOUR_WORKER_URL/admin/metrics \
    -H "Authorization: Bearer YOUR_SHARED_SECRET"
  ```
- **Example Response:**
  ```json
  {
    "hits": 150,
    "misses": 50,
    "methodStats": {
      "getAccountInfo": {
        "hits": 80,
        "misses": 20,
        "avgResponseTime": 55.2
      },
      "getSlot": {
        "hits": 70,
        "misses": 30,
        "avgResponseTime": 12.8
      }
      // ... other methods
    }
  }
  ```

### `/admin/cleanup`

- **Method:** `GET` or `POST`
- **Authentication:** `SHARED_SECRET` (Bearer Token)
- **Description:** Triggers a cleanup process to remove expired cache entries from the R2 bucket. Note: Cache entries also have an automatic expiration set when created.
- **Example Request:**
  ```bash
  curl YOUR_WORKER_URL/admin/cleanup \
    -H "Authorization: Bearer YOUR_SHARED_SECRET"
  ```
- **Example Response:**
  ```json
  {
    "success": true,
    "cleaned": 42,
    "message": "Cleaned 42 expired cache entries"
  }
  ```

### `/admin/get`

- **Method:** `GET`
- **Authentication:** `SHARED_SECRET` (Bearer Token)
- **Description:** Retrieves a specific cached item directly from the R2 bucket using its storage key.
- **Query Parameter:** `key` (required) - The full R2 storage key (e.g., `solana-rpc:getSlot:[]`). URL encoding for the key may be necessary.
- **Example Request:**
  ```bash
  # URL encode the key: solana-rpc:getAccountInfo:["4fYN..."] -> solana-rpc:getAccountInfo:%5B%224fYN...%22%5D
  curl "YOUR_WORKER_URL/admin/get?key=solana-rpc%3AgetAccountInfo%3A%5B%224fYNw3dojWmQ4dXtSGE9epjRGy9pFSx62YypT7avPYvA%22%5D" \
    -H "Authorization: Bearer YOUR_SHARED_SECRET"
  ```
- **Example Response:**
  ```json
  {
    "success": true,
    "key": "solana-rpc:getAccountInfo:[\"4fYNw3dojWmQ4dXtSGE9epjRGy9pFSx62YypT7avPYvA\"]",
    "data": {
      "data": { /* ... actual cached RPC response ... */ },
      "metadata": {
        "timestamp": 1678886400000,
        "expiresAt": 1678886700000,
        "method": "getAccountInfo",
        "params": ["4fYNw3dojWmQ4dXtSGE9epjRGy9pFSx62YypT7avPYvA"]
      }
    }
  }
  ```

### `/admin/list-data`

- **Method:** `GET`
- **Authentication:** `SHARED_SECRET` (Bearer Token)
- **Description:** Lists keys stored in the R2 cache bucket.
- **Query Parameter:** `prefix` (optional) - Filters keys by the specified prefix (e.g., `solana-rpc:getAccountInfo:`).
- **Example Request:**
  ```bash
  curl "YOUR_WORKER_URL/admin/list-data?prefix=solana-rpc:getSlot" \
    -H "Authorization: Bearer YOUR_SHARED_SECRET"
  ```
- **Example Response:**
  ```json
  {
    "success": true,
    "keys": [
      "solana-rpc:getSlot:[]"
      // ... other keys matching prefix
    ],
    "count": 1
  }
  ```

---

*For questions or inquiries, please contact [hey@monostate.ai](mailto:hey@monostate.ai).*

### `/admin/lookup`

- **Method:** `GET`
- **Authentication:** `SHARED_SECRET` (Bearer Token)
- **Description:** Lists keys stored in the `LOOKUP_KV` namespace, which maps common identifiers (like transaction IDs or account addresses) to R2 keys.
- **Query Parameter:** `prefix` (optional) - Filters keys by the specified prefix (e.g., `tx:`, `acct:`, `mint:`, `hash:`).
- **Example Request:**
  ```bash
  curl "YOUR_WORKER_URL/admin/lookup?prefix=acct:" \
    -H "Authorization: Bearer YOUR_SHARED_SECRET"
  ```
- **Example Response:**
  ```json
  {
    "success": true,
    "entries": [
      "acct:4fYNw3dojWmQ4dXtSGE9epjRGy9pFSx62YypT7avPYvA"
      // ... other keys matching prefix
    ],
    "count": 1
  }
