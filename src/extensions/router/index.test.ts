import type { Api, Model } from "@earendil-works/pi-ai"
import type { ScopedModel } from "@earendil-works/pi-coding-agent"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createContext } from "../__mocks__/context.js"
import { createExtensionApi } from "../__mocks__/extension-api.js"

const routeQueryMock = vi.fn<(...args: unknown[]) => Promise<{ best_model: string } | null>>()
vi.mock("./router-client.js", () => ({
	routeQuery: (...args: unknown[]) => routeQueryMock(...args),
}))

const getRouterConfigMock = vi.fn<(...args: unknown[]) => Promise<{ endpoint: string; apiKey: string } | null>>()
vi.mock("./router-config.js", () => ({
	getRouterConfig: (...args: unknown[]) => getRouterConfigMock(...args),
}))

const routerExtension = (await import("./index.js")).default

const MODELS: Model<Api>[] = [
	{
		id: "glm-5.2-fp8",
		name: "GLM 5.2",
		provider: "kimchi-dev",
		api: "openai",
		baseUrl: "https://llm.kimchi.dev/openai/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
	},
	{
		id: "kimi-k2.7",
		name: "Kimi K2.7",
		provider: "kimchi-dev",
		api: "openai",
		baseUrl: "https://llm.kimchi.dev/openai/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 256_000,
		maxTokens: 4096,
	},
]

function createCtx(options: { available?: Model<Api>[]; scopedModels?: ScopedModel[]; model?: Model<Api> } = {}) {
	return createContext({
		model: options.model,
		scopedModels: options.scopedModels ?? [],
		modelRegistry: {
			getAvailable: () => options.available ?? MODELS,
		},
	})
}

