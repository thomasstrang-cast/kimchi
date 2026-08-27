/**
 * LLM Router extension.
 *
 * On the first user prompt of each session (including subagents), asks the
 * configured router which model best fits the query, then switches to it via
 * `pi.setModel()`. Failures are non-fatal.
 *
 * Opt-in: disabled by default. Enable via the `extensions.router` resource
 * toggle, then restart.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { KIMCHI_DEV_PROVIDER } from "../orchestration/model-registry/index.js"
import { routeQuery } from "./router-client.js"
import { getRouterConfig } from "./router-config.js"

export default function routerExtension(pi: ExtensionAPI): void {
	// Extension factories are reused across ACP and in-process child sessions.
	// Keep routing state inside this factory invocation so sessions cannot make
	// one another skip or repeat their first routing decision.
	let routed = false

	pi.on("session_start", (event) => {
		// A reload or switch back to an existing session does not create a new
		// routing opportunity. Startup, new sessions, and forks do.
		if (event.reason === "startup" || event.reason === "new" || event.reason === "fork") {
			routed = false
		}
	})

	pi.on("before_agent_start", async (event, ctx: ExtensionContext) => {
		// Route only once per session — the first user prompt.
		if (routed) return
		routed = true

		const config = await getRouterConfig(ctx.modelRegistry)
		if (!config) return

		const result = await routeQuery(event.prompt, config, ctx.signal ? { signal: ctx.signal } : undefined)
		if (!result) return

		const candidates =
			ctx.scopedModels.length > 0 ? ctx.scopedModels.map(({ model }) => model) : ctx.modelRegistry.getAvailable()
		const target = candidates.find((model) => model.provider === KIMCHI_DEV_PROVIDER && model.id === result.best_model)
		if (!target) {
			console.warn(
				`[router] Recommended Kimchi model "${result.best_model}" is not available in the current model scope. Skipping.`,
			)
			return
		}

		if (event.images?.length && !target.input.includes("image")) {
			console.warn(`[router] Recommended model "${result.best_model}" does not support this prompt's images. Skipping.`)
			return
		}

		if (ctx.model?.provider === target.provider && ctx.model.id === target.id) return

		await pi.setModel(target)
	})
}
