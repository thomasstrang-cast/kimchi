import { expect, test } from "@microsoft/tui-test"
import { STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import {
	createKimchiFixture,
	launchKimchi,
	PROMPT_READY,
	stopKimchi,
	TUI_TEST_CONFIG,
} from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("uses cached MCP metadata to call a direct tool after restart", async ({ terminal }) => {
	const fixture = await createKimchiFixture({
		mcp: { directTools: ["echo"] },
		responses: [
			{
				toolCalls: [
					{
						id: "call_mcp_warm_cache",
						function: {
							name: "mcp",
							arguments: JSON.stringify({
								tool: "fixture_echo",
								server: "fixture",
								args: JSON.stringify({ message: "warm-cache" }),
							}),
						},
					},
				],
			},
			{ stream: ["The first MCP session populated the cache."] },
			{
				toolCalls: [
					{
						id: "call_mcp_after_restart",
						function: {
							name: "fixture_echo",
							arguments: JSON.stringify({ message: "after-restart" }),
						},
					},
				],
			},
			{ stream: ["The cached direct MCP tool worked after restart."] },
		],
	})

	try {
		launchKimchi(terminal, fixture)
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
		terminal.submit("Warm the MCP metadata cache through the gateway")
		await waitForText(terminal, "The first MCP session populated the cache.", { timeoutMs: STREAM_TIMEOUT_MS })
		await fixture.mcp?.waitForEvent(
			(event) => event.type === "tool_called" && event.arguments?.message === "warm-cache",
			{ description: "first-session gateway tool call" },
		)

		terminal.submit("/quit")
		await new Promise((resolve) => setTimeout(resolve, 500))

		launchKimchi(terminal, fixture)
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
		terminal.submit("Call the cached direct MCP tool after restart")
		await waitForText(terminal, "The cached direct MCP tool worked after restart.", {
			timeoutMs: STREAM_TIMEOUT_MS,
		})
		await fixture.mcp?.waitForEvent(
			(event) => event.type === "tool_called" && event.arguments?.message === "after-restart",
			{ description: "second-session direct tool call" },
		)

		const events = fixture.mcp?.readEvents() ?? []
		const serverPids = new Set(events.filter((event) => event.type === "process_started").map((event) => event.pid))
		expect(serverPids.size).toBe(2)
		const secondSessionRequest = fixture.fake.requests.find((request) =>
			(JSON.stringify(request.body) ?? "").includes("Call the cached direct MCP tool after restart"),
		)
		expect(JSON.stringify(secondSessionRequest?.body)).toContain('"name":"fixture_echo"')
	} finally {
		try {
			await stopKimchi(terminal)
		} catch {
			// best-effort process cleanup
		}
		try {
			await fixture.stop()
		} catch {
			// best-effort fixture cleanup
		}
	}
})
