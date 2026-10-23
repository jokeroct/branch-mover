// Pure planning logic: which files count as a note's children, where a new folder goes, and where
// each file would land. Free of the Obsidian API so it can be unit tested.

/** The vault root, as `TFolder.path` reports it. */
export const ROOT = "/";

/** `MetadataCache.resolvedLinks`: source path → linked path → link count. */
export type ResolvedLinks = Record<string, Record<string, number>>;

export function folderOf(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash === -1 ? ROOT : path.slice(0, slash);
}

export function nameOf(path: string): string {
	return path.slice(path.lastIndexOf("/") + 1);
}

/** Splits "Glucose.md" into "Glucose" and ".md". Names without an extension keep everything in the stem. */
export function splitName(name: string): { stem: string; ext: string } {
	const dot = name.lastIndexOf(".");
	return dot > 0 ? { stem: name.slice(0, dot), ext: name.slice(dot) } : { stem: name, ext: "" };
}

export function joinPath(folder: string, name: string): string {
	return folder === ROOT || folder === "" ? name : `${folder}/${name}`;
}

/** How a folder path reads in the UI. */
export function folderLabel(path: string): string {
	return path === ROOT ? "Vault root" : path;
}

export function plural(count: number, word: string): string {
	return `${count} ${word}${count === 1 ? "" : "s"}`;
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });

/**
 * The files `parentPath` links to or embeds (notes and attachments), sorted by name. Backlinks,
 * unresolved links, grandchildren and the parent itself are not included.
 */
export function directChildren(links: ResolvedLinks, parentPath: string): string[] {
	return Object.keys(links[parentPath] ?? {})
		.filter((path) => path !== parentPath)
		.sort((a, b) => byName(nameOf(a), nameOf(b)));
}

/** Linked path → the paths that link to it. */
export function backlinkIndex(links: ResolvedLinks): Map<string, string[]> {
	const index = new Map<string, string[]>();
	for (const [source, targets] of Object.entries(links)) {
		for (const [target, count] of Object.entries(targets)) {
			if (count <= 0) continue;
			const sources = index.get(target);
			if (sources) sources.push(source);
			else index.set(target, [source]);
		}
	}
	return index;
}

/** How many files outside `inside` (the parent and its tree) link to `path`. */
export function outsideLinkers(backlinks: ReadonlyMap<string, readonly string[]>, path: string, inside: ReadonlySet<string>): number {
	return (backlinks.get(path) ?? []).filter((source) => source !== path && !inside.has(source)).length;
}

export interface TreeNode {
	path: string;
	/** 1 for the parent's children, 2 for grandchildren, … */
	depth: number;
	/** The note it was first reached from (the parent itself for depth 1). */
	via: string;
}

export interface DescendantTree {
	/** In walk order: level by level, siblings grouped under the note they were reached from. */
	nodes: TreeNode[];
	/** Notes the walk reached but left out because they sit above the parent. */
	skipped: string[];
}

/**
 * The files below `rootPath`, following outgoing links up to `maxDepth` levels. It never climbs: the
 * root, the notes that link to it, the notes that link to those, and so on are never included or
 * walked through, so an "up" link can't pull in another topic. A child that links back to the root
 * is still a child. Each file appears once, at the first level it's reached.
 */
export function descendantTree(
	links: ResolvedLinks,
	rootPath: string,
	maxDepth: number,
	backlinks: ReadonlyMap<string, readonly string[]> = backlinkIndex(links),
): DescendantTree {
	const children = new Set(directChildren(links, rootPath));
	const above = new Set<string>();
	const queue = [rootPath];
	while (queue.length > 0) {
		for (const source of backlinks.get(queue.shift()!) ?? []) {
			if (source === rootPath || children.has(source) || above.has(source)) continue;
			above.add(source);
			queue.push(source);
		}
	}

	const nodes: TreeNode[] = [];
	const seen = new Set([rootPath]);
	const skipped = new Set<string>();
	let frontier = [rootPath];
	for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
		const level: TreeNode[] = [];
		for (const via of frontier) {
			for (const path of directChildren(links, via)) {
				if (seen.has(path)) continue;
				if (above.has(path)) {
					skipped.add(path);
					continue;
				}
				seen.add(path);
				level.push({ path, depth, via });
			}
		}
		nodes.push(...level);
		frontier = level.map((node) => node.path);
	}
	return { nodes, skipped: [...skipped].sort((a, b) => byName(nameOf(a), nameOf(b))) };
}

