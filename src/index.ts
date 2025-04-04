import { WorkerEntrypoint } from 'cloudflare:workers'
// Removed: import { ProxyToSelf } from 'workers-mcp'
import { Connection, PublicKey, clusterApiUrl, SlotInfo } from '@solana/web3.js'
import { LookupTable, LookupEnv } from './lookup_table'

// Define the Env interface with R2 bucket, KV, and ASSETS fetcher
export interface Env extends LookupEnv {
  DATA_BUCKET: R2Bucket;
  LOOKUP_KV: KVNamespace;
  SHARED_SECRET: string; // For admin endpoints
  API_KEY: string; // For general API access
  SOLANA_RPC_URL: string;
  CACHE_TTL_MINUTES: string;
  DISABLE_TTL?: string; // Optional: Set to "true" to disable TTL expiry
  // Removed: ASSETS: Fetcher;
}

// Removed: LanguageCode type

// RPC request interface
interface RpcRequest {
  jsonrpc: string;
  id: string | number;
  method: string;
  params?: any[];
}

// RPC response interface
interface RpcResponse {
  jsonrpc: string;
  id: string | number;
  result?: any;
  error?: {
    code: number;
    message: string;
  };
  responseTime: number;
  cacheHit: boolean;
}

// Cache metadata interface
interface CacheMetadata {
  timestamp: number;
  expiresAt?: number; // Made optional to allow deletion when TTL is disabled
  method: string;
  params: any[];
}

// Cache metrics interface
interface CacheMetrics {
  hits: number;
  misses: number;
  methodStats: Record<string, { hits: number; misses: number; avgResponseTime: number }>;
}

// WebSocket subscription interface
interface WebSocketSubscription {
  id: string | number;
  method: string;
  params: any[];
  lastResponse?: any;
  lastTimestamp?: number;
}

export default class MyWorker extends WorkerEntrypoint<Env> {
  // Rate limiting
  private rateLimit = new Map<string, { count: number, timestamp: number }>();
  private readonly MAX_REQUESTS_PER_MINUTE = 35; // Keeping under 40 RPS to be safe

  // Connection instance (will be initialized in fetch)
  private connection: Connection | null = null;

  // Default cache TTL in minutes (Set high for DAL use case)
  private readonly DEFAULT_CACHE_TTL_MINUTES = 10080; // 7 days

  // Cache metrics
  private cacheMetrics: CacheMetrics = {
    hits: 0,
    misses: 0,
    methodStats: {}
  };

  // Lookup table instance
  private lookupTable: LookupTable | null = null;

  // WebSocket clients and subscriptions
  private activeWebSockets = new Map<WebSocket, Set<string | number>>();
  private subscriptions = new Map<string | number, WebSocketSubscription>();

  /**
   * Load cache metrics from KV storage
   * @private
   */
  private async loadCacheMetrics(): Promise<void> {
    try {
      const storedMetrics = await this.env.LOOKUP_KV.get('CACHE_METRICS');
      if (storedMetrics) {
        this.cacheMetrics = JSON.parse(storedMetrics);
        console.log('Loaded cache metrics from KV:', this.cacheMetrics);
      }
    } catch (error) {
      console.error('Error loading cache metrics:', error);
    }
  }

  /**
   * Save cache metrics to KV storage
   * @private
   */
  private async saveCacheMetrics(): Promise<void> {
    try {
      await this.env.LOOKUP_KV.put('CACHE_METRICS', JSON.stringify(this.cacheMetrics));
    } catch (error) {
      console.error('Error saving cache metrics:', error);
    }
  }

  // Removed: sayHello method

  /**
   * Initialize Solana connection
   * @private
   */
  private initConnection() {
    if (!this.connection) {
      // Use the env RPC URL if provided, otherwise use the default
      const rpcUrl = this.env.SOLANA_RPC_URL || clusterApiUrl('mainnet-beta');
      console.log("Using RPC URL:", rpcUrl);

      // Create a simple connection with confirmed commitment
      this.connection = new Connection(rpcUrl, 'confirmed');
    }
    return this.connection;
  }

  /**
   * Record a cache hit for metrics
   * @param method RPC method name
   * @param responseTime Time taken to process in ms
   * @private
   */
  private async recordCacheHit(method: string, responseTime: number) {
    this.cacheMetrics.hits++;
    if (!this.cacheMetrics.methodStats[method]) {
      this.cacheMetrics.methodStats[method] = { hits: 0, misses: 0, avgResponseTime: 0 };
    }

    const stats = this.cacheMetrics.methodStats[method];
    stats.hits++;
    stats.avgResponseTime = ((stats.avgResponseTime * (stats.hits - 1)) + responseTime) / stats.hits;

    // Save metrics to KV
    await this.saveCacheMetrics();
  }

