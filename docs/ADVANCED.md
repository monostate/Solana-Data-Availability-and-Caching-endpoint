# Advanced Configuration & Optimization

[![Monostate Logo](../Logo%20monostate%20completo%20png%20preto.png)](../README.md)

This guide provides advanced information on how to extend, optimize, and customize the Solana RPC Cache Worker for your specific needs.

## Adding New RPC Methods

The worker currently supports many common Solana RPC methods, but you may need to add more. Here's how to add a new method:

1.  Open `src/index.ts`
2.  Locate the `processSolanaRpc` method.
3.  Add a new `case` to the `switch` statement for your method:

    ```typescript
    case 'yourNewMethod':
      // Ensure correct parameters are present
      if (params.length >= /* required number */) {
        // Perform the RPC call using the web3.js Connection instance `conn`
        // Example: result = await conn.yourNewMethod(params[0], params[1] || {});
        // Replace `yourNewMethod` with the actual method from `@solana/web3.js`
        // or handle the call appropriately if it's not a direct mapping.
      }
      break;
    ```

4.  If the method requires specific TTL settings (different from the default), add it to the `ttlMap` within the `getCacheTtl` method:

    ```typescript
    const ttlMap: Record<string, number> = {
      // ... existing methods
      'yourNewMethod': defaultTtl * 2, // Adjust TTL (in milliseconds) as needed
    };
    ```

## Optimizing Cache Performance

### Custom TTL Settings

Different types of data require different caching strategies. You can fine-tune TTLs in the `getCacheTtl` method within `src/index.ts`.

1.  **Frequently Changing Data:** Use shorter TTLs (e.g., account balances, recent blockhashes).
    ```typescript
    'getBalance': defaultTtl / 4, // 1/4 of default TTL
    'getLatestBlockhash': 20 * 1000, // 20 seconds
    ```

2.  **Historical Data:** Use longer TTLs (e.g., confirmed transactions, finalized blocks).
    ```typescript
    'getTransaction': defaultTtl * 4, // 4x default TTL
    'getBlock': defaultTtl * 3,
    ```

### Advanced Caching Strategies

1.  **Progressive TTLs:** Implement logic within `getCacheTtl` or a helper function to adjust TTLs based on parameters (e.g., cache program accounts longer than user accounts). *Note: This requires adding logic to determine account types.*

    ```typescript
    // Example concept (requires implementation of determineAccountType)
    private getProgressiveTtl(method: string, params: any[]): number {
      const baseTtl = this.getCacheTtl(method); // Get base TTL first

      if (method === 'getAccountInfo' && params.length > 0) {
        // const accountType = this.determineAccountType(params[0]); // Needs implementation
        // if (accountType === 'program') {
        //   return baseTtl * 3; // Programs change rarely
        // } else if (accountType === 'system') {
        //   return baseTtl / 2; // System accounts change frequently
        // }
      }
      return baseTtl;
    }
    ```

2.  **Data-aware Invalidation:** Implement logic to invalidate specific cache keys based on blockchain events (e.g., using WebSocket subscriptions to monitor relevant accounts or slots). *Note: This requires significant additions to the worker logic.*

    ```typescript
    // Example concept (requires implementation of monitoring and invalidation)
    async monitorSlotChanges() {
      const conn = this.initConnection();
      conn.onSlotChange((slotInfo: SlotInfo) => {
        // Example: If a new epoch starts, invalidate epoch-related caches
        // if (slotInfo.slot % 432000 === 0) { // Epoch length in slots
        //   this.invalidateEpochCaches(); // Needs implementation
        // }
      });
    }
    ```

## Scaling Considerations

### Handling High Traffic

1.  **Intelligent Rate Limiting:** The current implementation uses a simple per-IP counter. You could modify `isRateLimited` in `src/index.ts` to adjust limits dynamically (e.g., based on time of day or API key tiers).

    ```typescript
    // Example concept (modify isRateLimited or MAX_REQUESTS_PER_MINUTE)
    private getMaxRequestsPerMinute(): number {
      const hour = new Date().getHours();
      // Adjust limits based on time of day
      if (hour >= 0 && hour < 6) {
        return 50; // Higher limit during low traffic hours
      } else if (hour >= 9 && hour < 17) {
        return 30; // Lower limit during peak hours
      }
      return this.MAX_REQUESTS_PER_MINUTE; // Use default
    }
    ```

2.  **Request Batching:** The worker already handles batch requests efficiently by processing them concurrently.

### Multiple RPC Fallbacks

To enhance reliability, you could modify the `processSolanaRpc` method in `src/index.ts` to try multiple RPC endpoints if the primary one fails.

