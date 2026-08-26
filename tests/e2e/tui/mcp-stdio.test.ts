import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

const TOOL_CALL_ID = "call_mcp_fixture_echo"
const SENTINEL = "kimchi-mcp-e2e"

function findToolResult(body: unknown, toolCallId = TOOL_CALL_ID): Record<string, unknown> | undefined {
	if (!body || typeof body !== "object") return undefined
	const messages = (body as Record<string, unknown>).messages
	if (!Array.isArray(messages)) return undefined
	return messages.find((message): message is Record<string, unknown> => {
		return Boolean(
			message &&
				typeof message === "object" &&
				(message as Record<string, unknown>).role === "tool" &&
				(message as Record<string, unknown>).tool_call_id === toolCallId,
		)
	})
}

test("calls a stdio MCP tool through the real Kimchi session", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "mcp-stdio",
			mcp: {},
			responses: [
				{
					stream: ["I will ask the MCP fixture."],
					toolCalls: [
						{
							id: TOOL_CALL_ID,
							function: {
								name: "mcp",
								arguments: JSON.stringify({
									tool: "fixture_echo",
									server: "fixture",
									args: JSON.stringify({ message: SENTINEL }),
								}),
							},
						},
					],
				},
				{ stream: ["The MCP fixture returned the expected echo."] },
			],
		},
		async (fixture, trace) => {
			expect(fixture.mcp).toBeDefined()
			terminal.submit("Use the MCP fixture to echo the test sentinel")

			await waitForText(terminal, "The MCP fixture returned the expected echo.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			trace.step("final response visible after MCP tool result")

			const called = await fixture.mcp?.waitForEvent((event) => event.type === "tool_called" && event.name === "echo", {
				description: "echo tool invocation",
			})
			expect(called?.arguments).toEqual({ message: SENTINEL })

			const events = fixture.mcp?.readEvents() ?? []
			expect(events.some((event) => event.type === "initialized")).toBe(true)
			expect(events.some((event) => event.type === "tools_listed")).toBe(true)

			const continuationRequest = fixture.fake.requests.find((request) => findToolResult(request.body))
			const toolResult = findToolResult(continuationRequest?.body)
			expect(JSON.stringify(toolResult?.content)).toContain(`fixture echo: ${SENTINEL}`)
			trace.step("fixture invocation and model-facing tool result verified")
		},
	)
})

