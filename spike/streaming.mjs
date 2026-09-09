// Public SDK + scripted in-process provider. No HTTP client, credentials, or real inference.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

export async function verifyStreaming() {
	assert.equal(process.env.SPIKE_ISOLATED, "1", "Run through spike/sdk.mjs");
	const {
		createAgentSession,
		DefaultResourceLoader,
		SessionManager,
		SettingsManager,
	} = await import("@earendil-works/pi-coding-agent");
	const model = {
		id: "synthetic",
		name: "Synthetic spike model",
		provider: "history-spike",
		api: "history-spike-api",
		baseUrl: "https://invalid.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 1024,
	};
	const plans = [];
	const calls = [];
	const observed = [];
	const events = [];
	const errors = [];
	const providerErrors = [];
	const compactions = [];
	let commands = 0;
	let nextDelta;
	function streamSimple(selected, context, options) {
		const stream = createAssistantMessageEventStream();
		const plan = plans.shift();
		calls.push(structuredClone(context.messages));
		const output = {
			role: "assistant",
			content: [],
			api: selected.api,
			provider: selected.provider,
			model: selected.id,
			timestamp: Date.now(),
			stopReason: "pending",
			usage: {
				input: 10,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 11,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
		queueMicrotask(async () => {
			try {
				assert.ok(plan, "Unexpected provider call");
				assert.equal(selected.provider, model.provider);
				assert.equal(context.tools?.length ?? 0, 0);
				stream.push({ type: "start", partial: output });
				output.content.push({ type: "text", text: "" });
				stream.push({ type: "text_start", contentIndex: 0, partial: output });
				output.content[0].text = "synthetic reply";
				stream.push({
					type: "text_delta",
					contentIndex: 0,
					delta: "synthetic reply",
					partial: output,
				});
				if (plan.release) await plan.release.promise;
				options?.signal?.throwIfAborted();
				if (plan.error) throw new Error(plan.error);
				stream.push({
					type: "text_end",
					contentIndex: 0,
					content: output.content[0].text,
					partial: output,
				});
				output.stopReason = "stop";
				stream.push({ type: "done", reason: "stop", message: output });
			} catch (error) {
				providerErrors.push(error.message);
				output.stopReason = options?.signal?.aborted ? "aborted" : "error";
				output.errorMessage = error.message;
				stream.push({
					type: "error",
					reason: output.stopReason,
					error: output,
				});
			} finally {
				stream.end();
			}
		});
		return stream;
	}
	const agentDir = process.env.PI_CODING_AGENT_DIR;
	const settingsManager = SettingsManager.inMemory({
		compaction: { enabled: true, reserveTokens: 1024, keepRecentTokens: 100 },
		retry: { enabled: true, maxRetries: 1, baseDelayMs: 1 },
	});
	const skillPath = join(process.cwd(), "SKILL.md");
	const templatePath = join(process.cwd(), "stream-template.md");
	writeFileSync(
		skillPath,
		"---\nname: stream-skill\ndescription: Synthetic spike skill\n---\nExpanded synthetic skill\n",
	);
	writeFileSync(templatePath, "Expanded synthetic template $1\n");
	const loader = new DefaultResourceLoader({
		cwd: process.cwd(),
		agentDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		additionalSkillPaths: [skillPath],
		additionalPromptTemplatePaths: [templatePath],
		extensionFactories: [
			(pi) => {
				pi.on("input", (event) =>
					event.text === "transform-stream"
						? { action: "transform", text: "changed\tstream" }
						: { action: "continue" },
				);
			},
			(pi) => {
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
				pi.registerCommand("stream-command", {
					handler: async () => {
						commands++;
					},
				});
				pi.on("session_before_compact", (event) => {
					compactions.push({
						reason: event.reason,
						willRetry: event.willRetry,
					});
					return {
						compaction: {
							summary: "Synthetic spike summary",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
						},
					};
				});
			},
			(pi) =>
				pi.registerProvider(model.provider, {
					baseUrl: model.baseUrl,
					api: model.api,
					apiKey: "synthetic-not-a-credential",
					models: [model],
					streamSimple,
				}),
		],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	assert.equal(loader.getSkills().skills.length, 1);
	assert.equal(loader.getPrompts().prompts.length, 1);
	const { session } = await createAgentSession({
		cwd: process.cwd(),
		agentDir,
		resourceLoader: loader,
		settingsManager,
		model,
		sessionManager: SessionManager.create(
			process.cwd(),
			join(agentDir, "stream-sessions"),
		),
		noTools: "all",
	});
	const unsubscribe = session.subscribe((event) => {
		events.push(event);
		if (
			event.type === "message_update" &&
			event.assistantMessageEvent.type === "text_delta"
		) {
			nextDelta?.();
			nextDelta = undefined;
		}
	});
	const userTexts = (messages) =>
		messages
			.filter((message) => message.role === "user")
			.map((message) =>
				typeof message.content === "string"
					? message.content
					: message.content
							.filter((block) => block.type === "text")
							.map((block) => block.text)
							.join("\n"),
			);
	const hold = async (text, work) => {
		const release = Promise.withResolvers();
		const delta = Promise.withResolvers();
		nextDelta = delta.resolve;
		plans.push({ release });
		const running = session.prompt(text);
		try {
			await delta.promise;
			assert.equal(session.isStreaming, true);
			await work();
		} finally {
			release.resolve();
			await running;
		}
		await session.waitForIdle();
	};
	try {
		await session.bindExtensions({
			mode: "tui",
			onError: (error) => errors.push(error),
		});
		await hold("idle seed", async () => {
			await session.prompt("transform-stream", { streamingBehavior: "steer" });
			await session.prompt("/stream-template queued", {
				streamingBehavior: "followUp",
			});
			await session.prompt("/stream-command");
			assert.equal(commands, 1);
			assert.deepEqual(session.getSteeringMessages(), ["changed\tstream"]);
			assert.deepEqual(session.getFollowUpMessages(), [
				"Expanded synthetic template queued\n",
			]);
			assert.deepEqual(
				observed.map((e) => [e.text, e.streamingBehavior]),
				[
					["idle seed", undefined],
					["changed\tstream", "steer"],
					["/stream-template queued", "followUp"],
				],
			);
			assert.ok(
				observed.every(
					(e) => e.eligible && e.mode === "tui" && e.source === "interactive",
				),
			);
			plans.push({}, {});
		});
		assert.equal(calls.length, 3);
		assert.deepEqual(userTexts(calls[0]), ["idle seed"]);
		assert.deepEqual(userTexts(calls[1]), ["idle seed", "changed\tstream"]);
		assert.deepEqual(userTexts(calls[2]), [
			"idle seed",
			"changed\tstream",
			"Expanded synthetic template queued\n",
		]);
		assert.equal(observed.length, 3, "Queue delivery must not recapture");
		assert.deepEqual(session.getSteeringMessages(), []);
		assert.deepEqual(session.getFollowUpMessages(), []);

		plans.push({});
		await session.prompt("/skill:stream-skill argument");
		assert.equal(observed.at(-1).text, "/skill:stream-skill argument");
		assert.match(
			userTexts(calls.at(-1)).at(-1),
			/Expanded synthetic skill[\s\S]*argument/,
		);

		await hold("dequeue seed", async () => {
			await session.prompt("resubmit me", { streamingBehavior: "steer" });
			await session.prompt("discard me", { streamingBehavior: "followUp" });
			const before = observed.length;
			const cleared = session.clearQueue();
			assert.deepEqual(cleared, {
				steering: ["resubmit me"],
				followUp: ["discard me"],
			});
			assert.equal(observed.length, before);
			assert.deepEqual(session.getSteeringMessages(), []);
			assert.deepEqual(session.getFollowUpMessages(), []);
			await session.prompt(cleared.steering[0], { streamingBehavior: "steer" });
			assert.equal(
				observed.length,
				before + 1,
				"Explicit resubmission is another observation",
			);
			plans.push({});
		});
		assert.equal(observed.filter((e) => e.text === "resubmit me").length, 2);
		assert.equal(
			userTexts(session.messages).filter((text) => text === "resubmit me")
				.length,
			1,
		);
		assert.ok(!userTexts(session.messages).includes("discard me"));

		await hold("direct helper seed", async () => {
			const before = observed.length;
			await session.steer("direct steer");
			await session.followUp("direct followUp");
			assert.equal(
				observed.length,
				before,
				"Direct SDK queue helpers bypass input",
			);
			plans.push({}, {});
		});
		assert.deepEqual(userTexts(session.messages).slice(-3), [
			"direct helper seed",
			"direct steer",
			"direct followUp",
		]);
		assert.ok(
			!observed.some((e) =>
				["direct steer", "direct followUp"].includes(e.text),
			),
		);

		let beforeCalls = calls.length;
		let beforeInputs = observed.length;
		plans.push({ error: "429 rate limit: synthetic retry" }, {});
		await session.prompt("retry seed");
		await session.waitForIdle();
		assert.equal(calls.length - beforeCalls, 2);
		assert.equal(observed.length - beforeInputs, 1);
		assert.deepEqual(userTexts(calls.at(-2)), userTexts(calls.at(-1)));
		assert.equal(events.filter((e) => e.type === "auto_retry_start").length, 1);
		assert.ok(events.some((e) => e.type === "auto_retry_end" && e.success));
		assert.equal(session.messages.at(-1).stopReason, "stop");

		beforeCalls = calls.length;
		beforeInputs = observed.length;
		plans.push({ error: "context_length_exceeded: synthetic overflow" }, {});
		await session.prompt("overflow seed");
		await session.waitForIdle();
		assert.equal(calls.length - beforeCalls, 2);
		assert.equal(observed.length - beforeInputs, 1);
		assert.deepEqual(compactions, [{ reason: "overflow", willRetry: true }]);
		assert.ok(JSON.stringify(calls.at(-1)).includes("Synthetic spike summary"));
		assert.ok(userTexts(calls.at(-1)).includes("overflow seed"));
		assert.equal(session.messages.at(-1).stopReason, "stop");
		assert.deepEqual(errors, []);
		assert.deepEqual(providerErrors, [
			"429 rate limit: synthetic retry",
			"context_length_exceeded: synthetic overflow",
		]);
		assert.equal(calls.length, 13);
		assert.equal(observed.length, 11);
		assert.deepEqual(plans, []);
		console.log(
			`SDK STREAM PASS: ${calls.length} scripted in-process provider calls; separate-extension transform, streaming steer/followUp delivery, raw-to-expanded skill/template, command bypass, clear/resubmit, direct-helper bypass, retry and overflow-compaction replay without duplicate input. SDK-bound TUI mode, not real TUI/provider.`,
		);
	} finally {
		unsubscribe();
		session.dispose();
	}
}
