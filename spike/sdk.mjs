import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (!process.env.SPIKE_ISOLATED) {
	const root = mkdtempSync(join(tmpdir(), "pi-history-sdk-"));
	try {
		const result = spawnSync(
			process.execPath,
			[fileURLToPath(import.meta.url)],
			{
				cwd: root,
				env: {
					PATH: process.env.PATH,
					HOME: root,
					PI_CODING_AGENT_DIR: join(root, "agent"),
					PI_OFFLINE: "1",
					SPIKE_ISOLATED: "1",
				},
				encoding: "utf8",
				timeout: 30000,
			},
		);
		process.stdout.write(result.stdout ?? "");
		process.stderr.write(result.stderr ?? "");
		assert.equal(result.status, 0, result.error?.message);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
} else {
	const {
		createAgentSession,
		DefaultResourceLoader,
		getAgentDir,
		SessionManager,
		SettingsManager,
	} = await import("@earendil-works/pi-coding-agent");
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	assert.equal(getAgentDir(), agentDir);
	delete process.env.PI_CODING_AGENT_DIR;
	assert.equal(getAgentDir(), join(process.env.HOME, ".pi", "agent"));
	process.env.PI_CODING_AGENT_DIR = "~/alternate-agent";
	assert.equal(getAgentDir(), join(process.env.HOME, "alternate-agent"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const memory = SessionManager.inMemory(process.cwd());
	assert.equal(memory.getSessionFile(), undefined);
	const persistent = SessionManager.create(
		process.cwd(),
		join(agentDir, "sessions"),
	);
	assert.equal(typeof persistent.getSessionFile(), "string");
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: false },
	});
	const observed = [];
	let commands = 0;
	const loader = new DefaultResourceLoader({
		cwd: process.cwd(),
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [
			(pi) => {
				pi.registerCommand("test-command", {
					handler: async () => {
						commands++;
					},
				});
				pi.on("input", (event) =>
					event.text === "transform"
						? { action: "transform", text: "changed\ttext" }
						: { action: "continue" },
				);
				pi.on("input", (event, ctx) => {
					observed.push({
						text: event.text,
						source: event.source,
						mode: ctx.mode,
						streamingBehavior: event.streamingBehavior,
						eligible:
							event.source === "interactive" &&
							ctx.mode === "tui" &&
							!!ctx.sessionManager.getSessionFile(),
					});
					return { action: "continue" };
				});
				pi.on("input", () => ({ action: "handled" }));
			},
		],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await createAgentSession({
		cwd: process.cwd(),
		agentDir,
		resourceLoader: loader,
		settingsManager,
		sessionManager: memory,
		noTools: "all",
	});
	try {
		for (const mode of ["print", "json", "rpc"]) {
			await session.bindExtensions({ mode });
			for (const source of ["interactive", "rpc", "extension"]) {
				await session.prompt("  Unicode 日本語\nline\t  ", { source });
			}
		}
		assert.equal(observed.length, 9);
		assert.ok(
			observed.every(
				(e) =>
					!e.eligible &&
					e.text === "  Unicode 日本語\nline\t  " &&
					e.streamingBehavior === undefined,
			),
		);
		await session.prompt("/test-command");
		assert.equal(commands, 1);
		assert.equal(observed.length, 9);
		await session.prompt("transform");
		assert.equal(observed.at(-1).text, "changed\ttext");
		assert.equal(session.messages.length, 0);
		console.log(
			`SDK PASS: Node ${process.version}; paths/default/env/tilde, ephemeral, 9 non-TUI mode/source combinations, command bypass, transform ordering; no model turns.`,
		);
	} finally {
		session.dispose();
	}
	const { verifyStreaming } = await import("./streaming.mjs");
	await verifyStreaming();
}
