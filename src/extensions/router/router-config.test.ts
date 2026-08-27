import { afterEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { getRouterConfig } from "./router-config.js"

function createRegistry(apiKey: string | undefined) {
	return createContext({
		modelRegistry: {
			getApiKeyForProvider: vi.fn().mockResolvedValue(apiKey),
		},
	}).modelRegistry
}

describe("getRouterConfig", () => {
	afterEach(() => {
		vi.unstubAllEnvs()
		vi.restoreAllMocks()
	})

	it("uses the configured Kimchi provider credential and default endpoint", async () => {
		const registry = createRegistry("configured-key")

		await expect(getRouterConfig(registry)).resolves.toEqual({
			endpoint: "https://llm.kimchi.dev",
			apiKey: "configured-key",
		})
		expect(registry.getApiKeyForProvider).toHaveBeenCalledWith("kimchi-dev")
	})

	it("allows dedicated endpoint and API-key overrides", async () => {
		vi.stubEnv("KIMCHI_ROUTER_ENDPOINT", "  https://router.example.test/  ")
		vi.stubEnv("KIMCHI_ROUTER_API_KEY", "  override-key  ")
		const registry = createRegistry("configured-key")

		await expect(getRouterConfig(registry)).resolves.toEqual({
			endpoint: "https://router.example.test/",
			apiKey: "override-key",
		})
		expect(registry.getApiKeyForProvider).not.toHaveBeenCalled()
	})

	it("returns null when Kimchi has no usable credential", async () => {
		vi.stubEnv("KIMCHI_ROUTER_API_KEY", "   ")
		await expect(getRouterConfig(createRegistry(undefined))).resolves.toBeNull()
	})

	it("returns null when credential resolution fails", async () => {
		const registry = createRegistry(undefined)
		vi.mocked(registry.getApiKeyForProvider).mockRejectedValue(new Error("auth storage unavailable"))
		await expect(getRouterConfig(registry)).resolves.toBeNull()
	})
})
