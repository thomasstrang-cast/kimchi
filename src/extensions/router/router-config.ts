/**
 * Configuration for the LLM Router extension.
 *
 * Reads the endpoint and resolves the API key from Kimchi's configured
 * provider credentials:
 *   - KIMCHI_ROUTER_ENDPOINT (default: https://llm.kimchi.dev)
 *   - KIMCHI_ROUTER_API_KEY  (optional override)
 *
 * The dedicated key is useful for development, but regular users should not
 * need a second credential after running `kimchi setup` or `/login`.
 */

import type { ModelRegistry } from "@earendil-works/pi-coding-agent"
import { KIMCHI_DEV_PROVIDER } from "../orchestration/model-registry/index.js"

export interface RouterConfig {
	endpoint: string
	apiKey: string
}

const DEFAULT_ENDPOINT = "https://llm.kimchi.dev"

export async function getRouterConfig(
	modelRegistry: Pick<ModelRegistry, "getApiKeyForProvider">,
): Promise<RouterConfig | null> {
	const apiKeyOverride = process.env.KIMCHI_ROUTER_API_KEY?.trim()
	let apiKey = apiKeyOverride
	if (!apiKey) {
		try {
			apiKey = (await modelRegistry.getApiKeyForProvider(KIMCHI_DEV_PROVIDER))?.trim()
		} catch {
			return null
		}
	}
	if (!apiKey) return null

	const endpoint = process.env.KIMCHI_ROUTER_ENDPOINT?.trim() || DEFAULT_ENDPOINT

	return { endpoint, apiKey }
}
