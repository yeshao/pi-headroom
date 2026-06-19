/**
 * CCR (Compress-Cache-Retrieve) store.
 *
 * The headroom proxy maintains its own internal CCR store. When messages
 * are compressed with CCR enabled, the proxy replaces content with a
 * marker containing a hash and caches the original for later retrieval.
 *
 * This module wraps the proxy's /v1/retrieve endpoint so callers can
 * fetch original content by hash within a session.
 *
 * The proxy's store is per-process. The underlying cache persists until
 * the proxy exits or its TTL expires.
 */

import type { HeadroomClientInterface } from "headroom-ai";

export class CCRStore {
	private client: HeadroomClientInterface;

	constructor(client: HeadroomClientInterface) {
		this.client = client;
	}

	/**
	 * Retrieve original content by CCR hash from the proxy's store.
	 * Returns undefined if the hash is unknown, expired, or not a string.
	 */
	async retrieve(hash: string): Promise<string | undefined> {
		const result = await this.client.retrieve(hash);
		if (
			result !== undefined &&
			result !== null &&
			typeof result === "object" &&
			"content" in result &&
			typeof (result as Record<string, unknown>).content === "string"
		) {
			return (result as Record<string, string>).content;
		}
		return undefined;
	}

	/**
	 * Check if a hash is retrievable (best-effort probe).
	 */
	async has(hash: string): Promise<boolean> {
		const result = await this.client.retrieve(hash);
		return result !== undefined && result !== null;
	}
}
