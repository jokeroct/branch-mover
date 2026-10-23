import { type App, type ButtonComponent, DropdownComponent, Modal, Setting, type TFile, setIcon } from "obsidian";
import { type FileMove, takenPaths } from "./mover";
import {
	type ClashChoice,
	type DescendantTree,
	type MoveStatus,
	type TreeNode,
	backlinkIndex,
	descendantTree,
	folderLabel,
	folderOf,
	layoutFolders,
	nameOf,
	newSubfolders,
	outsideLinkers,
	planMoves,
	plural,
	relativeFolder,
	splitName,
	targetOf,
} from "./plan";

// ---- Folder already exists ------------------------------------------------------------------

export interface FolderExistsActions {
	onUse: () => void;
	onCreate: () => void;
	onBack: () => void;
}

/** Asks whether to move into a folder that already exists or create a numbered one next to it. */
export class FolderExistsModal extends Modal {
	constructor(
		app: App,
		private readonly path: string,
		private readonly alternative: string,
		private readonly actions: FolderExistsActions,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.titleEl.setText("Folder already exists");
		this.modalEl.addClass("gcm-modal");
		const items = this.app.vault.getFolderByPath(this.path)?.children.length ?? 0;
		const contents = items > 0 ? `contains ${plural(items, "item")}` : "is empty";
		contentEl.createEl("p", {
			text: `“${this.path}” already exists and ${contents}. Move the child notes into it, or create a new folder?`,
		});
		new Setting(contentEl)
			.addButton((button) => button.setButtonText("Back").onClick(() => this.choose(this.actions.onBack)))
			.addButton((button) =>
				button.setButtonText(`Create “${nameOf(this.alternative)}”`).onClick(() => this.choose(this.actions.onCreate)),
			)
			.addButton((button) =>
				button
					.setButtonText("Use existing folder")
					.setCta()
					.onClick(() => this.choose(this.actions.onUse)),
			);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private choose(action: () => void): void {
		this.close();
		action();
	}
}

// ---- Confirm the move -----------------------------------------------------------------------

export interface MoveRequest {
	parent: TFile;
	children: TFile[];
	dest: string;
	/** `dest` doesn't exist yet. It is created only when the move is confirmed. */
	isNew: boolean;
}

export interface MoveActions {
	onChangeFolder: () => void;
	onMove: (moves: FileMove[]) => void;
}

type Levels = 1 | 2 | "all";
const LEVELS: { value: Levels; label: string }[] = [
	{ value: 1, label: "1" },
	{ value: 2, label: "2" },
	{ value: "all", label: "All" },
];

const levelTitle = (depth: number) => (depth === 1 ? "Children" : depth === 2 ? "Grandchildren" : `Level ${depth}`);
const noteName = (path: string) => (path.endsWith(".md") ? splitName(nameOf(path)).stem : nameOf(path));

interface Row {
	file: TFile;
	selected: boolean;
	checkbox: HTMLInputElement;
	rowEl: HTMLElement;
	destEl: HTMLElement;
	clashEl: HTMLElement;
	clash: { message: HTMLElement; dropdown: DropdownComponent; renameOption: HTMLOptionElement } | null;
}

/**
 * Lists the parent and the notes below it (to the chosen depth) with checkboxes, resolves name
 * clashes, and confirms the move. Notes with ticked notes below them get their own subfolder.
 */
export class MoveConfirmModal extends Modal {
	/** The parent's row first, then the tree's rows in walk order. */
	private readonly rows: Row[] = [];
	private readonly taken: Set<string>;
	private readonly backlinks: Map<string, string[]>;
	/** Ticks the user changed, kept across level switches. */
	private readonly overrides = new Map<string, boolean>();
	private readonly choices = new Map<string, ClashChoice>();
	private levels: Levels = 2;
	private tree: DescendantTree = { nodes: [], skipped: [] };
	private statuses: MoveStatus[] = [];
	private levelButtons: HTMLButtonElement[] = [];
	private listEl!: HTMLElement;
	private countEl!: HTMLElement;
	private skippedEl!: HTMLElement;
	private summaryEl!: HTMLElement;
	private moveButton!: ButtonComponent;

