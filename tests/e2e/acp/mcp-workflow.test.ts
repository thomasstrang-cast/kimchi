import { readFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type AcpFixture, STARTUP_TIMEOUT_MS, startAcpFixture } from "./support/acp-fixture.js"
import { newSession, prompt } from "./support/scenarios.js"

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

describe("ACP integration — MCP", () => {
	let fixture: AcpFixture
	const toolCallId = "call_acp_mcp_echo"

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-mcp-workflow",
			mcp: {},
			modelInput: ["text", "image"],
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
									args: JSON.stringify({ message: "acp-mcp" }),
								}),
							},
						},
					],
				},
				{ stream: ["ACP received the MCP fixture result."] },
				{
					toolCalls: [
						{
							id: "call_acp_mcp_mixed_content",
							function: {
								name: "mcp",
								arguments: JSON.stringify({ tool: "fixture_mixed_content", server: "fixture" }),
							},
						},
					],
				},
				{ stream: ["ACP preserved the MCP image result."] },
			],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("probes and calls a configured MCP server through the real ACP process", async () => {
		const config = JSON.parse(readFileSync(fixture.mcp?.configPath ?? "", "utf-8")) as {
			mcpServers: Record<string, Record<string, unknown>>
		}
		const probe = await fixture.conn.extMethod("_kimchi.dev/probe_mcp_server", {
			server: config.mcpServers.fixture,
			serverName: "acp-fixture-probe",
		})
		expect(probe.needsAuth).toBe(false)
		expect(probe.error).toBeNull()
		expect(probe.tools).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "echo" }), expect.objectContaining({ name: "fail" })]),
		)
		const cache = JSON.parse(
			readFileSync(join(fixture.homeDir, ".config", "kimchi", "harness", "mcp-cache.json"), "utf-8"),
		) as { servers: Record<string, { tools: Array<{ name: string }> }> }
		expect(cache.servers["acp-fixture-probe"]?.tools).toEqual(
			expect.arrayContaining([expect.objectContaining({ name: "echo" })]),
		)

		const sessionId = await newSession(fixture, fixture.workDir)
		const result = await prompt(fixture, sessionId, "Call the configured MCP fixture echo tool")
		expect(result.stopReason).toBe("end_turn")
		expect(result.chunks).toContain("ACP received the MCP fixture result.")

		const toolUpdates = fixture.client.sessionUpdates.filter(
			(update) =>
				update.sessionId === sessionId &&
				(update.update.sessionUpdate === "tool_call" || update.update.sessionUpdate === "tool_call_update"),
		)
		expect(toolUpdates.length).toBeGreaterThanOrEqual(2)
		await fixture.mcp?.waitForEvent((event) => event.type === "tool_called" && event.arguments?.message === "acp-mcp")

		const continuation = fixture.fake.requests.find((request) => findToolResult(request.body, toolCallId))
		expect(JSON.stringify(findToolResult(continuation?.body, toolCallId)?.content)).toContain("fixture echo: acp-mcp")

		const imageResult = await prompt(fixture, sessionId, "Request mixed image content from the configured MCP fixture")
		expect(imageResult.stopReason).toBe("end_turn")
		expect(imageResult.chunks).toContain("ACP preserved the MCP image result.")
		const imageToolUpdate = fixture.client.sessionUpdates.find(
			(update) =>
				update.sessionId === sessionId &&
				update.update.sessionUpdate === "tool_call_update" &&
				JSON.stringify(update.update).includes("iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB"),
		)
		expect(imageToolUpdate).toBeDefined()
	})
})

describe("ACP integration — OAuth MCP", () => {
	let fixture: AcpFixture

	beforeEach(async () => {
		fixture = await startAcpFixture({
			artifactName: "acp-mcp-oauth-workflow",
			mcp: { transport: "oauth" },
			responses: [
				{
					toolCalls: [
						{
							id: "call_acp_oauth_mcp_echo",
							function: {
								name: "mcp",
								arguments: JSON.stringify({
									tool: "fixture_echo",
									server: "fixture",
									args: JSON.stringify({ message: "acp-oauth-mcp" }),
								}),
							},
						},
					],
				},
				{ stream: ["ACP called the OAuth-protected MCP tool."] },
			],
		})
	}, STARTUP_TIMEOUT_MS)

	afterEach(async () => {
		await fixture.stop()
	})

	it("distinguishes auth-required probing, authenticates, and then uses the protected tool", async () => {
		const config = JSON.parse(readFileSync(fixture.mcp?.configPath ?? "", "utf-8")) as {
			mcpServers: Record<string, Record<string, unknown>>
		}
		const server = config.mcpServers.fixture
		const unauthenticatedProbe = await fixture.conn.extMethod("_kimchi.dev/probe_mcp_server", {
			server,
			serverName: "fixture",
			skipAuth: true,
		})
		expect(unauthenticatedProbe.needsAuth).toBe(true)

		const authenticatedProbe = await fixture.conn.extMethod("_kimchi.dev/probe_mcp_server", {
			server,
			serverName: "fixture",
		})
		expect(authenticatedProbe.needsAuth).toBe(false)
		expect(authenticatedProbe.error).toBeNull()
		expect(authenticatedProbe.tools).toEqual(expect.arrayContaining([expect.objectContaining({ name: "echo" })]))
		await fixture.mcp?.waitForEvent(
			(event) => event.type === "oauth_token_issued" && event.grantType === "authorization_code",
		)

		const sessionId = await newSession(fixture, fixture.workDir)
		const result = await prompt(fixture, sessionId, "Call the OAuth-protected configured MCP tool")
		expect(result.stopReason).toBe("end_turn")
		expect(result.chunks).toContain("ACP called the OAuth-protected MCP tool.")
		await fixture.mcp?.waitForEvent(
			(event) => event.type === "tool_called" && event.arguments?.message === "acp-oauth-mcp",
		)
	})
})