  /**
   * Record a cache miss for metrics
   * @param method RPC method name
   * @param responseTime Time taken to process in ms
   * @private
   */
  private async recordCacheMiss(method: string, responseTime: number) {
    this.cacheMetrics.misses++;
    if (!this.cacheMetrics.methodStats[method]) {
      this.cacheMetrics.methodStats[method] = { hits: 0, misses: 0, avgResponseTime: 0 };
    }

    const stats = this.cacheMetrics.methodStats[method];
    stats.misses++;
    stats.avgResponseTime = ((stats.avgResponseTime * (stats.misses - 1)) + responseTime) / stats.misses;

    // Save metrics to KV
    await this.saveCacheMetrics();
  }

  /**
   * Check if a client is rate limited
   * @param clientIp IP address of the client
   * @returns boolean indicating if client is rate limited
   * @private
   */
  private isRateLimited(clientIp: string): boolean {
    const now = Date.now();
    const clientRate = this.rateLimit.get(clientIp);

    if (!clientRate) {
      this.rateLimit.set(clientIp, { count: 1, timestamp: now });
      return false;
    }

    // Reset counter if it's been more than a minute
    if (now - clientRate.timestamp > 60000) {
      this.rateLimit.set(clientIp, { count: 1, timestamp: now });
      return false;
    }

    // Increment counter and check if rate limited
    clientRate.count++;
    if (clientRate.count > this.MAX_REQUESTS_PER_MINUTE) {
      return true;
    }

    return false;
  }

  /**
   * Generate a cache key from method and params
   * @param method RPC method
   * @param params RPC parameters
   * @returns cache key string
   * @private
   */
  private generateCacheKey(method: string, params: any[]): string {
    return "solana-rpc:" + method + ":" + JSON.stringify(params);
  }

  /**
   * Get cache TTL based on method type
   * @param method RPC method name
   * @returns TTL in milliseconds
   * @private
   */
  private getCacheTtl(method: string): number {
    // Use TTL from env var if set, otherwise use the class default (now 7 days)
    const configTtlMinutes = parseInt(this.env.CACHE_TTL_MINUTES) || this.DEFAULT_CACHE_TTL_MINUTES;
    const defaultTtlMs = configTtlMinutes * 60 * 1000; // Default TTL in milliseconds

    // --- DAL Focused TTL Strategy ---
    // Keep frequently changing data TTLs short.
    // Extend TTLs significantly for historical/stable data.

    const ONE_HOUR_MS = 60 * 60 * 1000;
    const ONE_DAY_MS = 24 * ONE_HOUR_MS;
    const ONE_WEEK_MS = 7 * ONE_DAY_MS;
    const ONE_MONTH_MS = 30 * ONE_DAY_MS; // Approx

    const ttlMap: Record<string, number> = {
      // --- Short TTL (Volatile Data) ---
      'getSlot': 30 * 1000,                 // 30 seconds - Needs to be very fresh
      'getLatestBlockhash': 20 * 1000,      // 20 seconds - Needs to be very fresh
      'isBlockhashValid': 20 * 1000,        // 20 seconds - Related to blockhash
      'getEpochInfo': 5 * 60 * 1000,        // 5 minutes - Changes relatively slowly but important
      'getFees': 5 * 60 * 1000,             // 5 minutes - Can change based on network congestion
      'getFeeForMessage': 5 * 60 * 1000,    // 5 minutes - Related to fees

      // --- Medium TTL (Account/Token Data - Can Change) ---
      'getAccountInfo': ONE_HOUR_MS,        // 1 hour - Balance/data can change
      'getMultipleAccounts': ONE_HOUR_MS,   // 1 hour
      'getBalance': ONE_HOUR_MS,            // 1 hour
      'getTokenAccountBalance': ONE_HOUR_MS,// 1 hour
      'getTokenAccountsByOwner': ONE_HOUR_MS, // 1 hour
      'getVoteAccounts': ONE_HOUR_MS,       // 1 hour - Vote accounts change state

      // --- Long TTL (Historical/Stable Data) ---
      'getTransaction': ONE_MONTH_MS,       // 1 month - Confirmed transactions are immutable
      'getBlock': ONE_MONTH_MS,             // 1 month - Confirmed blocks are immutable
      'getSignaturesForAddress': ONE_DAY_MS,// 1 day - History grows, but old sigs don't change
      'getProgramAccounts': ONE_DAY_MS,     // 1 day - Can change, but often less volatile than user accounts
      'getSupply': ONE_DAY_MS,              // 1 day - Changes slowly
      'getTokenSupply': ONE_DAY_MS,         // 1 day - Changes slowly
      'getBlockHeight': ONE_HOUR_MS,        // 1 hour - Increases constantly, but value might be useful cached slightly longer than getSlot

      // --- Very Long TTL (Infrequently Changing Data) ---
      'getMinimumBalanceForRentExemption': ONE_WEEK_MS, // 1 week - Changes very rarely (network upgrades)
      'getVersion': ONE_WEEK_MS,            // 1 week - Node version changes infrequently
      'getIdentity': ONE_WEEK_MS,           // 1 week - Node identity changes infrequently
      'getInflationGovernor': ONE_WEEK_MS,  // 1 week - Changes rarely
      'getInflationRate': ONE_DAY_MS        // 1 day - Changes based on epoch/schedule
    };

    // Return the specific TTL if found, otherwise the default TTL
    return ttlMap[method] || defaultTtlMs; // Use defaultTtlMs here
  }

