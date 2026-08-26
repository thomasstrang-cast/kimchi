import { expect, test } from "@microsoft/tui-test"
import { STARTUP_TIMEOUT_MS, STREAM_TIMEOUT_MS, waitForText } from "./support/assertions.js"
import {
	createKimchiFixture,
	launchKimchi,
	PROMPT_READY,
	runKimchiSession,
	stopKimchi,
	TUI_TEST_CONFIG,
} from "./support/kimchi-fixture.js"

test.use(TUI_TEST_CONFIG)

test("logs into an HTTP MCP server with OAuth authorization code and PKCE", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "mcp-oauth-login",
			mcp: { transport: "oauth" },
			responses: [
				{
					toolCalls: [
						{
							id: "call_mcp_oauth_echo",
							function: {
								name: "mcp",
								arguments: JSON.stringify({
									tool: "fixture_echo",
									server: "fixture",
									args: JSON.stringify({ message: "oauth-login" }),
								}),
							},
						},
					],
				},
				{ stream: ["The OAuth-authenticated MCP tool returned successfully."] },
			],
		},
		async (fixture, trace) => {
			await fixture.mcp?.waitForEvent((event) => event.type === "http_unauthorized", {
				description: "initial OAuth challenge",
			})
			trace.step("protected MCP endpoint challenged the unauthenticated client")

			terminal.submit("/mcp-auth fixture")
			await waitForText(terminal, 'OAuth authentication successful for "fixture"!', {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await fixture.mcp?.waitForEvent((event) => event.type === "oauth_token_issued" && event.pkceVerified === true, {
				description: "OAuth token exchange with verified PKCE",
			})
			trace.step("browser redirect, callback, and authorization-code exchange completed")

			terminal.submit("/mcp reconnect fixture")
			await waitForText(terminal, "MCP: Reconnected to fixture", { timeoutMs: STREAM_TIMEOUT_MS })
			terminal.submit("Call the OAuth-protected MCP echo tool")
			await waitForText(terminal, "The OAuth-authenticated MCP tool returned successfully.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await fixture.mcp?.waitForEvent(
				(event) => event.type === "tool_called" && event.arguments?.message === "oauth-login",
			)

			const events = fixture.mcp?.readEvents() ?? []
			expect(events.some((event) => event.type === "oauth_resource_metadata_requested")).toBe(true)
			expect(events.some((event) => event.type === "oauth_server_metadata_requested")).toBe(true)
			expect(events.some((event) => event.type === "oauth_client_registered")).toBe(true)
			expect(events.some((event) => event.type === "oauth_browser_opened")).toBe(true)
			expect(events.some((event) => event.type === "oauth_browser_completed")).toBe(true)
			expect(events.some((event) => event.type === "http_request" && event.authorized === true)).toBe(true)
			trace.step("authenticated MCP call and every OAuth protocol boundary verified")
		},
	)
})

test("returns an OAuth denial to the TUI and keeps the Kimchi session usable", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "mcp-oauth-denial",
			mcp: { transport: "oauth", scenario: "oauth-deny" },
			responses: [{ stream: ["The session stayed usable after OAuth was denied."] }],
		},
		async (fixture, trace) => {
			terminal.submit("/mcp-auth fixture")
			await waitForText(terminal, 'Failed to authenticate "fixture": fixture authorization denied', {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			await fixture.mcp?.waitForEvent((event) => event.type === "oauth_authorization_denied")
			const eventsAfterDenial = fixture.mcp?.readEvents() ?? []
			expect(eventsAfterDenial.some((event) => event.type === "oauth_token_issued")).toBe(false)
			expect(eventsAfterDenial.some((event) => event.type === "oauth_browser_completed")).toBe(true)
			trace.step("authorization denial returned through the callback without storing a token")

			terminal.submit("Continue with a normal response after the denied login")
			await waitForText(terminal, "The session stayed usable after OAuth was denied.", {
				timeoutMs: STREAM_TIMEOUT_MS,
			})
			trace.step("main session remained usable after OAuth denial")
		},
	)
})

test("reports a failed OAuth token exchange without persisting partial authentication", async ({ terminal }) => {
	await runKimchiSession(
		terminal,
		{
			artifactName: "mcp-oauth-token-failure",
			mcp: { transport: "oauth", scenario: "oauth-token-failure" },
			responses: [],
		},
		async (fixture, trace) => {
			terminal.submit("/mcp-auth fixture")
			await waitForText(terminal, 'Failed to authenticate "fixture"', { timeoutMs: STREAM_TIMEOUT_MS })
			await fixture.mcp?.waitForEvent((event) => event.type === "oauth_token_rejected")
			expect(fixture.mcp?.readEvents().some((event) => event.type === "oauth_token_issued")).toBe(false)
			trace.step("token endpoint failure settled and no access token was issued")
		},
	)
})

test("refreshes an expired MCP OAuth token after a real Kimchi process restart", async ({ terminal }) => {
	const fixture = await createKimchiFixture({
		mcp: { transport: "oauth", scenario: "oauth-expiring" },
		responses: [
			{
				toolCalls: [
					{
						id: "call_mcp_oauth_before_restart",
						function: {
							name: "mcp",
							arguments: JSON.stringify({
								tool: "fixture_echo",
								server: "fixture",
								args: JSON.stringify({ message: "before-oauth-restart" }),
							}),
						},
					},
				],
			},
			{ stream: ["The first OAuth MCP call succeeded."] },
			{
				toolCalls: [
					{
						id: "call_mcp_oauth_after_restart",
						function: {
							name: "mcp",
							arguments: JSON.stringify({
								tool: "fixture_echo",
								server: "fixture",
								args: JSON.stringify({ message: "after-oauth-refresh" }),
							}),
						},
					},
				],
			},
			{ stream: ["The refreshed OAuth MCP call succeeded after restart."] },
		],
	})

	try {
		launchKimchi(terminal, fixture, [], fixture.seedEnv)
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
		terminal.submit("/mcp-auth fixture")
		await waitForText(terminal, 'OAuth authentication successful for "fixture"!', {
			timeoutMs: STREAM_TIMEOUT_MS,
		})
		terminal.submit("/mcp reconnect fixture")
		await waitForText(terminal, "MCP: Reconnected to fixture", { timeoutMs: STREAM_TIMEOUT_MS })
		terminal.submit("Call MCP before restarting")
		await waitForText(terminal, "The first OAuth MCP call succeeded.", { timeoutMs: STREAM_TIMEOUT_MS })

		terminal.submit("/quit")
		await new Promise((resolve) => setTimeout(resolve, 1_500))

		launchKimchi(terminal, fixture, [], fixture.seedEnv)
		await waitForText(terminal, PROMPT_READY, { timeoutMs: STARTUP_TIMEOUT_MS, full: false })
		terminal.submit("Call MCP using the persisted token after restarting")
		await waitForText(terminal, "The refreshed OAuth MCP call succeeded after restart.", {
			timeoutMs: STREAM_TIMEOUT_MS,
		})

		const refresh = await fixture.mcp?.waitForEvent(
			(event) => event.type === "oauth_token_issued" && event.grantType === "refresh_token",
			{ description: "OAuth refresh-token exchange after restart" },
		)
		expect(refresh?.grantType).toBe("refresh_token")
		await fixture.mcp?.waitForEvent(
			(event) => event.type === "tool_called" && event.arguments?.message === "after-oauth-refresh",
		)
	} finally {
		await stopKimchi(terminal).catch(() => {})
		await fixture.stop().catch(() => {})
	}
})
