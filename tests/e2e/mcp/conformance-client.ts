#!/usr/bin/env tsx

import { startAcpFixture } from "../acp/support/acp-fixture.js"
import { newSession, prompt } from "../acp/support/scenarios.js"

const scenario = process.env.MCP_CONFORMANCE_SCENARIO
const serverUrl = process.argv.at(-1)
const supportedScenarios = new Set(["initialize", "tools_call", "tools-call"])
function log(message: string): void {
	process.stderr.write(`[mcp-conformance] ${message}\n`)
}

if (!scenario || !supportedScenarios.has(scenario)) {
	throw new Error(`Unsupported Kimchi MCP conformance scenario: ${scenario ?? "(missing)"}`)
}
if (!serverUrl?.startsWith("http://") && !serverUrl?.startsWith("https://")) {
	throw new Error(`MCP conformance runner did not provide a server URL: ${serverUrl ?? "(missing)"}`)
}

const fixture = await startAcpFixture({
	artifactName: `mcp-conformance-${scenario.replaceAll("/", "-")}`,
	mcp: { transport: "http", externalUrl: serverUrl, serverName: "conformance" },
	responses: [
		{
			toolCalls: [
				{
					id: "call_conformance_connect",
					function: { name: "mcp", arguments: JSON.stringify({ connect: "conformance" }) },
				},
			],
		},
		{
			toolCalls: [
				{
					id: "call_conformance_tool",
					function: {
						name: "mcp",
						arguments: JSON.stringify({
							tool: "__MCP_FIRST_TOOL__",
							server: "conformance",
							args: JSON.stringify({ a: 2, b: 3 }),
						}),
					},
				},
			],
		},
		{ stream: ["Kimchi MCP conformance scenario completed."] },
	],
})
log(`Kimchi ACP fixture started for ${scenario}`)

try {
	const sessionId = await newSession(fixture, fixture.workDir)
	log(`ACP session ready: ${sessionId}`)
	const result = await prompt(fixture, sessionId, `Run MCP conformance scenario ${scenario}`)
	log(`ACP prompt stopped with ${result.stopReason}`)
	if (result.stopReason !== "end_turn") {
		throw new Error(`Kimchi ACP conformance turn stopped with ${result.stopReason}`)
	}
	if (!result.chunks.includes("Kimchi MCP conformance scenario completed.")) {
		throw new Error(`Kimchi ACP conformance turn did not complete: ${result.chunks}`)
	}
} finally {
	await fixture.stop()
	log("fixture stopped")
}

// The ACP SDK connection retains reader state after the child process closes.
// All owned resources are stopped above, so terminate the short-lived conformance driver explicitly.
process.exit(0)