  /**
   * Store data in R2 bucket
   * @param key {string} the key to store the data under
   * @param data {string | ArrayBuffer} the data to store
   * @return {Promise<boolean>} whether the operation was successful
   */
  async storeData(key: string, data: string | ArrayBuffer) {
    try {
      await this.env.DATA_BUCKET.put(key, data);
      return true;
    } catch (error) {
      console.error("Error storing data:", error);
      return false;
    }
  }

  /**
   * Retrieve data from R2 bucket
   * @param key {string} the key to retrieve the data from
   * @return {Promise<string | null>} the retrieved data or null if not found
   */
  async retrieveData(key: string) {
    try {
      const object = await this.env.DATA_BUCKET.get(key);
      if (!object) return null;

      const data = await object.text();
      return data;
    } catch (error) {
      console.error("Error retrieving data:", error);
      return null;
    }
  }

  /**
   * List objects in R2 bucket
   * @param prefix {string} optional prefix to filter objects
   * @return {Promise<Array<string>>} list of object keys
   */
  async listData(prefix?: string) {
    try {
      const listed = await this.env.DATA_BUCKET.list({ prefix });
      return listed.objects.map(obj => obj.key);
    } catch (error) {
      console.error("Error listing data:", error);
      return [];
    }
  }

  /**
   * Cache data with metadata
   * @param key cache key
   * @param data data to cache
   * @param method RPC method name
   * @param params RPC parameters
   * @private
   */
  private async cacheData(key: string, data: any, method: string, params: any[]): Promise<void> {
    const ttl = this.getCacheTtl(method);
    const now = Date.now();

    const cacheEntry = {
      data,
      metadata: {
        timestamp: now,
        expiresAt: now + ttl,
        method,
        params
      } as CacheMetadata
    };

    // Store the data along with metadata (timestamp, expiry, method, params)
    // Store the data along with metadata (timestamp, method, params)
    const putOptions: R2PutOptions = {};
    const disableTtl = this.env.DISABLE_TTL === "true";

    if (!disableTtl) {
      // Only set expiration if TTL is not disabled
      const expiryDate = new Date(now + ttl);
      putOptions.httpMetadata = { cacheExpiry: expiryDate }; // Use cacheExpiry with a Date object
      // Also store expiresAt in metadata for potential manual checks/cleanup logic
      cacheEntry.metadata.expiresAt = expiryDate.getTime(); // Store as timestamp
    } else {
      // Remove expiresAt from metadata if TTL is disabled (property is now optional)
      delete cacheEntry.metadata.expiresAt;
    }

    await this.env.DATA_BUCKET.put(key, JSON.stringify(cacheEntry), putOptions);
  }

  /**
   * Get lookup table instance (lazy initialization)
   */
  private getLookupTable(): LookupTable {
    if (!this.lookupTable) {
      this.lookupTable = new LookupTable(this.env);
    }
    return this.lookupTable;
  }