// ---- Folder names ---------------------------------------------------------------------------

// Windows forbids \ / : * ? " < > |; # ^ [ ] break links that spell out the folder path.
const FORBIDDEN_CHARS = String.raw`\x00-\x1f\\/:*?"<>|#^[\]`;
const FORBIDDEN = new RegExp(`[${FORBIDDEN_CHARS}]`);
const FORBIDDEN_ALL = new RegExp(`[${FORBIDDEN_CHARS}]+`, "g");
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export type FolderCheck = { ok: true; path: string } | { ok: false; reason: string };

function segmentProblem(segment: string): string | null {
	if (segment === "." || segment === "..") return `“${segment}” isn't a folder name.`;
	if (segment.startsWith(".")) return "Folders starting with “.” are hidden from Obsidian.";
	if (FORBIDDEN.test(segment)) return 'Folder names can\'t contain \\ / : * ? " < > | # ^ [ ]';
	if (segment.endsWith(".")) return "Folder names can't end with “.”.";
	if (RESERVED.test(segment)) return `“${segment}” is a reserved name on Windows.`;
	return null;
}

/** Validates and tidies a typed folder path. Backslashes count as separators; "/" alone is the vault root. */
export function checkFolderPath(input: string): FolderCheck {
	if (input.trim() === "") return { ok: false, reason: "Type a folder name." };
	const segments = input
		.replace(/\\/g, "/")
		.split("/")
		.map((segment) => segment.trim())
		.filter((segment) => segment !== "");
	for (const segment of segments) {
		const reason = segmentProblem(segment);
		if (reason) return { ok: false, reason };
	}
	return { ok: true, path: segments.length === 0 ? ROOT : segments.join("/") };
}

/** A folder name made from a note's name: "Bio/What is #DNA?.md" → "What is DNA". */
export function folderNameFor(notePath: string): string {
	const name = splitName(nameOf(notePath))
		.stem.replace(FORBIDDEN_ALL, " ")
		.replace(/^[\s.]+|[\s.]+$/g, "")
		.replace(/\s+/g, " ");
	return name || "Untitled";
}

/** The folder named after a note, next to it: "Bio/Carbohydrates.md" → "Bio/Carbohydrates". */
export function siblingFolder(notePath: string): string {
	return joinPath(folderOf(notePath), folderNameFor(notePath));
}

/**
 * The folder each tree node moves to, folder-note style. A node with ticked files anywhere below
 * it gets a subfolder named after it, inside its own parent's folder, and moves into it with them;
 * other nodes go into their parent's folder. The root's folder is `dest`. With one level, nothing
 * has files below it, so everything lands in `dest`.
 */
export function layoutFolders(
	nodes: readonly TreeNode[],
	rootPath: string,
	selected: ReadonlySet<string>,
	dest: string,
): Map<string, string> {
	// Nodes come parents-first, so walking backwards sees every node before the one it hangs from.
	const owners = new Set<string>();
	for (let i = nodes.length - 1; i >= 0; i--) {
		const { path, via } = nodes[i];
		if (via !== rootPath && (selected.has(path) || owners.has(path))) owners.add(via);
	}
	const folders = new Map<string, string>([[rootPath, dest]]);
	for (const { path, via } of nodes) {
		const container = folders.get(via) ?? dest;
		folders.set(path, owners.has(path) ? joinPath(container, folderNameFor(path)) : container);
	}
	return folders;
}

/** `folder` relative to `dest` ("Glycogen" for "Carbs/Glycogen" in "Carbs"), or null when it isn't inside it. */
export function relativeFolder(folder: string, dest: string): string | null {
	if (folder === ROOT || folder.toLowerCase() === dest.toLowerCase()) return null;
	if (dest === ROOT) return folder;
	return folder.toLowerCase().startsWith(`${dest.toLowerCase()}/`) ? folder.slice(dest.length + 1) : null;
}

