/**
 * HTTP client for the LLM Router service.
 *
 * Calls `POST /v1/route` with the user's query and returns the
 * recommended model id. All failures are non-fatal — the caller
 * treats null as "skip routing."
 */

import type { RouterConfig } from "./router-config.js"

export interface RouteResult {
	best_model: string
}

const ROUTE_TIMEOUT_MS = 5000
const ROUTE_PATH = "/v1/route"

/**
 * Ask the router service which model best fits the given query.
 * Returns null on any error (network, HTTP, missing config, parse failure).
 */
export async function routeQuery(
	query: string,
	config: RouterConfig,
	options?: { fetchImpl?: typeof fetch; signal?: AbortSignal },
): Promise<RouteResult | null> {
	if (query.trim().length === 0) return null

	const fetchImpl = options?.fetchImpl ?? fetch

	const url = `${config.endpoint.replace(/\/+$/, "")}${ROUTE_PATH}`

	const controller = new AbortController()
	const timeout = setTimeout(() => controller.abort(), ROUTE_TIMEOUT_MS)

	// If the caller provided a signal, abort when it fires too.
	const externalSignal = options?.signal
	const onExternalAbort = () => controller.abort()
	if (externalSignal?.aborted) controller.abort()
	else externalSignal?.addEventListener("abort", onExternalAbort)

	try {
		const response = await fetchImpl(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-API-Key": config.apiKey,
			},
			body: JSON.stringify({ query }),
			signal: controller.signal,
		})

		if (!response.ok) return null

		const data: unknown = await response.json()
		if (!data || typeof data !== "object" || !("best_model" in data) || typeof data.best_model !== "string") {
			return null
		}
		const bestModel = data.best_model.trim()
		if (!bestModel) return null

		return { best_model: bestModel }
	} catch {
		return null
	} finally {
		clearTimeout(timeout)
		externalSignal?.removeEventListener("abort", onExternalAbort)
	}
}
