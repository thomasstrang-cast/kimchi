import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type RouteResult, routeQuery } from "./router-client.js"
import type { RouterConfig } from "./router-config.js"

const mockConfig: RouterConfig = {
	endpoint: "https://llm.kimchi.dev",
	apiKey: "test-key-123",
}

function mockFetch(body: unknown, ok = true, status = 200): typeof fetch {
	return vi.fn(async () => ({
		ok,
		status,
		json: async () => body,
	})) as unknown as typeof fetch
}

describe("routeQuery", () => {
	beforeEach(() => {
		vi.useFakeTimers()
	})
	afterEach(() => {
		vi.useRealTimers()
		vi.restoreAllMocks()
	})

	it("returns best_model on a successful 200 response", async () => {
		const fetchImpl = mockFetch({
			best_model: "glm-5.2-fp8",
			best_model_idx: 1,
			probabilities: { "glm-5.2-fp8": 0.82 },
			logits: { "glm-5.2-fp8": 1.5 },
		})

		const result = await routeQuery("explain transformers", mockConfig, { fetchImpl })

		expect(result).toEqual<RouteResult>({ best_model: "glm-5.2-fp8" })

		// Verify request shape
		const fn = fetchImpl as unknown as ReturnType<typeof vi.fn>
		expect(fn).toHaveBeenCalledTimes(1)
		const [url, init] = fn.mock.calls[0]
		expect(url).toBe("https://llm.kimchi.dev/v1/route")
		expect(init.method).toBe("POST")
		const headers = init.headers as Record<string, string>
		expect(headers["X-API-Key"]).toBe("test-key-123")
		expect(headers["Content-Type"]).toBe("application/json")
		expect(JSON.parse(init.body)).toEqual({ query: "explain transformers" })
	})

	it("strips trailing slashes from endpoint", async () => {
		const fetchImpl = mockFetch({ best_model: "kimi-k2.7", best_model_idx: 0, probabilities: {}, logits: {} })
		await routeQuery("hey", { ...mockConfig, endpoint: "https://llm.kimchi.dev/" }, { fetchImpl })
		const fn = fetchImpl as unknown as ReturnType<typeof vi.fn>
		expect(fn.mock.calls[0][0]).toBe("https://llm.kimchi.dev/v1/route")
	})

	it("returns null on HTTP error (non-200)", async () => {
		const fetchImpl = mockFetch({ detail: "model not loaded" }, false, 503)
		const result = await routeQuery("hey", mockConfig, { fetchImpl })
		expect(result).toBeNull()
	})

	it("returns null when best_model is empty string", async () => {
		const fetchImpl = mockFetch({ best_model: "", best_model_idx: 0, probabilities: {}, logits: {} })
		const result = await routeQuery("hey", mockConfig, { fetchImpl })
		expect(result).toBeNull()
	})

	it("trims the returned model id", async () => {
		const fetchImpl = mockFetch({ best_model: "  kimi-k2.7  " })
		const result = await routeQuery("hey", mockConfig, { fetchImpl })
		expect(result).toEqual({ best_model: "kimi-k2.7" })
	})

	it("returns null when best_model is missing", async () => {
		const fetchImpl = mockFetch({ probabilities: {}, logits: {} })
		const result = await routeQuery("hey", mockConfig, { fetchImpl })
		expect(result).toBeNull()
	})

	it("does not call the service for an empty query", async () => {
		const fetchImpl = mockFetch({ best_model: "kimi-k2.7" })
		const result = await routeQuery("  \n\t", mockConfig, { fetchImpl })
		expect(result).toBeNull()
		expect(fetchImpl).not.toHaveBeenCalled()
	})

	it("returns null on network error (fetch throws)", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("ECONNREFUSED")
		}) as unknown as typeof fetch
		const result = await routeQuery("hey", mockConfig, { fetchImpl })
		expect(result).toBeNull()
	})

	it("returns null when response.json() throws", async () => {
		const fetchImpl = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => {
				throw new SyntaxError("Unexpected token")
			},
		})) as unknown as typeof fetch
		const result = await routeQuery("hey", mockConfig, { fetchImpl })
		expect(result).toBeNull()
	})

	it("aborts on timeout", async () => {
		const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
			return new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => {
					reject(new Error("The operation was aborted"))
				})
			})
		}) as unknown as typeof fetch

		const promise = routeQuery("hey", mockConfig, { fetchImpl })

		// Fast-forward past the 5s timeout
		await vi.advanceTimersByTimeAsync(5100)

		const result = await promise
		expect(result).toBeNull()
	})

	it("passes an already-aborted caller signal to fetch as aborted", async () => {
		const controller = new AbortController()
		controller.abort()
		const fetchImpl = vi.fn(async (_url: string, init: RequestInit) => {
			expect(init.signal?.aborted).toBe(true)
			throw new Error("The operation was aborted")
		}) as unknown as typeof fetch

		const result = await routeQuery("hey", mockConfig, { fetchImpl, signal: controller.signal })

		expect(result).toBeNull()
		expect(fetchImpl).toHaveBeenCalledOnce()
	})
})