const defaultEvent = {
	type: "before_agent_start" as const,
	prompt: "hey",
	systemPrompt: "",
	systemPromptOptions: {} as never,
}
describe("routerExtension", () => {
	beforeEach(() => {
		getRouterConfigMock.mockResolvedValue({ endpoint: "https://llm.kimchi.dev", apiKey: "test-key" })
		routeQueryMock.mockResolvedValue({ best_model: "glm-5.2-fp8" })
	})

	afterEach(() => {
		vi.clearAllMocks()
		vi.restoreAllMocks()
	})

	it("routes the first prompt and switches to the recommended Kimchi model", async () => {
		const { api, getHandler, setModel } = createExtensionApi()
		routerExtension(api)
		const ctx = createCtx()

		await getHandler("before_agent_start")({ ...defaultEvent, prompt: "write a web server" }, ctx)

		expect(getRouterConfigMock).toHaveBeenCalledWith(ctx.modelRegistry)
		expect(routeQueryMock).toHaveBeenCalledWith("write a web server", expect.anything(), undefined)
		expect(setModel).toHaveBeenCalledOnce()
		expect(setModel).toHaveBeenCalledWith(MODELS[0])
	})

	it("does not re-route later prompts in the same session", async () => {
		const { api, getHandler, setModel } = createExtensionApi()
		routerExtension(api)
		const handler = getHandler("before_agent_start")
		const ctx = createCtx()

		await handler({ ...defaultEvent, prompt: "first" }, ctx)
		await handler({ ...defaultEvent, prompt: "second" }, ctx)

		expect(routeQueryMock).toHaveBeenCalledOnce()
		expect(setModel).toHaveBeenCalledOnce()
	})

	it.each(["startup", "new", "fork"] as const)("resets routing for a %s session", async (reason) => {
		const { api, getHandler, setModel } = createExtensionApi()
		routerExtension(api)
		const ctx = createCtx()
		const promptHandler = getHandler("before_agent_start")

		await promptHandler(defaultEvent, ctx)
		await getHandler("session_start")({ type: "session_start", reason }, ctx)
		await promptHandler(defaultEvent, ctx)

		expect(setModel).toHaveBeenCalledTimes(2)
	})

	it.each(["reload", "resume"] as const)("does not re-route after a %s", async (reason) => {
		const { api, getHandler, setModel } = createExtensionApi()
		routerExtension(api)
		const ctx = createCtx()
		const promptHandler = getHandler("before_agent_start")

		await promptHandler(defaultEvent, ctx)
		await getHandler("session_start")({ type: "session_start", reason }, ctx)
		await promptHandler(defaultEvent, ctx)

		expect(routeQueryMock).toHaveBeenCalledOnce()
		expect(setModel).toHaveBeenCalledOnce()
	})

	it("keeps routing state isolated between concurrent session instances", async () => {
		const first = createExtensionApi()
		const second = createExtensionApi()
		routerExtension(first.api)
		routerExtension(second.api)

		await first.getHandler("before_agent_start")(defaultEvent, createCtx())
		await second.getHandler("before_agent_start")(defaultEvent, createCtx())

		expect(first.setModel).toHaveBeenCalledOnce()
		expect(second.setModel).toHaveBeenCalledOnce()
		expect(routeQueryMock).toHaveBeenCalledTimes(2)
	})

	it("honors the session's model scope", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		const { api, getHandler, setModel } = createExtensionApi()
		routerExtension(api)

		await getHandler("before_agent_start")(defaultEvent, createCtx({ scopedModels: [{ model: MODELS[1] }] }))

		expect(setModel).not.toHaveBeenCalled()
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("current model scope"))
	})

	it("does not select a same-id model from another provider", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		const duplicate = { ...MODELS[0], provider: "other-provider" }
		const { api, getHandler, setModel } = createExtensionApi()
		routerExtension(api)

		await getHandler("before_agent_start")(defaultEvent, createCtx({ available: [duplicate, MODELS[1]] }))

		expect(setModel).not.toHaveBeenCalled()
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Recommended Kimchi model"))
	})

	it("does not switch an image prompt to a text-only model", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})
		const { api, getHandler, setModel } = createExtensionApi()
		routerExtension(api)

		await getHandler("before_agent_start")(
			{ ...defaultEvent, images: [{ type: "image", data: "base64", mimeType: "image/png" }] },
			createCtx(),
		)

		expect(setModel).not.toHaveBeenCalled()
		expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("does not support this prompt's images"))
	})

	it("allows an image prompt to use a vision-capable recommendation", async () => {
		routeQueryMock.mockResolvedValue({ best_model: "kimi-k2.7" })
		const { api, getHandler, setModel } = createExtensionApi()
		routerExtension(api)

		await getHandler("before_agent_start")(
			{ ...defaultEvent, images: [{ type: "image", data: "base64", mimeType: "image/png" }] },
			createCtx(),
		)

		expect(setModel).toHaveBeenCalledWith(MODELS[1])
	})

	it("does not append a redundant model change when the recommendation is already active", async () => {
		const { api, getHandler, setModel } = createExtensionApi()
		routerExtension(api)

		await getHandler("before_agent_start")(defaultEvent, createCtx({ model: MODELS[0] }))

		expect(routeQueryMock).toHaveBeenCalledOnce()
		expect(setModel).not.toHaveBeenCalled()
	})

	it("skips silently when no router credential is available", async () => {
		getRouterConfigMock.mockResolvedValue(null)
		const { api, getHandler, setModel } = createExtensionApi()
		routerExtension(api)

		await getHandler("before_agent_start")(defaultEvent, createCtx())

		expect(routeQueryMock).not.toHaveBeenCalled()
		expect(setModel).not.toHaveBeenCalled()
	})

	it("continues with the current model when the router request fails", async () => {
		routeQueryMock.mockResolvedValue(null)
		const { api, getHandler, setModel } = createExtensionApi()
		routerExtension(api)

		await expect(getHandler("before_agent_start")(defaultEvent, createCtx())).resolves.toBeUndefined()
		expect(setModel).not.toHaveBeenCalled()
	})
})