```typescript
// Example concept (modify processSolanaRpc)
private async callWithFallback(method: string, params: any[]): Promise<any> {
  const primaryRpcUrl = this.env.SOLANA_RPC_URL;
  const fallbackRpcUrls = [
    // Add your fallback URLs here, perhaps from another env variable
    // clusterApiUrl('mainnet-beta'), // Example public fallback
    'https://your-fallback-rpc-1.com',
  ];

  try {
    // Try primary first
    const conn = this.initConnection(); // Assumes initConnection uses primary URL
    // Need to adapt this part to actually call the method on the connection
    // result = await conn.someRpcMethod(params);
    // return result;
  } catch (error) {
    console.warn(`Primary RPC failed for ${method}, trying fallbacks...`, error);
    // Try fallbacks
    for (const fallbackUrl of fallbackRpcUrls) {
      try {
        console.log(`Trying fallback: ${fallbackUrl}`);
        const fallbackConn = new Connection(fallbackUrl, 'confirmed');
        // Need to adapt this part to call the method on the fallback connection
        // result = await fallbackConn.someRpcMethod(params);
        // return result;
      } catch (fallbackError) {
        console.warn(`Fallback ${fallbackUrl} failed:`, fallbackError);
        continue; // Try next fallback
      }
    }
    throw new Error(`All RPC endpoints failed for method ${method}`);
  }
}
```

## Enhanced Analytics and Monitoring

The worker already includes basic metrics tracking (`cacheMetrics`) and an endpoint (`/admin/metrics`). You could enhance this by:

-   Adding more granular metrics (e.g., latency percentiles, error types).
-   Integrating with external monitoring services (e.g., Datadog, Grafana) by pushing metrics from the worker, potentially using `ctx.waitUntil` for asynchronous tasks.
-   Leveraging Cloudflare Worker Analytics.

## Security Hardening

### Advanced Rate Limiting

Implement a more sophisticated algorithm like the token bucket for smoother rate limiting.

```typescript
// Example Token Bucket Class (integrate into isRateLimited)
class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRate: number; // tokens per ms

  constructor(maxTokens: number, refillRate: number) {
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
    this.maxTokens = maxTokens;
    this.refillRate = refillRate;
  }

  consume(tokensToConsume: number = 1): boolean {
    this.refill();
    if (this.tokens >= tokensToConsume) {
      this.tokens -= tokensToConsume;
      return true;
    }
    return false;
  }

  private refill() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const newTokens = elapsed * this.refillRate;

    this.tokens = Math.min(this.maxTokens, this.tokens + newTokens);
    this.lastRefill = now;
  }
}

// --- In MyWorker class ---
// private rateLimiters = new Map<string, TokenBucket>(); // Use this instead of rateLimit map

// --- Modify isRateLimited ---
// private isRateLimited(clientIp: string, cost: number = 1): boolean {
//   if (!this.rateLimiters.has(clientIp)) {
//     // Example: 60 tokens max, 1 token per second refill rate
//     this.rateLimiters.set(clientIp, new TokenBucket(60, 1 / 1000));
//   }
//   const bucket = this.rateLimiters.get(clientIp)!;
//   return !bucket.consume(cost);
// }
```

### Request Authentication

The current implementation uses a single `API_KEY` via Bearer token. You could extend this:

-   Support multiple API keys with different permissions or rate limits (e.g., store keys and tiers in KV).
-   Implement other authentication schemes if needed.

*Note: The example below uses `X-API-Key` header and `VALID_API_KEYS` env var, which differs from the current implementation using `Authorization: Bearer` and `API_KEY`.*

```typescript
// Example concept for multiple keys (modify verifyApiAuth)
private async isAuthorizedClient(request: Request): Promise<boolean> {
  const authHeader = request.headers.get('Authorization');
  const token = authHeader?.startsWith('Bearer ') ? authHeader.split('Bearer ')[1] : null;

  if (!token) return false;

  // Option 1: Check against single API_KEY (current implementation)
  // return token === this.env.API_KEY;

  // Option 2: Check against a list in KV or another source
  // const isValid = await this.env.KV_API_KEYS.get(token);
  // return isValid !== null;

  // Option 3: Check against comma-separated list in env (less secure)
  // const validApiKeys = (this.env.VALID_API_KEYS || "").split(',');
  // return validApiKeys.includes(token);

  return false; // Default deny
}
```

## Advanced Usage Patterns

### Implementing Webhooks

Add webhook notifications for important events (e.g., high cache miss rate, errors).

```typescript
// Example concept (add to MyWorker class)
private async sendWebhook(event: string, data: any) {
  const webhookUrl = this.env.WEBHOOK_URL; // Needs WEBHOOK_URL env var
  if (!webhookUrl) return;

  try {
    const payload = {
      event,
      timestamp: new Date().toISOString(),
      data
    };
    // Use ctx.waitUntil to send webhook without blocking response
    this.ctx.waitUntil(fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }));
  } catch (error) {
    console.error(`Webhook error: ${error}`);
  }
}

// Example usage within processSolanaRpc error handling:
// await this.sendWebhook('rpc_error', { method: request.method, error: String(error) });
```

### Implementing a ZK-like Lookup System

The current `LookupTable` uses direct mappings (tx ID -> R2 key, account -> R2 key). The "ZK-like" hash lookup (`storeDataHash`, `getDataHash`) provides a basic content-addressable storage mechanism, mapping a hash of request parameters to an R2 key. This could be potentially used for deduplication but isn't a true ZK system.

## Conclusion

This guide provides a starting point for extending and optimizing your Solana RPC Cache Worker. As you implement these enhancements, monitor performance and adjust based on your specific requirements and traffic patterns.

Remember to test all changes thoroughly before deploying to production.

---

*For questions or inquiries, please contact [hey@monostate.ai](mailto:hey@monostate.ai).*