	constructor(
		app: App,
		private readonly request: MoveRequest,
		private readonly actions: MoveActions,
	) {
		super(app);
		this.taken = takenPaths(app);
		this.backlinks = backlinkIndex(app.metadataCache.resolvedLinks);
	}

	onOpen(): void {
		const { contentEl, request } = this;
		const { parent, dest, isNew } = request;
		this.titleEl.setText(`Move child notes of “${parent.basename}”`);
		this.modalEl.addClass("gcm-modal");

		const destDesc = createFragment((fragment) => {
			fragment.createEl("code", { text: folderLabel(dest) });
			fragment.createSpan({ cls: "gcm-badge", text: isNew ? "new folder" : "existing folder" });
		});
		new Setting(contentEl)
			.setName("Destination")
			.setDesc(destDesc)
			.addButton((button) =>
				button.setButtonText("Change folder…").onClick(() => {
					this.close();
					this.actions.onChangeFolder();
				}),
			);

		const levels = new Setting(contentEl)
			.setName("Levels")
			.setDesc("1: children only. 2: also their children. All: everything below.");
		const group = levels.controlEl.createDiv({ cls: "gcm-levels" });
		this.levelButtons = LEVELS.map(({ value, label }) => {
			const button = group.createEl("button", { text: label });
			button.addEventListener("click", () => this.setLevels(value));
			return button;
		});

		this.sectionHeader("Parent note");
		const parentList = contentEl.createDiv({ cls: "gcm-list" });
		this.rows.push(this.createRow(parentList, parent, false, "parent", "Stays where it is unless ticked"));

		const header = this.sectionHeader(`Below “${parent.basename}”`);
		this.countEl = (header.firstElementChild as HTMLElement).createSpan({ cls: "gcm-count" });
		const select = header.createDiv({ cls: "gcm-select-links" });
		this.selectLink(select, "All", true);
		this.selectLink(select, "None", false);
		this.listEl = contentEl.createDiv({ cls: "gcm-list gcm-children" });
		this.skippedEl = contentEl.createDiv({ cls: "gcm-skipped" });

		this.summaryEl = contentEl.createDiv({ cls: "gcm-summary" });
		const updatesLinks = (this.app.vault as unknown as { getConfig?(key: string): unknown }).getConfig?.("alwaysUpdateLinks");
		contentEl.createDiv({
			cls: `gcm-link-note${updatesLinks === false ? " mod-warning" : ""}`,
			text:
				updatesLinks === false
					? "Obsidian will ask before updating links to each moved file. Turn on Settings → Files and links → Automatically update internal links to skip those prompts."
					: "Links to the moved files are updated automatically.",
		});

		new Setting(contentEl)
			.addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()))
			.addButton((button) => {
				this.moveButton = button.setCta().onClick(() => this.confirm());
			});
		this.setLevels(this.levels);
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private setLevels(levels: Levels): void {
		this.levels = levels;
		LEVELS.forEach(({ value }, i) => {
			this.levelButtons[i].toggleClass("is-active", value === levels);
			this.levelButtons[i].setAttr("aria-pressed", String(value === levels));
		});
		this.buildTree();
		this.refresh();
	}

