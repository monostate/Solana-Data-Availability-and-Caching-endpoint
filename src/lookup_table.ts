import { PublicKey } from '@solana/web3.js';

// Interface removed as KVNamespace is passed directly

/**
 * Lookup Table implementation using Cloudflare KV to map transaction IDs
 * and addresses to R2 storage locations
 */
export class LookupTable {
  // Accept the KVNamespace directly in the constructor
  constructor(private kv: KVNamespace) {}

  /**
   * Store a mapping from a transaction ID to an R2 key
   * @param txId Transaction ID
   * @param r2Key R2 storage key
   */
  async storeTxMapping(txId: string, r2Key: string): Promise<void> {
    // Use the passed-in kv namespace
    await this.kv.put(`tx:${txId}`, r2Key, {
      expirationTtl: 60 * 60 * 24 * 7, // 7 days - historical tx data rarely changes
    });
  }

  /**
   * Get R2 key for a transaction ID
   * @param txId Transaction ID
   */
  async getTxMapping(txId: string): Promise<string | null> {
    return this.kv.get(`tx:${txId}`);
  }

  /**
   * Store a mapping from a mint address to an R2 key
   * @param mintAddress Token mint address
   * @param r2Key R2 storage key
   * @param ttlSeconds Optional TTL in seconds (default: 1 hour)
   */
  async storeMintMapping(mintAddress: string, r2Key: string, ttlSeconds = 3600): Promise<void> {
    try {
      // Validate it's a real public key
      new PublicKey(mintAddress);

      await this.kv.put(`mint:${mintAddress}`, r2Key, {
        expirationTtl: ttlSeconds,
      });
    } catch (error) {
      console.error(`Invalid mint address: ${mintAddress}`);
    }
  }

  /**
   * Get R2 key for a mint address
   * @param mintAddress Token mint address
   */
  async getMintMapping(mintAddress: string): Promise<string | null> {
    return this.kv.get(`mint:${mintAddress}`);
  }

  /**
   * Store a mapping from an account address to an R2 key
   * @param accountAddress Account address
   * @param r2Key R2 storage key
   * @param ttlSeconds Optional TTL in seconds (default: 10 minutes)
   */
  async storeAccountMapping(accountAddress: string, r2Key: string, ttlSeconds = 600): Promise<void> {
    try {
      // Validate it's a real public key
      new PublicKey(accountAddress);

      await this.kv.put(`acct:${accountAddress}`, r2Key, {
        expirationTtl: ttlSeconds,
      });
    } catch (error) {
      console.error(`Invalid account address: ${accountAddress}`);
    }
  }

  /**
   * Get R2 key for an account address
   * @param accountAddress Account address
   */
  async getAccountMapping(accountAddress: string): Promise<string | null> {
    return this.kv.get(`acct:${accountAddress}`);
  }

  /**
   * Store a data hash mapping (for ZK compression emulation)
   * @param dataHash Hash of the data
   * @param r2Key R2 storage key
   */
  async storeDataHash(dataHash: string, r2Key: string): Promise<void> {
    await this.kv.put(`hash:${dataHash}`, r2Key, {
      expirationTtl: 60 * 60 * 24 * 30, // 30 days - hashed data doesn't change
    });
  }

  /**
   * Get R2 key for a data hash
   * @param dataHash Hash of the data
   */
  async getDataHash(dataHash: string): Promise<string | null> {
    return this.kv.get(`hash:${dataHash}`);
  }

  /**
   * List all keys with a given prefix
   * @param prefix Key prefix (tx, mint, acct, hash)
   * @param limit Maximum number of keys to return
   */
  async listKeys(prefix: string, limit = 100): Promise<string[]> {
    const keys: string[] = [];
    const list = await this.kv.list({ prefix, limit });

    for (const key of list.keys) {
      keys.push(key.name);
    }
    
    return keys;
  }

  /**
   * Delete a key from the lookup table
   * @param key Full key name
   */
  async deleteKey(key: string): Promise<void> {
    await this.kv.delete(key);
  }
}
