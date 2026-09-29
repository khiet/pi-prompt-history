// Packs the extension, unpacks it into a directory with no node_modules
// anywhere above it, adds it with `pi install` to a Pi release installed with
// no devDependencies and no install scripts, and loads it through the real CLI:
//
//   node scripts/smoke-install.mjs <pi version>
//
// It checks that the unpacked package holds only the allowlisted files, that
// Pi loads `/history` from its manifest with nothing installed beside it, and
// that prompts from the print, JSON, and RPC frontends reach the input hook yet
// are never recorded. Needs the npm registry; spike/driver.ts swallows prompts,
// so no model is called.

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

const version = process.argv[2];
assert.match(
	version ?? "",
	/^\d+\.\d+\.\d+$/,
	"usage: smoke-install <pi version>",
);

const repo = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
const root = mkdtempSync(join(tmpdir(), "pph-smoke-"));

try {
	const [{ filename }] = JSON.parse(
		execFileSync(
			"npm",
			["pack", "--json", "--ignore-scripts", "--pack-destination", root],
			{ cwd: repo, encoding: "utf8" },
		),
	);
	const installed = join(root, "extension");
	mkdirSync(installed);
	execFileSync("tar", [
		"-xzf",
		join(root, filename),
		"-C",
		installed,
		"--strip-components=1",
	]);
	assert.deepEqual(
		walk(installed).sort(),
		["README.md", "package.json", ...manifest.files].sort(),
		"unpacked files differ from the allowlist",
	);

	// Pi lives in its own directory, so the extension cannot borrow its modules
	// through node_modules resolution; Pi must supply its own packages.
	const app = join(root, "pi");
	mkdirSync(app);
	writeFileSync(join(app, "package.json"), '{"name":"app","private":true}');
	execFileSync(
		"npm",
		[
			"install",
			"--omit=dev",
			"--ignore-scripts",
			"--no-audit",
			"--no-fund",
			`@earendil-works/pi-coding-agent@${version}`,
		],
		{ cwd: app, stdio: "ignore" },
	);

	const home = join(root, "home");
	const agent = join(home, "agent");
	const driverLog = join(root, "driver.jsonl");
	const env = {
		PATH: process.env.PATH,
		HOME: home,
		PI_CODING_AGENT_DIR: agent,
		PI_OFFLINE: "1",
		PI_TELEMETRY: "0",
		DRIVER_LOG: driverLog,
	};
	const cli = join(
		app,
		"node_modules/@earendil-works/pi-coding-agent/dist/cli.js",
	);
	// A load failure makes Pi exit non-zero, which fails the run.
	const pi = (args, { agentDir = agent, input = "" } = {}) =>
		run(
			process.execPath,
			[
				cli,
				"--offline",
				"--no-context-files",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				...args,
			],
			{ cwd: app, env: { ...env, PI_CODING_AGENT_DIR: agentDir }, input },
		);
	const rpc = (command) => `${JSON.stringify({ id: "1", ...command })}\n`;

	// The documented route: `pi install` adds the package to Pi's settings.
	await run(process.execPath, [cli, "install", installed], { cwd: app, env });
	const responses = (
		await pi(["--mode", "rpc"], { input: rpc({ type: "get_commands" }) })
	)
		.split("\n")
		.filter((line) => line.startsWith("{"))
		.map((line) => JSON.parse(line));
	const history = responses
		.find((line) => line.command === "get_commands")
		?.data.commands.find((command) => command.name === "history");
	assert.equal(
		history?.sourceInfo.path,
		join(installed, "src/index.ts"),
		"Pi did not load /history from the installed manifest",
	);
	assert.equal(history.sourceInfo.origin, "package");

	// Pi loads `-e` extensions before installed packages, and the driver
	// swallows input, so the frontends use a separate agent directory where
	// both come from `-e`, in order: the extension's hook runs first, as
	// spike/pause.py shows by recording before the same driver swallows.
	const bare = join(home, "bare-agent");
	const frontend = (args, input) =>
		pi(["-e", installed, "-e", join(repo, "spike/driver.ts"), ...args], {
			agentDir: bare,
			input,
		});
	await frontend(["-p", "print prompt"]);
	await frontend(["--mode", "json", "json prompt"]);
	await frontend(
		["--mode", "rpc"],
		rpc({ type: "prompt", message: "rpc prompt" }),
	);
	const inputs = readFileSync(driverLog, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
		.filter(({ kind }) => kind === "input")
		.map(({ text, source, mode }) => `${text}/${source}/${mode}`);
	assert.deepEqual(inputs, [
		"print prompt/interactive/print",
		"json prompt/interactive/json",
		"rpc prompt/rpc/rpc",
	]);
	for (const dir of [agent, bare])
		assert.ok(
			!existsSync(join(dir, "prompt-history")),
			"a non-TUI frontend touched the history store",
		);

	console.log(
		`Install smoke OK: Pi ${version}, Node ${process.version}, ${filename}`,
	);
} finally {
	rmSync(root, { recursive: true, force: true });
}

function walk(dir) {
	return readdirSync(dir, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => relative(dir, join(entry.parentPath, entry.name)));
}

function run(command, args, { cwd, env, input }) {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { cwd, env });
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk;
			// RPC mode keeps reading stdin; end it once the request is answered.
			if (input && stdout.includes('"type":"response"')) child.stdin.end();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		child.on("error", reject);
		child.on("close", (code) =>
			code === 0
				? resolvePromise(stdout)
				: reject(new Error(`Pi exited ${code}: ${stderr.slice(-2000)}`)),
		);
		if (input) child.stdin.write(input);
		else child.stdin.end();
	});
}