	/** Rebuilds the rows below the parent for the current depth. */
	private buildTree(): void {
		const { parent } = this.request;
		const links = this.app.metadataCache.resolvedLinks;
		const maxDepth = this.levels === "all" ? Infinity : this.levels;
		this.tree = descendantTree(links, parent.path, maxDepth, this.backlinks);
		const inside = new Set([parent.path, ...this.tree.nodes.map((node) => node.path)]);

		this.rows.splice(1);
		this.listEl.empty();
		const perLevel = new Map<number, number>();
		for (const { depth } of this.tree.nodes) perLevel.set(depth, (perLevel.get(depth) ?? 0) + 1);
		let depth = 0;
		for (const node of this.tree.nodes) {
			const file = this.app.vault.getFileByPath(node.path);
			if (!file) continue;
			if (node.depth !== depth) {
				depth = node.depth;
				this.listEl.createDiv({ cls: "gcm-level-header", text: `${levelTitle(depth)} (${perLevel.get(depth)})` });
			}
			this.rows.push(this.treeRow(file, node, inside));
		}
		if (this.levels !== 1 && !this.tree.nodes.some((node) => node.depth > 1)) {
			this.listEl.createDiv({ cls: "gcm-level-empty", text: "No grandchildren: the children don't link to other notes or files." });
		}
		this.countEl.setText(`(${plural(this.tree.nodes.length, "file")})`);

		const { skipped } = this.tree;
		this.skippedEl.toggle(skipped.length > 0);
		this.skippedEl.setText(
			`Not included: ${skipped.map(noteName).join(", ")}. ${skipped.length === 1 ? "It links" : "They link"} to “${parent.basename}” or a note above it.`,
		);
	}

	private treeRow(file: TFile, node: TreeNode, inside: ReadonlySet<string>): Row {
		const others = outsideLinkers(this.backlinks, node.path, inside);
		// Direct child notes are what was asked for. Anything shared further down, and shared
		// attachments like a textbook PDF many notes cite, likely belong where they are.
		const byDefault = (node.depth === 1 && file.extension === "md") || others === 0;
		const info = [
			node.depth > 1 ? `Via ${noteName(node.via)}` : "",
			others > 0 ? `Also linked from ${plural(others, "note")} outside this tree` : "",
		];
		const text = info.filter(Boolean).join(" · ");
		const badge = file.extension === "md" ? null : "attachment";
		return this.createRow(this.listEl, file, this.overrides.get(file.path) ?? byDefault, badge, text);
	}

	private sectionHeader(text: string): HTMLElement {
		const header = this.contentEl.createDiv({ cls: "gcm-section-header" });
		header.createSpan({ text });
		return header;
	}

	private selectLink(parent: HTMLElement, text: string, selected: boolean): void {
		const link = parent.createEl("a", { text, href: "#" });
		link.addEventListener("click", (event) => {
			event.preventDefault();
			// Index 0 is the parent row, which is opted into separately.
			for (const row of this.rows.slice(1)) {
				if (row.checkbox.disabled) continue;
				row.selected = selected;
				row.checkbox.checked = selected;
				this.overrides.set(row.file.path, selected);
			}
			this.refresh();
		});
	}

	private createRow(list: HTMLElement, file: TFile, selected: boolean, badge: string | null, info: string): Row {
		const rowEl = list.createDiv({ cls: "gcm-row", attr: { "data-path": file.path } });
		const main = rowEl.createEl("label", { cls: "gcm-row-main" });
		const checkbox = main.createEl("input", { type: "checkbox" });
		setIcon(main.createSpan({ cls: "gcm-row-icon" }), file.extension === "md" ? "file-text" : "paperclip");
		main.createSpan({ cls: "gcm-row-name", text: file.extension === "md" ? file.basename : file.name });
		if (badge) main.createSpan({ cls: "gcm-badge", text: badge });
		const folder = folderOf(file.path);
		main.createSpan({ cls: "gcm-row-where", text: nameOf(folder) || folderLabel(folder), attr: { title: folderLabel(folder) } });
		if (info) rowEl.createDiv({ cls: "gcm-row-info", text: info });
		const destEl = rowEl.createDiv({ cls: "gcm-row-dest" });
		const clashEl = rowEl.createDiv({ cls: "gcm-row-clash" });

		const row: Row = { file, selected, checkbox, rowEl, destEl, clashEl, clash: null };
		checkbox.checked = selected;
		checkbox.addEventListener("change", () => {
			row.selected = checkbox.checked;
			this.overrides.set(file.path, checkbox.checked);
			this.refresh();
		});
		return row;
	}