/** The folders inside `dest` that the targets need and that don't exist yet (lower-cased paths in `taken`). */
export function newSubfolders(targets: Iterable<string>, dest: string, taken: ReadonlySet<string>): string[] {
	const found = new Set<string>();
	for (const target of targets) {
		for (let folder = folderOf(target); relativeFolder(folder, dest) !== null; folder = folderOf(folder)) {
			if (!taken.has(folder.toLowerCase())) found.add(folder.toLowerCase());
		}
	}
	return [...found];
}

/**
 * Reuses the spelling of folders that already exist, ignoring case ("biology/new" → "Biology/new"
 * when "Biology" exists), because Windows and macOS treat those as the same folder.
 */
export function canonicalFolder(path: string, existing: Iterable<string>): string {
	if (path === ROOT) return ROOT;
	const byLower = new Map<string, string>();
	for (const folder of existing) byLower.set(folder.toLowerCase(), folder);
	let result = "";
	for (const segment of path.split("/")) {
		const candidate = result ? `${result}/${segment}` : segment;
		result = byLower.get(candidate.toLowerCase()) ?? candidate;
	}
	return result;
}

function firstFree(make: (n: number) => string, taken: ReadonlySet<string>): string {
	for (let n = 1; ; n++) {
		const path = make(n);
		if (!taken.has(path.toLowerCase())) return path;
	}
}

/** "Carbohydrates" → "Carbohydrates 1", or the first number not in `taken` (lower-cased paths). */
export function numberedFolder(path: string, taken: ReadonlySet<string>): string {
	return firstFree((n) => `${path} ${n}`, taken);
}

/** "dest/Glucose 1.md", or the first number not in `taken` (lower-cased paths). */
export function numberedFile(dest: string, name: string, taken: ReadonlySet<string>): string {
	const { stem, ext } = splitName(name);
	return firstFree((n) => joinPath(dest, `${stem} ${n}${ext}`), taken);
}

// ---- Move plan ------------------------------------------------------------------------------

/** What to do when a file's name is already taken in the destination. */
export type ClashChoice = "skip" | "rename";

export interface MoveCandidate {
	path: string;
	/** The folder it should end up in. */
	folder: string;
	selected: boolean;
	/** Unset until the user decides; only consulted when the name is taken. */
	choice?: ClashChoice;
}

export type MoveStatus =
	/** Already in the destination folder, so there is nothing to do. */
	| { kind: "here" }
	| { kind: "unselected" }
	| { kind: "move"; target: string }
	/** The name is taken in the destination. `renameTarget` is where "keep both" would put it. */
	| { kind: "taken"; choice: ClashChoice | undefined; renameTarget: string };

/**
 * Where each candidate would land in its folder. `taken` holds the lower-cased paths of everything
 * in the vault; names are compared ignoring case because Windows and macOS file systems do.
 * Candidates are planned in order, so two files with the same name can't both claim it.
 */
export function planMoves(candidates: readonly MoveCandidate[], taken: ReadonlySet<string>): MoveStatus[] {
	const claimed = new Set(taken);
	return candidates.map((candidate): MoveStatus => {
		const { folder } = candidate;
		if (folderOf(candidate.path).toLowerCase() === folder.toLowerCase()) return { kind: "here" };
		if (!candidate.selected) return { kind: "unselected" };
		const name = nameOf(candidate.path);
		const target = joinPath(folder, name);
		if (!claimed.has(target.toLowerCase())) {
			claimed.add(target.toLowerCase());
			return { kind: "move", target };
		}
		const renameTarget = numberedFile(folder, name, claimed);
		if (candidate.choice === "rename") claimed.add(renameTarget.toLowerCase());
		return { kind: "taken", choice: candidate.choice, renameTarget };
	});
}

/** Where a planned file goes, or null when it stays put. */
export function targetOf(status: MoveStatus): string | null {
	if (status.kind === "move") return status.target;
	if (status.kind === "taken" && status.choice === "rename") return status.renameTarget;
	return null;
}
