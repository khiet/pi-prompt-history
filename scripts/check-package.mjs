// Checks the package shape Pi installs: one extension entry point, an explicit
// file allowlist that is exactly what npm packs, `*` Pi peers that are never
// bundled, no runtime dependencies or install scripts, a committed lockfile,
// a publishable manifest that links back to the repository, and MIT in the
// manifest, lockfile, and LICENSE file.
// Run from the repository root; exits non-zero on any violation.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join, normalize } from "node:path";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const PEERS = ["@earendil-works/pi-coding-agent", "@earendil-works/pi-tui"];

assert.deepEqual(manifest.pi, { extensions: ["./src/index.ts"] });

// Pi's package docs: import Pi's core packages as `*` peers, never bundle them.
assert.deepEqual(
	manifest.peerDependencies,
	Object.fromEntries(PEERS.map((peer) => [peer, "*"])),
);
for (const field of [
	"dependencies",
	"optionalDependencies",
	"bundleDependencies",
	"bundledDependencies",
])
	assert.equal(manifest[field], undefined, `${field} must be absent`);

// Git installs run `npm install`, which would run these.
for (const hook of [
	"preinstall",
	"install",
	"postinstall",
	"prepare",
	"prepublish",
])
	assert.equal(manifest.scripts?.[hook], undefined, `${hook} script`);

execFileSync("git", ["ls-files", "--error-unmatch", "package-lock.json"], {
	stdio: "ignore",
});

// Published to npm. Pi's package gallery lists only packages with the
// `pi-package` keyword.
assert.equal(manifest.private, undefined, "package must be publishable");
assert.match(
	manifest.version,
	/^\d+\.\d+\.\d+$/,
	"version is not plain semver",
);
assert.notEqual(manifest.version, "0.0.0", "version is the unreleased 0.0.0");
assert.ok(manifest.keywords?.includes("pi-package"), "pi-package keyword");
for (const field of ["repository", "homepage", "bugs", "author"])
	assert.ok(manifest[field], `${field} must be set`);
assert.equal(manifest.license, "MIT", "manifest license");
const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
assert.equal(lock.packages[""].license, manifest.license, "lockfile license");
assert.match(readFileSync("LICENSE", "utf8"), /^MIT License\n/, "LICENSE text");

// npm must pack exactly the allowlist plus the files it always adds.
assert.ok(Array.isArray(manifest.files) && manifest.files.length > 0);
const [packed] = JSON.parse(
	execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
		encoding: "utf8",
	}),
);
assert.deepEqual(
	packed.files.map((file) => file.path).sort(),
	["LICENSE", "README.md", "package.json", ...manifest.files].sort(),
	"packed files differ from the allowlist",
);

// Runtime imports stay within Node built-ins, the peers, and packed files.
const builtins = new Set(builtinModules);
for (const file of manifest.files.filter((path) => path.endsWith(".ts"))) {
	const source = readFileSync(file, "utf8");
	for (const [, from, bare, dynamic] of source.matchAll(
		/(?:^|\s)(?:import|export)\s[^;]*?from\s+"([^"]+)"|^import\s+"([^"]+)"|import\("([^"]+)"\)/gm,
	)) {
		const specifier = from ?? bare ?? dynamic ?? "";
		if (specifier.startsWith(".")) {
			const target = normalize(join(dirname(file), specifier));
			assert.ok(manifest.files.includes(target), `${file}: ${specifier}`);
		} else if (!PEERS.includes(specifier)) {
			const bare = specifier.replace(/^node:/, "");
			assert.ok(builtins.has(bare), `${file}: ${specifier} is not allowed`);
		}
	}
}

console.log(`Package OK: ${packed.files.length} files, ${packed.size} bytes`);
