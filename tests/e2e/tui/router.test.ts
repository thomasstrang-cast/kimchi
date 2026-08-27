import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { expect, test } from "@microsoft/tui-test"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("router is disabled by default", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "router-disabled-by-default",
			providerId: "kimchi-dev",
			models: [
				{ slug: "basic", displayName: "Fake Basic", provider: "ai-enabler" },
				{ slug: "routed", displayName: "Fake Routed", provider: "ai-enabler" },
			],
			routerResponses: [{ best_model: "routed", best_model_idx: 1, probabilities: {}, logits: {} }],
			responses: [{ stream: ["Basic", " response."] }],
			seedHome: (_homeDir, _workDir, fake) => ({ env: { KIMCHI_ROUTER_ENDPOINT: fake.baseUrl } }),
		},
		async (fixture, trace) => {
			terminal.submit("use the configured model")
			trace.step("submitted first prompt")

			await expect(terminal.getByText("Basic response.", { full: true })).toBeVisible()
			trace.step("default model response rendered")

			expect(fixture.fake.requests.some((request) => request.url === "/v1/route")).toBe(false)
			const inferenceRequest = fixture.fake.requests.find((request) =>
				request.url.startsWith("/openai/v1/chat/completions"),
			)
			expect(inferenceRequest?.body).toMatchObject({ model: "basic" })
		},
	)
})

test("enabled router selects the model before the first inference", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "router-first-prompt",
			providerId: "kimchi-dev",
			models: [
				{ slug: "basic", displayName: "Fake Basic", provider: "ai-enabler" },
				{ slug: "routed", displayName: "Fake Routed", provider: "ai-enabler" },
			],
			routerResponses: [{ best_model: "routed", best_model_idx: 1, probabilities: {}, logits: {} }],
			responses: [{ stream: ["Routed", " response."] }],
			seedHome: (homeDir, _workDir, fake) => {
				const settingsPath = join(homeDir, ".config", "kimchi", "harness", "settings.json")
				const settings = JSON.parse(readFileSync(settingsPath, "utf-8"))
				settings.resources = { ...settings.resources, "extensions.router": true }
				writeFileSync(settingsPath, `${JSON.stringify(settings, null, "\t")}\n`, "utf-8")
				return { env: { KIMCHI_ROUTER_ENDPOINT: fake.baseUrl } }
			},
		},
		async (fixture, trace) => {
			terminal.submit("choose the best model for this request")
			trace.step("submitted first prompt")

			await expect(terminal.getByText("Routed response.", { full: true })).toBeVisible()
			trace.step("routed response rendered")

			const routeRequest = fixture.fake.requests.find((request) => request.url === "/v1/route")
			expect(routeRequest).toMatchObject({
				method: "POST",
				body: { query: "choose the best model for this request" },
			})
			expect(routeRequest?.headers["x-api-key"]).toBe("fake")

			const inferenceRequest = fixture.fake.requests.find((request) =>
				request.url.startsWith("/openai/v1/chat/completions"),
			)
			expect(inferenceRequest?.body).toMatchObject({ model: "routed" })
		},
	)
})
