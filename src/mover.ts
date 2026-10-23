import { type App, type TFile, TFolder } from "obsidian";
import { ROOT, folderLabel, folderOf, numberedFile, plural } from "./plan";

export interface FileMove {
	file: TFile;
	target: string;
	/** The user chose "keep both", so a fresh numbered name is fine if the target got taken meanwhile. */
	keepBoth: boolean;
}

export interface MoveOutcome {
	moved: number;
	skipped: string[];
	failed: string[];
}

/** Lower-cased paths of every file and folder in the vault. */
export function takenPaths(app: App): Set<string> {
	return new Set(app.vault.getAllLoadedFiles().map((file) => file.path.toLowerCase()));
}

/** Creates `path` and any missing parent folders. */
export async function ensureFolder(app: App, path: string): Promise<void> {
	if (path === ROOT) return;
	let current = "";
	for (const segment of path.split("/")) {
		current = current ? `${current}/${segment}` : segment;
		const existing = app.vault.getAbstractFileByPath(current);
		if (existing instanceof TFolder) continue;
		if (existing) throw new Error(`“${current}” is a file, not a folder`);
		await app.vault.createFolder(current);
	}
}

/**
 * Moves each file to its target one at a time, creating the target's folder (and any parents)
 * first. `FileManager.renameFile` updates every link to a moved file, following the
 * "Automatically update internal links" setting.
 */
export async function runMoves(app: App, moves: readonly FileMove[]): Promise<MoveOutcome> {
	const outcome: MoveOutcome = { moved: 0, skipped: [], failed: [] };
	// The dialog planned against the vault as it was when it opened; recheck in case it changed since.
	const taken = takenPaths(app);
	for (const { file, target, keepBoth } of moves) {
		if (app.vault.getAbstractFileByPath(file.path) !== file) {
			outcome.skipped.push(`${file.name} (no longer exists)`);
			continue;
		}
		let path = target;
		if (taken.has(path.toLowerCase())) {
			if (!keepBoth) {
				outcome.skipped.push(`${file.name} (name now taken in the folder)`);
				continue;
			}
			path = numberedFile(folderOf(target), file.name, taken);
		}
		try {
			await ensureFolder(app, folderOf(path));
			await app.fileManager.renameFile(file, path);
			taken.add(path.toLowerCase());
			outcome.moved++;
		} catch (error) {
			outcome.failed.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return outcome;
}

export function describeOutcome(dest: string, outcome: MoveOutcome): string {
	const lines = [`Moved ${plural(outcome.moved, "file")} to “${folderLabel(dest)}”.`];
	if (outcome.skipped.length > 0) lines.push(`Skipped: ${outcome.skipped.join(", ")}`);
	if (outcome.failed.length > 0) lines.push(`Couldn't move: ${outcome.failed.join("; ")}`);
	return lines.join("\n");
}