// Known product bug: asynchronous MCP bootstrap exposes a configured direct tool only after
// the first model request has already been built, so that request rejects the tool as unavailable.
test.fail("registers and calls a direct MCP tool on the first session", async ({ terminal }) => {
	const toolCallId = "call_mcp_direct_echo"
	await runKimchiSession(
		terminal,
		{
			artifactName: "mcp-stdio-direct-tool",
			mcp: { directTools: ["echo"] },
			responses: [
				{
					toolCalls: [
						{
							id: toolCallId,
							function: {
								name: "fixture_echo",
								arguments: JSON.stringify({ message: "direct-first-session" }),
							},
						},
					],
				},
				{ stream: ["The direct MCP tool worked without restarting Kimchi."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Call the direct MCP echo tool")
			await waitForText(terminal, "The direct MCP tool worked without restarting Kimchi.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})

			const initialChat = fixture.fake.requests.find((request) => request.url.startsWith("/openai/v1/chat/completions"))
			expect(JSON.stringify(initialChat?.body)).toContain('"name":"fixture_echo"')
			const event = await fixture.mcp?.waitForEvent(
				(candidate) => candidate.type === "tool_called" && candidate.name === "echo",
			)
			expect(event?.arguments).toEqual({ message: "direct-first-session" })

			const continuation = fixture.fake.requests.find((request) => findToolResult(request.body, toolCallId))
			expect(JSON.stringify(findToolResult(continuation?.body, toolCallId)?.content)).toContain(
				"fixture echo: direct-first-session",
			)
			trace.step("first-session direct tool registration and invocation verified")
		},
	)
})

test("delivers an MCP isError result to the next model turn", async ({ terminal }) => {
	const toolCallId = "call_mcp_fixture_failure"
	await runKimchiSession(
		terminal,
		{
			artifactName: "mcp-stdio-tool-error",
			mcp: {},
			responses: [
				{
					toolCalls: [
						{
							id: toolCallId,
							function: {
								name: "mcp",
								arguments: JSON.stringify({ tool: "fixture_fail", server: "fixture" }),
							},
						},
					],
				},
				{ stream: ["Kimchi handled the MCP tool error and the session continued."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Exercise the MCP fixture failure")
			await waitForText(terminal, "Kimchi handled the MCP tool error and the session continued.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})

			const continuation = fixture.fake.requests.find((request) => findToolResult(request.body, toolCallId))
			expect(JSON.stringify(findToolResult(continuation?.body, toolCallId)?.content)).toContain(
				"Error: fixture failure: requested by test",
			)
			expect(fixture.mcp?.readEvents().some((event) => event.type === "tool_called" && event.name === "fail")).toBe(
				true,
			)
			trace.step("MCP isError result reached the model and the turn settled")
		},
	)
})

test("reads an MCP resource through the gateway", async ({ terminal }) => {
	const toolCallId = "call_mcp_fixture_resource"
	await runKimchiSession(
		terminal,
		{
			artifactName: "mcp-stdio-resource",
			mcp: {},
			responses: [
				{
					toolCalls: [
						{
							id: toolCallId,
							function: {
								name: "mcp",
								arguments: JSON.stringify({ tool: "fixture_get_fixture_note", server: "fixture" }),
							},
						},
					],
				},
				{ stream: ["The MCP resource content reached the model."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Read the MCP fixture resource")
			await waitForText(terminal, "The MCP resource content reached the model.", { timeoutMs: STREAM_TIMEOUT_MS })

			const resourceEvent = await fixture.mcp?.waitForEvent(
				(event) => event.type === "resource_read" && event.uri === "fixture://note",
			)
			expect(resourceEvent?.uri).toBe("fixture://note")
			const continuation = fixture.fake.requests.find((request) => findToolResult(request.body, toolCallId))
			expect(JSON.stringify(findToolResult(continuation?.body, toolCallId)?.content)).toContain(
				"fixture resource: kimchi-mcp-resource",
			)
			trace.step("resource read crossed MCP and model boundaries")
		},
	)
})

test("preserves MCP text and safely represents image content for a text-only model", async ({ terminal }) => {
	const toolCallId = "call_mcp_fixture_mixed_content"
	await runKimchiSession(
		terminal,
		{
			artifactName: "mcp-stdio-mixed-content",
			mcp: {},
			responses: [
				{
					toolCalls: [
						{
							id: toolCallId,
							function: {
								name: "mcp",
								arguments: JSON.stringify({ tool: "fixture_mixed_content", server: "fixture" }),
							},
						},
					],
				},
				{ stream: ["The MCP text and image content both reached the model."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Request mixed text and image content from MCP")
			await waitForText(terminal, "The MCP text and image content both reached the model.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})

			const continuation = fixture.fake.requests.find((request) => findToolResult(request.body, toolCallId))
			const content = JSON.stringify(findToolResult(continuation?.body, toolCallId)?.content)
			expect(content).toContain("fixture mixed content: kimchi-mcp-mixed")
			expect(content).toContain("[image removed: image/png — stripped for non-vision model compatibility]")
			expect(
				fixture.mcp?.readEvents().some((event) => event.type === "tool_called" && event.name === "mixed_content"),
			).toBe(true)
			trace.step("mixed MCP content followed the text-only model compatibility contract")
		},
	)
})

test("injects the correctly named direct tool after MCP gateway search", async ({ terminal }) => {
	const searchCallId = "call_mcp_search"
	const directCallId = "call_mcp_injected_echo"
	await runKimchiSession(
		terminal,
		{
			artifactName: "mcp-search-direct-injection",
			mcp: {},
			responses: [
				{
					toolCalls: [
						{
							id: searchCallId,
							function: { name: "mcp", arguments: JSON.stringify({ search: "fixture echo" }) },
						},
					],
				},
				{
					toolCalls: [
						{
							id: directCallId,
							function: {
								name: "fixture_echo",
								arguments: JSON.stringify({ message: "search-injected-direct-tool" }),
							},
						},
					],
				},
				{ stream: ["The MCP search-injected tool used the correct original name."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Search MCP and then call the discovered echo tool")
			await waitForText(terminal, "The MCP search-injected tool used the correct original name.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await fixture.mcp?.waitForEvent(
				(event) => event.type === "tool_called" && event.arguments?.message === "search-injected-direct-tool",
			)

			const afterSearch = fixture.fake.requests.find((request) => findToolResult(request.body, searchCallId))
			expect(JSON.stringify(afterSearch?.body)).toContain('"name":"fixture_echo"')
			const afterDirectCall = fixture.fake.requests.find((request) => findToolResult(request.body, directCallId))
			expect(JSON.stringify(findToolResult(afterDirectCall?.body, directCallId)?.content)).toContain(
				"fixture echo: search-injected-direct-tool",
			)
			trace.step("search injection, direct name mapping, and invocation verified")
		},
	)
})

test("returns MCP server status for an empty gateway call", async ({ terminal }) => {
	const toolCallId = "call_mcp_empty_status"
	await runKimchiSession(
		terminal,
		{
			artifactName: "mcp-empty-call-status",
			mcp: {},
			responses: [
				{
					toolCalls: [{ id: toolCallId, function: { name: "mcp", arguments: "{}" } }],
				},
				{ stream: ["The empty MCP gateway call returned server status."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Show MCP status through an empty gateway call")
			await waitForText(terminal, "The empty MCP gateway call returned server status.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			const continuation = fixture.fake.requests.find((request) => findToolResult(request.body, toolCallId))
			expect(JSON.stringify(findToolResult(continuation?.body, toolCallId)?.content)).toMatch(/MCP: 1\/1 servers/)
			trace.step("empty gateway call preserved the MCP status contract")
		},
	)
})