	private refresh(): void {
		const { dest, isNew, parent } = this.request;
		const selected = new Set(this.rows.filter((row) => row.selected).map((row) => row.file.path));
		const folders = layoutFolders(this.tree.nodes, parent.path, selected, dest);
		this.statuses = planMoves(
			this.rows.map(({ file, selected }) => ({
				path: file.path,
				folder: folders.get(file.path) ?? dest,
				selected,
				choice: this.choices.get(file.path),
			})),
			this.taken,
		);

		let notes = 0;
		let attachments = 0;
		let undecided = 0;
		const targets: string[] = [];
		this.statuses.forEach((status, i) => {
			const row = this.rows[i];
			this.renderStatus(row, status);
			const target = targetOf(status);
			if (target) {
				targets.push(target);
				if (row.file.extension === "md") notes++;
				else attachments++;
			}
			if (status.kind === "taken" && !status.choice) undecided++;
		});

		const moving = notes + attachments;
		const counts = [notes > 0 ? plural(notes, "note") : "", attachments > 0 ? plural(attachments, "attachment") : ""]
			.filter(Boolean)
			.join(" and ");
		const created = newSubfolders(targets, dest, this.taken).length;
		const subfolders = created > 0 ? `, with ${plural(created, "new subfolder")}` : "";
		this.summaryEl.setText(
			undecided > 0
				? `Choose what to do for ${plural(undecided, "file")} whose name is already taken in the destination.`
				: moving === 0
					? "Nothing selected to move."
					: `${counts} will move to “${folderLabel(dest)}”${isNew ? " (a new folder)" : ""}${subfolders}.`,
		);
		this.summaryEl.toggleClass("mod-warning", undecided > 0);
		this.moveButton.setButtonText(moving > 0 ? `Move ${plural(moving, "file")}` : "Move");
		this.moveButton.setDisabled(undecided > 0 || moving === 0);
	}

	private renderStatus(row: Row, status: MoveStatus): void {
		const { dest } = this.request;
		const here = status.kind === "here";
		const staying = here || status.kind === "unselected" || (status.kind === "taken" && status.choice === "skip");
		row.rowEl.toggleClass("is-unselected", staying);
		row.checkbox.disabled = here;
		row.checkbox.parentElement?.toggleClass("is-disabled", here);

		// Where it lands, when that's a subfolder of the destination.
		const target = status.kind === "move" ? status.target : status.kind === "taken" ? status.renameTarget : null;
		const subfolder = target ? relativeFolder(folderOf(target), dest) : null;
		const where = here ? "Already in place" : subfolder && !staying ? `→ ${subfolder}/` : "";
		row.destEl.setText(where);
		row.destEl.toggle(where !== "");

		if (status.kind !== "taken") {
			row.clashEl.hide();
			return;
		}
		row.clashEl.show();
		// Built once and updated in place, so changing the choice doesn't steal focus from the dropdown.
		if (!row.clash) {
			const message = row.clashEl.createSpan({ cls: "gcm-clash-message" });
			const dropdown = new DropdownComponent(row.clashEl)
				.addOption("", "Choose what to do…")
				.addOption("skip", "Skip this file")
				.addOption("rename", "Keep both")
				.onChange((value) => {
					if (value === "") this.choices.delete(row.file.path);
					else this.choices.set(row.file.path, value as ClashChoice);
					this.refresh();
				});
			const renameOption = dropdown.selectEl.querySelector<HTMLOptionElement>('option[value="rename"]')!;
			row.clash = { message, dropdown, renameOption };
		}
		const { message, dropdown, renameOption } = row.clash;
		message.setText(`A file named “${row.file.name}” is already in ${subfolder ? `“${subfolder}”` : "the destination"}.`);
		renameOption.text = `Keep both, move it as “${nameOf(status.renameTarget)}”`;
		dropdown.setValue(status.choice ?? "");
		row.clashEl.toggleClass("is-undecided", !status.choice);
	}

	private confirm(): void {
		const moves = this.rows.flatMap((row, i): FileMove[] => {
			const status = this.statuses[i];
			const target = targetOf(status);
			return target ? [{ file: row.file, target, keepBoth: status.kind === "taken" }] : [];
		});
		if (moves.length === 0) return;
		this.close();
		this.actions.onMove(moves);
	}
}
