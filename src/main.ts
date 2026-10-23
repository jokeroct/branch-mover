import { Notice, Plugin, type TAbstractFile, TFile } from "obsidian";
import { FolderPickerModal } from "./folder-picker";
import { FolderExistsModal, MoveConfirmModal } from "./modals";
import { type FileMove, describeOutcome, ensureFolder, runMoves, takenPaths } from "./mover";
import { directChildren, numberedFolder, siblingFolder } from "./plan";

/** The `source` Obsidian passes to `file-menu` when a node is right-clicked in the graph or local graph. */
const GRAPH_MENU = "graph-context-menu";

const isNote = (file: TAbstractFile | null): file is TFile => file instanceof TFile && file.extension === "md";

export default class BranchMoverPlugin extends Plugin {
	onload(): void {
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file, source) => {
				if (source !== GRAPH_MENU || !isNote(file)) return;
				menu.addItem((item) =>
					item
						.setSection("action")
						.setTitle("Move child notes to folder")
						.setIcon("folder-input")
						.onClick(() => this.start(file)),
				);
			}),
		);

		this.addCommand({
			id: "move-child-notes",
			name: "Move child notes of the current note to a folder",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				if (!isNote(file)) return false;
				if (!checking) this.start(file);
				return true;
			},
		});
	}

	/** Finds the files `parent` links to, then asks for a folder, pre-filled with one named after the parent. */
	private start(parent: TFile): void {
		const children = directChildren(this.app.metadataCache.resolvedLinks, parent.path)
			.map((path) => this.app.vault.getFileByPath(path))
			.filter((file): file is TFile => file !== null);
		if (children.length === 0) {
			new Notice(`“${parent.basename}” doesn't link to any notes or files, so there's nothing to move.`);
			return;
		}
		this.pickFolder(parent, children, siblingFolder(parent.path));
	}

	private pickFolder(parent: TFile, children: TFile[], initial: string): void {
		new FolderPickerModal(this.app, parent.basename, initial, ({ path, typed, exists }) => {
			// Picking a listed folder is a clear choice; a typed or pre-filled name that exists asks first.
			if (!typed || !exists) {
				this.confirm(parent, children, path, !exists);
				return;
			}
			const alternative = numberedFolder(path, takenPaths(this.app));
			new FolderExistsModal(this.app, path, alternative, {
				onUse: () => this.confirm(parent, children, path, false),
				onCreate: () => this.confirm(parent, children, alternative, true),
				onBack: () => this.pickFolder(parent, children, path),
			}).open();
		}).open();
	}

	private confirm(parent: TFile, children: TFile[], dest: string, isNew: boolean): void {
		new MoveConfirmModal(
			this.app,
			{ parent, children, dest, isNew },
			{
				onChangeFolder: () => this.pickFolder(parent, children, dest),
				onMove: (moves) => void this.move(dest, moves),
			},
		).open();
	}

	private async move(dest: string, moves: FileMove[]): Promise<void> {
		try {
			await ensureFolder(this.app, dest);
		} catch (error) {
			new Notice(`Couldn't create “${dest}”: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		const outcome = await runMoves(this.app, moves);
		const problems = outcome.skipped.length + outcome.failed.length > 0;
		new Notice(describeOutcome(dest, outcome), problems ? 15000 : 5000);
	}
}
