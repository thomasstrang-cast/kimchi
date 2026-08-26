import { type ChildProcess, spawn } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"

const REPO_ROOT = process.env.KIMCHI_REPO_ROOT
	? resolve(process.env.KIMCHI_REPO_ROOT)
	: fileURLToPath(new URL("../../../../", import.meta.url))
const FIXTURE_SERVER_PATH = resolve(REPO_ROOT, "tests/e2e/mcp/fixture-server.mjs")

export interface McpFixtureEvent {
	type: string
	at: string
	pid: number
	scenario: string
	name?: string
	uri?: string
	arguments?: Record<string, unknown>
	code?: number
	url?: string
	method?: string
	path?: string
	sessionId?: string
	authorized?: boolean
	testHeader?: string
	message?: string
	redirectUri?: string
	redirectUris?: string[]
	grantType?: string
	pkceVerified?: boolean
}

export interface McpStdioFixtureOptions {
	serverName?: string
	scenario?: string
	directTools?: boolean | string[]
	lifecycle?: "keep-alive" | "lazy" | "eager"
}

export interface McpStdioFixture {
	serverName: string
	configPath: string
	eventPath: string
	readEvents(): McpFixtureEvent[]
	waitForEvent(
		predicate: (event: McpFixtureEvent) => boolean,
		options?: { timeoutMs?: number; description?: string },
	): Promise<McpFixtureEvent>
}

export interface McpFixtureOptions extends McpStdioFixtureOptions {
	transport?: "stdio" | "http" | "oauth" | "sse"
	/** Configure an already-running HTTP server instead of spawning the repository fixture. */
	externalUrl?: string
	headers?: Record<string, string>
	/** Require this static token at the HTTP fixture and configure Kimchi to send it. */
	bearerToken?: string
}

export interface McpFixture extends McpStdioFixture {
	transport: "stdio" | "http" | "oauth" | "sse"
	url?: string
	env: Record<string, string>
	stop(): Promise<void>
}

function createEventReader(eventPath: string): Pick<McpStdioFixture, "readEvents" | "waitForEvent"> {
	const readEvents = (): McpFixtureEvent[] => {
		if (!existsSync(eventPath)) return []
		return readFileSync(eventPath, "utf-8")
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as McpFixtureEvent)
	}

	return {
		readEvents,
		async waitForEvent(predicate, waitOptions = {}) {
			const timeoutMs = waitOptions.timeoutMs ?? 10_000
			const startedAt = Date.now()
			while (Date.now() - startedAt < timeoutMs) {
				const event = readEvents().find(predicate)
				if (event) return event
				await delay(25)
			}
			const description = waitOptions.description ?? "matching MCP fixture event"
			throw new Error(
				`Timed out after ${timeoutMs}ms waiting for ${description}. Events: ${JSON.stringify(readEvents())}`,
			)
		},
	}
}

export function seedMcpStdioFixture(agentDir: string, options: McpStdioFixtureOptions = {}): McpFixture {
	const serverName = options.serverName ?? "fixture"
	const scenario = options.scenario ?? "basic"
	const eventPath = resolve(agentDir, `mcp-fixture-${serverName}.jsonl`)
	const configPath = resolve(agentDir, "mcp.json")

	writeFileSync(eventPath, "", "utf-8")
	writeFileSync(
		configPath,
		JSON.stringify(
			{
				mcpServers: {
					[serverName]: {
						command: process.execPath,
						args: [FIXTURE_SERVER_PATH],
						env: {
							KIMCHI_MCP_FIXTURE_EVENTS: eventPath,
							KIMCHI_MCP_FIXTURE_SCENARIO: scenario,
						},
						lifecycle: options.lifecycle ?? "eager",
						idleTimeout: 0,
						...(options.directTools === undefined ? {} : { directTools: options.directTools }),
					},
				},
				settings: { toolPrefix: "server" },
			},
			null,
			"\t",
		),
		"utf-8",
	)

	const eventReader = createEventReader(eventPath)

	return {
		serverName,
		configPath,
		eventPath,
		transport: "stdio",
		env: {},
		...eventReader,
		async stop() {},
	}
}

async function stopChild(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return
	const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()))
	child.kill("SIGTERM")
	const graceful = await Promise.race([exited.then(() => true), delay(3_000).then(() => false)])
	if (graceful) return
	child.kill("SIGKILL")
	await exited
}

