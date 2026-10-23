// Runs the in-Obsidian checks in a dev vault: node scripts/dev-test.mjs path/to/vault [check ...]
// Installs the plugin and dev/harness into the vault, enables both, opens the vault in Obsidian
// (a new window; other vaults stay open), waits for the harness and prints the results. The vault
// must already allow community plugins. Run `npm run build` first.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

const root = resolve(import.meta.dirname, "..");
const [vaultArg, ...requested] = process.argv.slice(2);
if (!vaultArg) {
	console.error("Usage: node scripts/dev-test.mjs path/to/vault [ui moveNew moveExisting settings]");
	process.exit(1);
}
const vault = resolve(vaultArg);
const checks = requested.length > 0 ? requested : ["ui", "moveNew", "moveExisting", "settings"];
const config = join(vault, ".obsidian");
if (!existsSync(config)) {
	console.error(`No .obsidian folder in ${vault}.`);
	process.exit(1);
}

// Obsidian opens vaults by id; find this one in its vault list.
const appData = process.env.APPDATA ?? join(process.env.HOME ?? "", ".config");
const { vaults } = JSON.parse(readFileSync(join(appData, "obsidian", "obsidian.json"), "utf8"));
const norm = (p) => resolve(p).toLowerCase();
const vaultId = Object.entries(vaults).find(([, v]) => norm(v.path) === norm(vault))?.[0];
if (!vaultId) {
	console.error(`${vault} isn't in Obsidian's vault list. Open it in Obsidian once, then rerun.`);
	process.exit(1);
}

const install = (id, from, files) => {
	const target = join(config, "plugins", id);
	mkdirSync(target, { recursive: true });
	for (const file of files) copyFileSync(join(from, file), join(target, file));
};
const { id: pluginId } = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const harnessDir = join(root, "dev", "harness");
const { id: harnessId } = JSON.parse(readFileSync(join(harnessDir, "manifest.json"), "utf8"));
install(pluginId, root, ["main.js", "manifest.json", "styles.css"]);
install(harnessId, harnessDir, ["main.js", "manifest.json"]);

const enabledPath = join(config, "community-plugins.json");
const enabled = existsSync(enabledPath) ? JSON.parse(readFileSync(enabledPath, "utf8")) : [];
for (const id of [pluginId, harnessId]) if (!enabled.includes(id)) enabled.push(id);
writeFileSync(enabledPath, `${JSON.stringify(enabled, null, 2)}\n`);

const done = join(vault, ".gcm-checks-done");
rmSync(done, { force: true });
writeFileSync(join(vault, ".gcm-run-checks"), [...checks, "close"].join("\n"));
const uri = `obsidian://open?vault=${vaultId}`;
if (process.platform === "win32") execFileSync("cmd", ["/c", "start", "", uri]);
else execFileSync(process.platform === "darwin" ? "open" : "xdg-open", [uri]);
console.log(`Opened ${vault} in Obsidian; running ${checks.join(", ")}…`);

const deadline = Date.now() + 240_000;
while (!existsSync(done)) {
	if (Date.now() > deadline) {
		console.error("Timed out waiting for the harness. Is the vault open, with community plugins allowed?");
		process.exit(1);
	}
	await new Promise((r) => setTimeout(r, 1000));
}

const results = JSON.parse(readFileSync(join(vault, ".gcm-test-results.json"), "utf8"));
let failed = 0;
for (const name of checks) {
	const result = results[name];
	const pass = result?.pass === true;
	if (!pass) failed++;
	console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
	for (const [check, ok] of Object.entries(result?.checks ?? {})) if (!ok) console.log(`        ✗ ${check}`);
	if (result?.error) console.log(`        error: ${result.error.split("\n")[0]}`);
	for (const error of result?.errors ?? []) console.log(`        console: ${error.split("\n")[0]}`);
}
console.log(`Details: ${join(vault, ".gcm-test-results.json")}`);
process.exit(failed > 0 ? 1 : 0);