  /**
   * Calculate SHA-256 hash of data using Web Crypto API
   * @param data Data to hash
   * @returns Hex hash string
   */
  private async calculateHash(data: string): Promise<string> {
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(data);
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    // Convert buffer to hex string
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Check if data exists in the lookup table based on transaction ID, address, or hash
   * @param method RPC method
   * @param params RPC parameters
   * @returns R2 key if found, null otherwise
   */
  private async checkLookupTable(method: string, params: any[]): Promise<string | null> {
    const lookupTable = this.getLookupTable();

    // Check based on method
    if (method === 'getTransaction' && params.length >= 1) {
      // Transaction ID lookup
      const txId = params[0];
      return lookupTable.getTxMapping(txId);
    }
    else if ((method === 'getAccountInfo' || method === 'getBalance') && params.length >= 1) {
      // Account address lookup
      const address = params[0];
      return lookupTable.getAccountMapping(address);
    }
    else if (method === 'getTokenSupply' && params.length >= 1) {
      // Mint address lookup
      const mintAddress = params[0];
      return lookupTable.getMintMapping(mintAddress);
    }
    else if (method === 'getTokenAccountsByOwner' && params.length >= 1) {
      // Owner address lookup
      const ownerAddress = params[0];
      return lookupTable.getAccountMapping(ownerAddress);
    }

    return null;
  }

  /**
   * Update lookup table with new mapping
   * @param method RPC method
   * @param params RPC parameters
   * @param r2Key R2 storage key
   */
  private async updateLookupTable(method: string, params: any[], r2Key: string): Promise<void> {
    const lookupTable = this.getLookupTable();

    try {
      // Update based on method
      if (method === 'getTransaction' && params.length >= 1) {
        // Transaction ID mapping
        const txId = params[0];
        await lookupTable.storeTxMapping(txId, r2Key);
      }
      else if ((method === 'getAccountInfo' || method === 'getBalance') && params.length >= 1) {
        // Account address mapping
        const address = params[0];
        await lookupTable.storeAccountMapping(address, r2Key);
      }
      else if (method === 'getTokenSupply' && params.length >= 1) {
        // Mint address mapping
        const mintAddress = params[0];
        await lookupTable.storeMintMapping(mintAddress, r2Key);
      }
      else if (method === 'getTokenAccountsByOwner' && params.length >= 1) {
        // Owner address mapping
        const ownerAddress = params[0];
        await lookupTable.storeAccountMapping(ownerAddress, r2Key);
      }

      // Store data hash mapping for ZK-like compression
      const dataHash = await this.calculateHash(JSON.stringify(params));
      await lookupTable.storeDataHash(dataHash, r2Key);
    } catch (error) {
      console.error("Error updating lookup table:", error);
    }
  }

  /**
   * Process a Solana RPC request
   * @param request JSON-RPC request object
   * @returns JSON-RPC response object
   */
  async processSolanaRpc(request: RpcRequest): Promise<RpcResponse> {
    const { method, params = [] } = request;
    const cacheKey = this.generateCacheKey(method, params);
    const startTime = Date.now();

    // Print request details for debugging
    console.log("Processing RPC request:", method, "with params:", JSON.stringify(params));

    // --- Cache Check Strategy ---
    // 1. Check Lookup Table (KV): Fast index for common patterns (txId, accountAddr)
    // 2. Check Direct Cache Key (R2): Primary cache storage using method+params key

    // 1. Check Lookup Table (KV)
    const lookupKey = await this.checkLookupTable(method, params);
    if (lookupKey) {
      console.log(`Lookup table check for ${method} yielded key: ${lookupKey}`);
      const cachedData = await this.retrieveData(lookupKey); // Check R2 using the key from KV
      if (cachedData) {
        try {
          const parsed = JSON.parse(cachedData);
          const metadata = parsed.metadata as CacheMetadata;
          const disableTtl = this.env.DISABLE_TTL === "true";

          // If TTL is disabled OR if TTL is enabled and the item is not expired, return cached data
          if (disableTtl || (metadata.expiresAt && metadata.expiresAt > Date.now())) {
            console.log("Lookup table hit for", method, disableTtl ? "(TTL Disabled)" : "");
            const responseTime = Date.now() - startTime;
            await this.recordCacheHit(method, responseTime);

            return {
              jsonrpc: "2.0",
              id: request.id,
              result: parsed.data,
              responseTime: responseTime,
              cacheHit: true
            };
          }
        } catch (e) {
          console.error("Error parsing cached data:", e);
        }
      } else {
         console.log(`Lookup table key ${lookupKey} found, but no data in R2.`);
         // Potential inconsistency, might need cleanup or just proceed to direct cache check
      }
    }

    // 2. Check Direct Cache Key (R2)
    console.log(`Checking direct cache key in R2: ${cacheKey}`);
    const cachedData = await this.retrieveData(cacheKey);
    if (cachedData) {
      try {
        const parsed = JSON.parse(cachedData);
          const metadata = parsed.metadata as CacheMetadata;
          const disableTtl = this.env.DISABLE_TTL === "true";

          // If TTL is disabled OR if TTL is enabled and the item is not expired, return cached data
          if (disableTtl || (metadata.expiresAt && metadata.expiresAt > Date.now())) {
            console.log("Cache hit for", method, disableTtl ? "(TTL Disabled)" : "");
            const responseTime = Date.now() - startTime;
          await this.recordCacheHit(method, responseTime);

          // Update lookup table for fast future access
          await this.updateLookupTable(method, params, cacheKey);

          return {
            jsonrpc: "2.0",
            id: request.id,
            result: parsed.data,
            responseTime: responseTime,
            cacheHit: true
          };
        }
      } catch (e) {
        console.error("Error parsing cached data:", e);
      }
    }

    console.log("Cache miss for", method, ", fetching from RPC");
    console.log("Using SOLANA_RPC_URL:", this.env.SOLANA_RPC_URL || "[Not Set]");

    // Cache miss or expired, fetch from Solana RPC
    try {
      const conn = this.initConnection();
      let result;

      // For version method, let's return a static response
      if (method === 'getVersion') {
        // Static version response for testing
        const responseTime = Date.now() - startTime;
        return {
          jsonrpc: "2.0",
          id: request.id,
          result: {
            "solana-core": "1.16.0",
            "feature-set": 2045430982,
          },
          responseTime: responseTime,
          cacheHit: false
        };
      }

      // Handle specific RPC methods
      switch (method) {
        case 'getAccountInfo':
          if (params.length >= 1) {
            const pubkey = new PublicKey(params[0]);
            const config = params[1] || { encoding: 'base64' };
            result = await conn.getAccountInfo(pubkey, config);
          }
          break;

        case 'getBalance':
          if (params.length >= 1) {
            const pubkey = new PublicKey(params[0]);
            result = await conn.getBalance(pubkey);
          }
          break;

        case 'getBlock':
          if (params.length >= 1) {
            result = await conn.getBlock(params[0], params[1] || {});
          }
          break;

        case 'getBlockHeight':
          result = await conn.getBlockHeight();
          break;

        case 'getSlot':
          result = await conn.getSlot();
          break;

        case 'getTransaction':
          if (params.length >= 1) {
            result = await conn.getTransaction(params[0], params[1] || {});
          }
          break;

        case 'getSignaturesForAddress':
          if (params.length >= 1) {
            const pubkey = new PublicKey(params[0]);
            const config = params[1] || { limit: 10 };
            result = await conn.getSignaturesForAddress(pubkey, config);
          }
          break;

        case 'getProgramAccounts':
          if (params.length >= 1) {
            const pubkey = new PublicKey(params[0]);
            const config = params[1] || {};
            result = await conn.getProgramAccounts(pubkey, config);
          }
          break;

        case 'getTokenAccountBalance':
          if (params.length >= 1) {
            const pubkey = new PublicKey(params[0]);
            result = await conn.getTokenAccountBalance(pubkey);
          }
          break;

        case 'getTokenAccountsByOwner':
          if (params.length >= 2) {
            const owner = new PublicKey(params[0]);
            let filter;
            if (typeof params[1].mint !== 'undefined') {
              filter = {
                mint: new PublicKey(params[1].mint)
              };
            } else if (typeof params[1].programId !== 'undefined') {
              filter = {
                programId: new PublicKey(params[1].programId)
              };
            }
            const config = params[2] || {};
            if (filter) {
              result = await conn.getTokenAccountsByOwner(owner, filter, config);
            }
          }
          break;

        case 'getEpochInfo':
          result = await conn.getEpochInfo();
          break;

        case 'getLatestBlockhash':
          result = await conn.getLatestBlockhash();
          break;

        case 'getFeeForMessage':
          if (params.length >= 1) {
            result = await conn.getFeeForMessage(params[0], params[1]);
          }
          break;

        case 'getFees':
          // This method doesn't exist directly in Connection, use getRecentBlockhash instead
          // which includes fee information
          const { feeCalculator } = await conn.getRecentBlockhash();
          result = {
            feeCalculator,
            lastValidSlot: await conn.getSlot(),
            lastValidBlockHeight: await conn.getBlockHeight()
          };
          break;

        case 'getMinimumBalanceForRentExemption':
          if (params.length >= 1) {
            result = await conn.getMinimumBalanceForRentExemption(params[0]);
          }
          break;

        case 'getMultipleAccounts':
          if (params.length >= 1) {
            const pubkeys = params[0].map((key: string) => new PublicKey(key));
            const config = params[1] || {};
            result = await conn.getMultipleAccountsInfo(pubkeys, config);
          }
          break;

        case 'getInflationGovernor':
          result = await conn.getInflationGovernor();
          break;

        case 'getInflationRate':
          result = await conn.getInflationRate();
          break;

        case 'getSupply':
          result = await conn.getSupply();
          break;

        case 'getTokenSupply':
          if (params.length >= 1) {
            const pubkey = new PublicKey(params[0]);
            result = await conn.getTokenSupply(pubkey);
          }
          break;

        case 'getVoteAccounts':
          result = await conn.getVoteAccounts();
          break;

        case 'isBlockhashValid':
          if (params.length >= 1) {
            result = await conn.isBlockhashValid(params[0]);
          }
          break;

        case 'getIdentity':
          // This method doesn't exist directly, use getClusterNodes
          const nodes = await conn.getClusterNodes();
          const identity = nodes.find(node => node.pubkey);
          result = identity ? { identity: identity.pubkey } : { identity: null };
          break;

        default:
          return {
            jsonrpc: "2.0",
            id: request.id,
            error: {
              code: -32601,
              message: "Method " + method + " not supported or implemented"
            },
            responseTime: Date.now() - startTime,
            cacheHit: false
          };
      }

      const responseTime = Date.now() - startTime;
      await this.recordCacheMiss(method, responseTime);

      // Cache the result
      if (result !== undefined) {
        await this.cacheData(cacheKey, result, method, params);

        // Update lookup table for fast future access
        await this.updateLookupTable(method, params, cacheKey);

        return {
          jsonrpc: "2.0",
          id: request.id,
          result,
          responseTime: responseTime,
          cacheHit: false
        };
      } else {
        return {
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32602,
            message: "Invalid params"
          },
          responseTime: Date.now() - startTime,
          cacheHit: false
        };
      }
    } catch (error) {
      console.error("Error processing RPC request:", error);

      // Log more detailed error information
      console.error("Error details:", error);

      const responseTime = Date.now() - startTime;

      // Check if error indicates a 403 Forbidden from the upstream RPC
      // This often happens when using public RPCs from Cloudflare IPs
      const errorString = String(error);
      if (errorString.includes('403 Forbidden') || errorString.includes('blocked')) {
        return {
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32003, // Custom code for RPC endpoint rejection
            message: "RPC endpoint rejected the request. You may need to use a paid RPC service instead of the public endpoint."
          },
          responseTime: responseTime,
          cacheHit: false
        };
      }

      return {
        jsonrpc: "2.0",
        id: request.id,
        error: {
          code: -32603,
          message: "Internal error: " + error
        },
        responseTime: responseTime,
        cacheHit: false
      };
    }
  }

  /**
   * Process a batch of RPC requests
   * @param requests array of RPC requests
   * @returns array of RPC responses
   */
  async processBatchRequests(requests: RpcRequest[]): Promise<RpcResponse[]> {
    const startTime = Date.now(); // Add startTime for response time tracking
    // Group requests by method to optimize caching
    const methodGroups: Record<string, RpcRequest[]> = {};

    requests.forEach(req => {
      if (!methodGroups[req.method]) {
        methodGroups[req.method] = [];
      }
      methodGroups[req.method].push(req);
    });

    // Process requests by method group
    const responses: RpcResponse[] = [];
    for (const [method, reqs] of Object.entries(methodGroups)) {
      const results = await Promise.all(reqs.map(req => this.processSolanaRpc(req)));
      responses.push(...results);
    }

    // Re-order responses to match request order
    return requests.map(req => {
      return responses.find(res => res.id === req.id) || {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32603, message: "Internal error" },
        responseTime: Date.now() - startTime,
        cacheHit: false
      };
    });
  }

  /**
   * Clear expired cache entries
   * @returns number of entries cleaned
   */
  async clearExpiredCache(): Promise<number> {
    const prefix = 'solana-rpc:';
    const keys = await this.listData(prefix);
    let cleaned = 0;

    const now = Date.now();

    for (const key of keys) {
      const data = await this.retrieveData(key);
      if (!data) continue;

      try {
        const parsed = JSON.parse(data);
        const metadata = parsed.metadata as CacheMetadata;

        // Only attempt to delete if expiresAt exists and is in the past
        if (metadata.expiresAt && metadata.expiresAt < now) {
          await this.env.DATA_BUCKET.delete(key);
          cleaned++;
        }
      } catch (e) {
        console.error("Error parsing cached data for", key, ":", e);
      }
    }

    return cleaned;
  }

  /**
   * List entries in the lookup table KV namespace
   * @param prefix Optional prefix to filter entries
   * @returns Array of lookup table keys
   * @private
   */
  private async listLookupEntries(prefix: string = ''): Promise<string[]> {
    const lookupTable = this.getLookupTable();
    try {
      const keys = await lookupTable.listKeys(prefix);
      return keys;
    } catch (error) {
      console.error("Error listing lookup table entries:", error);
      return [];
    }
  }

  // generateHomePage function removed - using static files now

  /**
   * Handle WebSocket connections
   * @param webSocket WebSocket instance
   * @private
   */
  private async handleWebSocket(webSocket: WebSocket): Promise<void> {
    webSocket.accept();

    // Add to active connections
    this.activeWebSockets.set(webSocket, new Set());

    webSocket.addEventListener('message', async (event) => {
      try {
        const message = JSON.parse(event.data as string);

        // Handle subscription requests
        if (message.method === 'subscribe') {
          const subscriptionId = message.id || Math.random().toString(36).substring(2);
          const subscription: WebSocketSubscription = {
            id: subscriptionId,
            method: message.params.method,
            params: message.params.params || []
          };

          // Store subscription details
          this.subscriptions.set(subscriptionId, subscription);

          // Add subscription ID to this client's set
          const clientSubscriptions = this.activeWebSockets.get(webSocket);
          if (clientSubscriptions) {
            clientSubscriptions.add(subscriptionId);
          }

          // Send confirmation
          webSocket.send(JSON.stringify({
            jsonrpc: '2.0',
            result: subscriptionId,
            id: message.id
          }));

          // Send initial data
          await this.handleSubscription(webSocket, subscriptionId);
        }
        // Handle unsubscription requests
        else if (message.method === 'unsubscribe') {
          const subscriptionId = message.params[0];

          // Remove from client's subscriptions
          const clientSubscriptions = this.activeWebSockets.get(webSocket);
          if (clientSubscriptions) {
            clientSubscriptions.delete(subscriptionId);
          }

          // Check if any other client is using this subscription
          let isUsed = false;
          for (const subIds of this.activeWebSockets.values()) {
            if (subIds.has(subscriptionId)) {
              isUsed = true;
              break;
            }
          }

          // If not used by anyone, remove the global subscription
          if (!isUsed) {
            this.subscriptions.delete(subscriptionId);
          }

          // Send confirmation
          webSocket.send(JSON.stringify({
            jsonrpc: '2.0',
            result: true,
            id: message.id
          }));
        }
      } catch (error) {
        console.error('Error handling WebSocket message:', error);
        webSocket.send(JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32700, message: 'Parse error' }
        }));
      }
    });

    webSocket.addEventListener('close', () => {
      // Clean up subscriptions for this client
      const clientSubscriptions = this.activeWebSockets.get(webSocket);
      if (clientSubscriptions) {
        for (const subscriptionId of clientSubscriptions) {
          // Check if any other client is using this subscription
          let isUsed = false;
          for (const [ws, subIds] of this.activeWebSockets.entries()) {
            if (ws !== webSocket && subIds.has(subscriptionId)) {
              isUsed = true;
              break;
            }
          }
          // If not used by anyone else, remove the global subscription
          if (!isUsed) {
            this.subscriptions.delete(subscriptionId);
          }
        }
      }

      // Remove client from active connections
      this.activeWebSockets.delete(webSocket);
      console.log('WebSocket closed');
    });

    webSocket.addEventListener('error', (error) => {
      console.error('WebSocket error:', error);
      // Clean up similar to 'close' event
      const clientSubscriptions = this.activeWebSockets.get(webSocket);
      if (clientSubscriptions) {
        for (const subscriptionId of clientSubscriptions) {
          let isUsed = false;
          for (const [ws, subIds] of this.activeWebSockets.entries()) {
            if (ws !== webSocket && subIds.has(subscriptionId)) {
              isUsed = true;
              break;
            }
          }
          if (!isUsed) {
            this.subscriptions.delete(subscriptionId);
          }
        }
      }
      this.activeWebSockets.delete(webSocket);
    });
  }

  /**
   * Handle a single subscription update
   * @param webSocket WebSocket instance
   * @param subscriptionId Subscription ID
   * @private
   */
  private async handleSubscription(webSocket: WebSocket, subscriptionId: string | number): Promise<void> {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) return;

    try {
      const request: RpcRequest = {
        jsonrpc: '2.0',
        id: subscriptionId, // Use subscription ID for tracking
        method: subscription.method,
        params: subscription.params
      };

      const response = await this.processSolanaRpc(request);

      // Check if data has changed since last update
      if (JSON.stringify(response.result) === JSON.stringify(subscription.lastResponse)) {
        return; // No change, don't send update
      }

      // Update stored data
      subscription.lastResponse = response.result;
      subscription.lastTimestamp = Date.now();

      // Send notification
      webSocket.send(JSON.stringify({
        jsonrpc: '2.0',
        method: 'subscription',
        params: {
          subscription: subscriptionId,
          result: response.result
        },
        responseTime: response.responseTime,
        cacheHit: response.cacheHit
      }));
    } catch (error) {
      console.error("Error handling subscription", subscriptionId, ":", error);
    }
  }

  /**
   * Update all active subscriptions
   */
  async updateSubscriptions(): Promise<void> {
    // Process each subscription
    for (const [subscriptionId, subscription] of this.subscriptions.entries()) {
      // Find all clients subscribed to this
      for (const [webSocket, subIds] of this.activeWebSockets.entries()) {
        if (subIds.has(subscriptionId)) {
          await this.handleSubscription(webSocket, subscriptionId);
        }
      }
    }
  }

  /**
   * Verify API authentication
   * @param request Request object
   * @returns Boolean indicating if authentication is valid
   */
  private verifyApiAuth(request: Request): boolean {
    const auth = request.headers.get('Authorization');
    const token = auth?.startsWith('Bearer ') ? auth.split('Bearer ')[1] : null;

    // Debug logging
    console.log('Auth header:', auth);
    console.log('Extracted token:', token);
    console.log('API_KEY from env:', this.env.API_KEY); // Corrected variable name
    console.log('Token matches API_KEY:', token === this.env.API_KEY); // Corrected variable name

    // Use API_KEY for authentication now
    return token === this.env.API_KEY;
  }

  // Removed: getPreferredLanguage method


  /**
   * @ignore
   **/
  async fetch(request: Request): Promise<Response> {
    // `env` and `ctx` are accessed via `this.env` and `this.ctx` in class methods
    await this.loadCacheMetrics(); // Ensure metrics are loaded

    const url = new URL(request.url);
    const path = url.pathname;

    // Removed: Static asset serving logic


    // Check if it's a WebSocket request
    if (request.headers.get('Upgrade') === 'websocket') {
      const upgradeHeader = request.headers.get('Upgrade');
      if (upgradeHeader !== 'websocket') {
        return new Response('Expected websocket', { status: 400 });
      }

      const [client, server] = Object.values(new WebSocketPair());

      // Handle the WebSocket connection in a separate function
      await this.handleWebSocket(server);

      return new Response(null, {
        status: 101,
        webSocket: client
      });
    }

    // Continue with regular HTTP handling

    // Get client IP for rate limiting
    const clientIp = request.headers.get('CF-Connecting-IP') || 'unknown';

    // Check API authentication for all API endpoints (using API_KEY now)
    if (path.startsWith('/api/')) {
      // Debug the environment variables
      console.log('All environment variables:', Object.keys(this.env));
      console.log('API_KEY type:', typeof this.env.API_KEY);
      console.log('API_KEY length:', this.env.API_KEY ? this.env.API_KEY.length : 0);

      const isAuthorized = this.verifyApiAuth(request);
      console.log('Path:', path, 'Is authorized:', isAuthorized);

      if (!isAuthorized) {
        return new Response('Unauthorized', { status: 401 });
      }

      // If we reach here, authentication passed
      // For API test endpoint, return a success message
      if (path === '/api/test') {
        return new Response(JSON.stringify({
          success: true,
          message: 'API authentication successful'
        }), {
          headers: { 'Content-Type': 'application/json' }
        });
      }
      // Note: Other /api/ paths might fall through to JSON-RPC handling below if path is '/'
    }

    // Removed: Static HTML home page handling


    // Check if it's a JSON-RPC request (typically POST to root or specific endpoint)
    if ((path === '/' || path === '') && request.method === 'POST' &&
        request.headers.get('Content-Type')?.includes('application/json')) {

      // Check API Auth (using API_KEY) for POST requests to root
      const isAuthorized = this.verifyApiAuth(request);
       if (!isAuthorized) {
         return new Response('Unauthorized', { status: 401 });
       }

      // Check if rate limited
      if (this.isRateLimited(clientIp)) {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32429,
            message: "Too many requests, please try again later"
          }
        }), {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '60'
          }
        });
      }

      try {
        const body = await request.json() as RpcRequest | RpcRequest[];

        // Handle batch requests
        if (Array.isArray(body)) {
          const responses = await this.processBatchRequests(body);
          return new Response(JSON.stringify(responses), {
            headers: { 'Content-Type': 'application/json' }
          });
        }

        // Handle single request
        const response = await this.processSolanaRpc(body);
        return new Response(JSON.stringify(response), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (error) {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32700,
            message: "Parse error"
          }
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Handle cleanup requests - only with proper authorization
    if (path.includes('/admin/cleanup')) {
      const authHeader = request.headers.get('Authorization');
      if (authHeader !== `Bearer ${this.env.SHARED_SECRET}`) {
        return new Response(JSON.stringify({
          error: "Unauthorized",
          message: "Invalid or missing authentication"
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const cleaned = await this.clearExpiredCache();
      return new Response(JSON.stringify({
        success: true,
        cleaned,
        message: "Cleaned " + cleaned + " expired cache entries"
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Handle metrics endpoint - only with proper authorization
    if (path.includes('/admin/metrics')) {
      const authHeader = request.headers.get('Authorization');
      if (authHeader !== `Bearer ${this.env.SHARED_SECRET}`) {
        return new Response(JSON.stringify({
          error: "Unauthorized",
          message: "Invalid or missing authentication"
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      return new Response(JSON.stringify(this.cacheMetrics), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Handle status endpoint
    if (path.includes('/status')) {
      return new Response(JSON.stringify({
        status: 'ok',
        version: '1.0.0', // Consider making this dynamic
        timestamp: Date.now(),
        cacheMetrics: {
          hits: this.cacheMetrics.hits,
          misses: this.cacheMetrics.misses,
          hitRate: this.cacheMetrics.hits + this.cacheMetrics.misses > 0
            ? (this.cacheMetrics.hits / (this.cacheMetrics.hits + this.cacheMetrics.misses)) * 100
            : 0
        }
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // List lookup table entries
    if (path.includes('/admin/lookup')) {
      const authHeader = request.headers.get('Authorization');
      if (authHeader !== `Bearer ${this.env.SHARED_SECRET}`) {
        return new Response(JSON.stringify({
          error: "Unauthorized",
          message: "Invalid or missing authentication"
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const prefix = url.searchParams.get('prefix') || '';
      const entries = await this.listLookupEntries(prefix);

      return new Response(JSON.stringify({
        success: true,
        entries,
        count: entries.length
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Get cached data by key
    if (path.includes('/admin/get')) {
      const authHeader = request.headers.get('Authorization');
      if (authHeader !== `Bearer ${this.env.SHARED_SECRET}`) {
        return new Response(JSON.stringify({
          error: "Unauthorized",
          message: "Invalid or missing authentication"
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const key = url.searchParams.get('key');
      if (!key) {
        return new Response(JSON.stringify({
          error: "Missing parameter",
          message: "Key parameter is required"
        }), {
          status: 400,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const data = await this.retrieveData(key);
      if (data) {
        try {
          const parsed = JSON.parse(data);
          return new Response(JSON.stringify({
            success: true,
            key,
            data: parsed
          }), {
            headers: { 'Content-Type': 'application/json' }
          });
        } catch (e) {
          return new Response(JSON.stringify({
            success: true,
            key,
            data: data,
            note: "Data could not be parsed as JSON"
          }), {
            headers: { 'Content-Type': 'application/json' }
          });
        }
      } else {
        return new Response(JSON.stringify({
          success: false,
          key,
          message: "No data found for this key"
        }), {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // List data from R2 bucket
    if (path.includes('/admin/list-data')) {
      const authHeader = request.headers.get('Authorization');
      if (authHeader !== `Bearer ${this.env.SHARED_SECRET}`) {
        return new Response(JSON.stringify({
          error: "Unauthorized",
          message: "Invalid or missing authentication"
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' }
        });
      }

      const prefix = url.searchParams.get('prefix') || '';
      const keys = await this.listData(prefix);

      return new Response(JSON.stringify({
        success: true,
        keys,
        count: keys.length
      }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // Removed: Fallback GET request handling for static assets


    // If not handled by RPC, admin, status, or WebSocket, return 404
     return new Response('Not Found', { status: 404 });
  }
}