export async function createMcpFixture(agentDir: string, options: McpFixtureOptions = {}): Promise<McpFixture> {
	if (options.externalUrl) return seedExternalHttpFixture(agentDir, options)
	if ((options.transport ?? "stdio") === "stdio") return seedMcpStdioFixture(agentDir, options)

	const serverName = options.serverName ?? "fixture"
	const scenario = options.scenario ?? "basic"
	const oauth = options.transport === "oauth"
	const transport = options.transport === "sse" ? "sse" : "http"
	const eventPath = resolve(agentDir, `mcp-fixture-${serverName}.jsonl`)
	const configPath = resolve(agentDir, "mcp.json")
	writeFileSync(eventPath, "", "utf-8")

	const child = spawn(process.execPath, [FIXTURE_SERVER_PATH], {
		env: {
			...process.env,
			KIMCHI_MCP_FIXTURE_EVENTS: eventPath,
			KIMCHI_MCP_FIXTURE_SCENARIO: scenario,
			KIMCHI_MCP_FIXTURE_TRANSPORT: transport,
			...(oauth ? { KIMCHI_MCP_FIXTURE_OAUTH: "1" } : {}),
			...(oauth
				? { KIMCHI_MCP_FIXTURE_BEARER_TOKEN: "kimchi-e2e-oauth-access-token" }
				: options.bearerToken
					? { KIMCHI_MCP_FIXTURE_BEARER_TOKEN: options.bearerToken }
					: {}),
		},
		stdio: ["ignore", "ignore", "inherit"],
	})
	const eventReader = createEventReader(eventPath)
	try {
		const listening = await eventReader.waitForEvent((event) => event.type === "http_listening", {
			description: "HTTP MCP fixture to listen",
		})
		if (!listening.url) throw new Error("HTTP MCP fixture did not record its URL")

		writeFileSync(
			configPath,
			JSON.stringify(
				{
					mcpServers: {
						[serverName]: {
							url: listening.url,
							headers: options.headers,
							auth: oauth ? "oauth" : options.bearerToken ? "bearer" : false,
							...(oauth ? { oauth: { scope: "mcp:tools" } } : {}),
							...(!oauth && options.bearerToken ? { bearerToken: options.bearerToken } : {}),
							lifecycle: options.lifecycle ?? "eager",
							idleTimeout: 0,
							...(options.directTools === undefined ? {} : { directTools: options.directTools }),
						},
					},
					settings: { toolPrefix: "server" },
				},
				null,
				"\t",
			),
			"utf-8",
		)
		const browserEnv = oauth ? createOAuthBrowserDriver(agentDir, eventPath) : {}

		return {
			serverName,
			configPath,
			eventPath,
			transport: oauth ? "oauth" : transport,
			url: listening.url,
			env: browserEnv,
			...eventReader,
			async stop() {
				await stopChild(child)
			},
		}
	} catch (error) {
		await stopChild(child)
		throw error
	}
}

function seedExternalHttpFixture(agentDir: string, options: McpFixtureOptions): McpFixture {
	const serverName = options.serverName ?? "fixture"
	const eventPath = resolve(agentDir, `mcp-fixture-${serverName}.jsonl`)
	const configPath = resolve(agentDir, "mcp.json")
	writeFileSync(eventPath, "", "utf-8")
	writeFileSync(
		configPath,
		JSON.stringify(
			{
				mcpServers: {
					[serverName]: {
						url: options.externalUrl,
						headers: options.headers,
						auth: false,
						lifecycle: options.lifecycle ?? "eager",
						idleTimeout: 0,
						...(options.directTools === undefined ? {} : { directTools: options.directTools }),
					},
				},
				settings: { toolPrefix: "server" },
			},
			null,
			"\t",
		),
		"utf-8",
	)
	return {
		serverName,
		configPath,
		eventPath,
		transport: "http",
		url: options.externalUrl,
		env: {},
		...createEventReader(eventPath),
		async stop() {},
	}
}

function createOAuthBrowserDriver(agentDir: string, eventPath: string): Record<string, string> {
	const browserBinDir = resolve(agentDir, "mcp-oauth-browser")
	const browserPath = resolve(browserBinDir, "open")
	mkdirSync(browserBinDir, { recursive: true })
	writeFileSync(
		browserPath,
		`#!/usr/bin/env node
import { appendFileSync } from "node:fs"
const eventPath = ${JSON.stringify(eventPath)}
const target = process.argv.find((argument) => argument.startsWith("http://") || argument.startsWith("https://"))
if (!target) throw new Error("OAuth browser driver did not receive an HTTP URL")
appendFileSync(eventPath, JSON.stringify({ type: "oauth_browser_opened", at: new Date().toISOString(), pid: process.pid, scenario: "oauth" }) + "\\n")
const response = await fetch(target, { redirect: "follow" })
appendFileSync(eventPath, JSON.stringify({ type: "oauth_browser_completed", at: new Date().toISOString(), pid: process.pid, scenario: "oauth", status: response.status }) + "\\n")
if (!response.ok) throw new Error(\`OAuth browser driver received HTTP \${response.status}\`)
`,
		"utf-8",
	)
	chmodSync(browserPath, 0o755)
	return {
		BROWSER: browserPath,
		PATH: `${browserBinDir}:${process.env.PATH ?? ""}`,
	}
}
