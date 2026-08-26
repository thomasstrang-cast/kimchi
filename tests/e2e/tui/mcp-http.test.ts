import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

function toolResultFor(body: unknown, toolCallId: string): Record<string, unknown> | undefined {
	if (!body || typeof body !== "object") return undefined
	const messages = (body as Record<string, unknown>).messages
	if (!Array.isArray(messages)) return undefined
	return messages.find(
		(message): message is Record<string, unknown> =>
			Boolean(message) &&
			typeof message === "object" &&
			(message as Record<string, unknown>).role === "tool" &&
			(message as Record<string, unknown>).tool_call_id === toolCallId,
	)
}

test("calls a Streamable HTTP MCP tool and preserves configured headers", async ({ terminal }) => {
	const toolCallId = "call_mcp_http_echo"
	await runKimchiSession(
		terminal,
		{
			artifactName: "mcp-http",
			mcp: { transport: "http", headers: { "X-Kimchi-E2E": "fixture-header" } },
			responses: [
				{
					toolCalls: [
						{
							id: toolCallId,
							function: {
								name: "mcp",
								arguments: JSON.stringify({
									tool: "fixture_echo",
									server: "fixture",
									args: JSON.stringify({ message: "streamable-http" }),
								}),
							},
						},
					],
				},
				{ stream: ["The Streamable HTTP MCP tool returned successfully."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Call the MCP fixture over Streamable HTTP")
			await waitForText(terminal, "The Streamable HTTP MCP tool returned successfully.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})

			const call = await fixture.mcp?.waitForEvent(
				(event) => event.type === "tool_called" && event.arguments?.message === "streamable-http",
			)
			expect(call?.name).toBe("echo")
			const requests = fixture.mcp?.readEvents().filter((event) => event.type === "http_request") ?? []
			expect(requests.some((event) => event.testHeader === "fixture-header")).toBe(true)
			expect(requests.some((event) => Boolean(event.sessionId))).toBe(true)

			const continuation = fixture.fake.requests.find((request) => toolResultFor(request.body, toolCallId))
			expect(JSON.stringify(toolResultFor(continuation?.body, toolCallId)?.content)).toContain(
				"fixture echo: streamable-http",
			)
			trace.step("Streamable HTTP session, custom header, and model-facing result verified")
		},
	)
})

test("authenticates to a Streamable HTTP MCP server with a static bearer token", async ({ terminal }) => {
	const toolCallId = "call_mcp_http_bearer_echo"
	await runKimchiSession(
		terminal,
		{
			artifactName: "mcp-http-bearer",
			mcp: { transport: "http", bearerToken: "kimchi-e2e-bearer-token" },
			responses: [
				{
					toolCalls: [
						{
							id: toolCallId,
							function: {
								name: "mcp",
								arguments: JSON.stringify({
									tool: "fixture_echo",
									server: "fixture",
									args: JSON.stringify({ message: "bearer-authenticated" }),
								}),
							},
						},
					],
				},
				{ stream: ["The authenticated MCP request succeeded."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Call the bearer-protected MCP fixture")
			await waitForText(terminal, "The authenticated MCP request succeeded.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})

			await fixture.mcp?.waitForEvent(
				(event) => event.type === "tool_called" && event.arguments?.message === "bearer-authenticated",
			)
			const events = fixture.mcp?.readEvents() ?? []
			expect(events.some((event) => event.type === "http_request" && event.authorized === true)).toBe(true)
			expect(events.some((event) => event.type === "http_unauthorized")).toBe(false)
			trace.step("static bearer authentication verified at the fixture boundary")
		},
	)
})

test("falls back from Streamable HTTP to the legacy MCP SSE transport", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "mcp-sse-fallback",
			mcp: { transport: "sse" },
			responses: [
				{
					toolCalls: [
						{
							id: "call_mcp_sse_echo",
							function: {
								name: "mcp",
								arguments: JSON.stringify({
									tool: "fixture_echo",
									server: "fixture",
									args: JSON.stringify({ message: "legacy-sse" }),
								}),
							},
						},
					],
				},
				{ stream: ["Kimchi completed the MCP call through SSE fallback."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Call MCP through the legacy SSE fallback")
			await waitForText(terminal, "Kimchi completed the MCP call through SSE fallback.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await fixture.mcp?.waitForEvent(
				(event) => event.type === "tool_called" && event.arguments?.message === "legacy-sse",
			)
			const events = fixture.mcp?.readEvents() ?? []
			expect(events.some((event) => event.type === "sse_streamable_rejected")).toBe(true)
			expect(events.some((event) => event.type === "sse_session_initialized")).toBe(true)
			expect(events.some((event) => event.type === "sse_message")).toBe(true)
			trace.step("Streamable HTTP failure and successful SSE fallback both observed")
		},
	)
})

test("keeps Kimchi usable when an HTTP MCP server returns malformed protocol data", async ({ terminal }) => {
	const toolCallId = "call_mcp_malformed_http"
	await runKimchiSession(
		terminal,
		{
			artifactName: "mcp-http-malformed",
			mcp: { transport: "http", scenario: "http-malformed" },
			responses: [
				{
					toolCalls: [
						{
							id: toolCallId,
							function: {
								name: "mcp",
								arguments: JSON.stringify({ tool: "fixture_echo", server: "fixture", args: "{}" }),
							},
						},
					],
				},
				{ stream: ["Kimchi remained usable after malformed MCP HTTP data."] },
			],
		},
		async (fixture, trace) => {
			await fixture.mcp?.waitForEvent((event) => event.type === "http_malformed_response")
			terminal.submit("Continue after malformed MCP HTTP data")
			await waitForText(terminal, "Kimchi remained usable after malformed MCP HTTP data.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			const continuation = fixture.fake.requests.find((request) => toolResultFor(request.body, toolCallId))
			expect(toolResultFor(continuation?.body, toolCallId)).toBeDefined()
			trace.step("malformed HTTP protocol data remained isolated from the main session")
		},
	)
})

test("settles a tool call when a connected HTTP MCP server becomes unavailable", async ({ terminal }) => {
	const toolCallId = "call_mcp_http_unavailable"
	await runKimchiSession(
		terminal,
		{
			artifactName: "mcp-http-unavailable",
			mcp: { transport: "http" },
			responses: [
				{
					toolCalls: [
						{
							id: toolCallId,
							function: {
								name: "mcp",
								arguments: JSON.stringify({
									tool: "fixture_echo",
									server: "fixture",
									args: JSON.stringify({ message: "server-is-down" }),
								}),
							},
						},
					],
				},
				{ stream: ["Kimchi recovered from the unavailable HTTP MCP server."] },
			],
		},
		async (fixture, trace) => {
			await fixture.mcp?.waitForEvent((event) => event.type === "tools_listed")
			await fixture.mcp?.stop()
			terminal.submit("Call the MCP server after it becomes unavailable")
			await waitForText(terminal, "Kimchi recovered from the unavailable HTTP MCP server.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			const continuation = fixture.fake.requests.find((request) => toolResultFor(request.body, toolCallId))
			expect(JSON.stringify(toolResultFor(continuation?.body, toolCallId)?.content)).toContain("Failed to call tool")
			trace.step("HTTP transport loss became a model-facing error and the turn settled")
		},
	)
})
