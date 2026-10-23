import { type App, Notice, type SearchResult, SuggestModal, TFile, prepareFuzzySearch, renderResults, setIcon } from "obsidian";
import { ROOT, canonicalFolder, checkFolderPath, folderLabel } from "./plan";

type FolderChoice =
	/** The folder typed (or pre-filled) in the box; created on confirm when it doesn't exist. */
	| { kind: "typed"; path: string; exists: boolean }
	| { kind: "invalid"; input: string; reason: string }
	| { kind: "folder"; path: string; result: SearchResult | null };

export interface FolderPick {
	path: string;
	/** Typed in the box rather than picked from the list of existing folders. */
	typed: boolean;
	exists: boolean;
}

/** Pick an existing folder, or type a path to create one. Opens pre-filled with `initial`. */
export class FolderPickerModal extends SuggestModal<FolderChoice> {
	private readonly folders: string[];
	private readonly initialInput: string;

	constructor(
		app: App,
		parentName: string,
		initial: string,
		private readonly onPick: (pick: FolderPick) => void,
	) {
		super(app);
		this.folders = app.vault
			.getAllFolders(true)
			.map((folder) => folder.path)
			.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
		this.initialInput = initial === ROOT ? "" : initial;
		this.limit = 200;
		this.emptyStateText = "No matching folders";
		this.setPlaceholder("Type a folder to create, or search existing folders");
		this.setInstructions([
			{ command: "↑↓", purpose: "to navigate" },
			{ command: "↵", purpose: "to choose" },
			{ command: "esc", purpose: "to cancel" },
		]);
		this.modalEl.addClass("gcm-picker");
		this.modalEl.prepend(createDiv({ cls: "gcm-picker-title", text: `Move child notes of “${parentName}” to…` }));
	}

	onOpen(): void {
		void super.onOpen();
		this.inputEl.value = this.initialInput;
		this.inputEl.dispatchEvent(new Event("input"));
		this.inputEl.select();
	}

	getSuggestions(query: string): FolderChoice[] {
		const input = query.trim();
		const typed = input ? this.typedChoice(input) : null;
		const typedPath = typed && typed.kind !== "invalid" ? typed.path : null;
		// Until the pre-filled name is edited, list every folder so an existing one is easy to pick instead.
		const filter = input !== "" && query !== this.initialInput;
		const search = prepareFuzzySearch(input);
		const folders = this.folders
			.filter((path) => path !== typedPath)
			.map((path): FolderChoice => ({ kind: "folder", path, result: filter ? search(folderLabel(path)) : null }))
			.filter((choice) => !filter || (choice.kind === "folder" && choice.result !== null));
		if (filter) folders.sort((a, b) => score(b) - score(a));
		return typed ? [typed, ...folders] : folders;
	}

	renderSuggestion(choice: FolderChoice, el: HTMLElement): void {
		el.addClass("mod-complex");
		const content = el.createDiv({ cls: "suggestion-content" });
		const title = content.createDiv({ cls: "suggestion-title" });
		const icon = el.createDiv({ cls: "suggestion-aux" }).createSpan({ cls: "suggestion-flair" });
		const note = (text: string) => content.createDiv({ cls: "suggestion-note", text });
		switch (choice.kind) {
			case "typed":
				if (choice.exists) {
					setIcon(icon, "folder");
					title.setText(choice.path);
					note("Already exists. You'll be asked whether to use it or create a new one.");
				} else {
					setIcon(icon, "folder-plus");
					title.setText(`Create folder “${choice.path}”`);
					note("Created when you confirm the move");
				}
				break;
			case "invalid":
				el.addClass("is-disabled");
				setIcon(icon, "alert-triangle");
				title.setText(`Can't use “${choice.input}”`);
				note(choice.reason);
				break;
			case "folder":
				setIcon(icon, "folder");
				if (choice.result) renderResults(title, folderLabel(choice.path), choice.result);
				else title.setText(folderLabel(choice.path));
				break;
		}
	}

	selectSuggestion(choice: FolderChoice, evt: MouseEvent | KeyboardEvent): void {
		// Keep the picker open so the name can be fixed.
		if (choice.kind === "invalid") {
			new Notice(choice.reason);
			return;
		}
		super.selectSuggestion(choice, evt);
	}

	onChooseSuggestion(choice: FolderChoice): void {
		if (choice.kind === "invalid") return;
		this.onPick({ path: choice.path, typed: choice.kind === "typed", exists: choice.kind === "folder" || choice.exists });
	}

	private typedChoice(input: string): FolderChoice {
		const check = checkFolderPath(input);
		if (!check.ok) return { kind: "invalid", input, reason: check.reason };
		// Typing "/" picks the root; there is nothing to create or ask about.
		if (check.path === ROOT) return { kind: "folder", path: ROOT, result: null };
		const path = canonicalFolder(check.path, this.folders);
		if (this.app.vault.getAbstractFileByPath(path) instanceof TFile) {
			return { kind: "invalid", input, reason: `“${path}” is a file, not a folder.` };
		}
		return { kind: "typed", path, exists: this.folders.includes(path) };
	}
}

const score = (choice: FolderChoice) => (choice.kind === "folder" ? (choice.result?.score ?? 0) : 0);
