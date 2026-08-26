import { expect, test } from "@microsoft/tui-test"
import { STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import { runKimchiSession, TUI_TEST_CONFIG } from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

function findToolResult(body: unknown, toolCallId: string): Record<string, unknown> | undefined {
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

test("returns MCP argument validation failures to the model without ending the session", async ({ terminal }) => {
	const toolCallId = "call_mcp_invalid_arguments"
	await runKimchiSession(
		terminal,
		{
			artifactName: "mcp-invalid-arguments",
			mcp: {},
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
				{ stream: ["Kimchi surfaced the MCP validation error and continued."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Call MCP echo with invalid arguments")
			await waitForText(terminal, "Kimchi surfaced the MCP validation error and continued.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			const continuation = fixture.fake.requests.find((request) => findToolResult(request.body, toolCallId))
			expect(JSON.stringify(findToolResult(continuation?.body, toolCallId)?.content)).toContain(
				"fixture validation: message must be a string",
			)
			trace.step("invalid MCP arguments reached the server and returned as a bounded tool error")
		},
	)
})

test("settles the agent turn when a stdio MCP server exits during a call", async ({ terminal }) => {
	const toolCallId = "call_mcp_disconnect"
	await runKimchiSession(
		terminal,
		{
			artifactName: "mcp-disconnect-during-call",
			mcp: {},
			responses: [
				{
					toolCalls: [
						{
							id: toolCallId,
							function: {
								name: "mcp",
								arguments: JSON.stringify({ tool: "fixture_disconnect", server: "fixture" }),
							},
						},
					],
				},
				{ stream: ["Kimchi recovered after the MCP server disconnected."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Exercise an MCP server disconnect")
			await waitForText(terminal, "Kimchi recovered after the MCP server disconnected.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			const exited = await fixture.mcp?.waitForEvent((event) => event.type === "process_exited" && event.code === 17)
			expect(exited?.code).toBe(17)
			const continuation = fixture.fake.requests.find((request) => findToolResult(request.body, toolCallId))
			expect(JSON.stringify(findToolResult(continuation?.body, toolCallId)?.content)).toContain("Failed to call tool")
			trace.step("transport disconnect became a model-facing error and the turn settled")
		},
	)
})

test("starts Kimchi in a usable degraded state when an eager MCP server fails startup", async ({ terminal }) => {
	const toolCallId = "call_mcp_after_startup_failure"
	await runKimchiSession(
		terminal,
		{
			artifactName: "mcp-startup-failure",
			mcp: { scenario: "startup-failure" },
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
				{ stream: ["The main Kimchi session remained usable after MCP startup failed."] },
			],
		},
		async (fixture, trace) => {
			await fixture.mcp?.waitForEvent((event) => event.type === "process_exited" && event.code === 23)
			terminal.submit("Continue despite the broken MCP fixture")
			await waitForText(terminal, "The main Kimchi session remained usable after MCP startup failed.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			const continuation = fixture.fake.requests.find((request) => findToolResult(request.body, toolCallId))
			expect(findToolResult(continuation?.body, toolCallId)).toBeDefined()
			trace.step("startup failure stayed isolated from the main agent session")
		},
	)
})

test("completes a bounded slow MCP call without hanging the session", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "mcp-bounded-slow-call",
			mcp: {},
			responses: [
				{
					toolCalls: [
						{
							id: "call_mcp_slow",
							function: {
								name: "mcp",
								arguments: JSON.stringify({ tool: "fixture_slow", server: "fixture" }),
							},
						},
					],
				},
				{ stream: ["The bounded slow MCP call completed."] },
			],
		},
		async (fixture, trace) => {
			terminal.submit("Wait for the bounded MCP operation")
			await fixture.mcp?.waitForEvent((event) => event.type === "slow_call_started")
			await waitForText(terminal, "The bounded slow MCP call completed.", { timeoutMs: STREAM_TIMEOUT_MS })
			expect(fixture.mcp?.readEvents().some((event) => event.type === "slow_call_completed")).toBe(true)
			trace.step("bounded delayed MCP request completed and the turn settled")
		},
	)
})

// Known product bug: the MCP gateway tool receives Pi's AbortSignal but currently ignores
// it, so cancelling an agent turn does not send MCP notifications/cancelled to the server.
test.fail("propagates agent-turn cancellation to an in-flight MCP request", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "mcp-call-cancellation",
			mcp: {},
			responses: [
				{
					toolCalls: [
						{
							id: "call_mcp_cancel",
							function: {
								name: "mcp",
								arguments: JSON.stringify({ tool: "fixture_slow", server: "fixture" }),
							},
						},
					],
				},
			],
		},
		async (fixture, trace) => {
			terminal.submit("Start an MCP call that I will cancel")
			await fixture.mcp?.waitForEvent((event) => event.type === "slow_call_started")
			terminal.keyCtrlC()
			await fixture.mcp?.waitForEvent((event) => event.type === "slow_call_cancelled", {
				timeoutMs: 1_000,
				description: "MCP cancellation notification",
			})
			expect(fixture.mcp?.readEvents().some((event) => event.type === "slow_call_completed")).toBe(false)
			trace.step("agent cancellation reached the MCP server")
		},
	)
})
