// Dev-vault-only harness for Branch Mover. Not part of the plugin.
// Drives the real flow (graph node right-click → context menu → folder picker → dialogs) with
// synthetic DOM events, records what each step showed to .gcm-test-results.json in the vault root,
// and saves screenshots to .gcm-shots/. Everything it creates lives in "Child mover test/".
const { Menu, Plugin } = require("obsidian");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const RESULTS = ".gcm-test-results.json";
const TRIGGER = ".gcm-run-checks";
const DONE = ".gcm-checks-done";
const SHOTS = ".gcm-shots";
const PLUGIN_ID = "branch-mover";
const FIXTURES = "Child mover test";
const MARKER = `${FIXTURES}/.gcm-fixture`;
const ITEM = "Move child notes to folder";

// Carbohydrates links to three notes (one in a subfolder), embeds an image and cites a PDF that
// another note also cites. Grandchildren: Glucose (via Monosaccharides), Glycogen and Starch (via
// Polysaccharides); Glycogen granule is level 3. Starch is also cited outside the tree.
// Biological Molecules links to Carbohydrates, so it's above it; Monosaccharides links up to it,
// and the walk must not climb there (or on to Lipids). Disaccharides links back to its parent.
// "Carbohydrates/Disaccharides.md" already sits in the default folder, so moving there clashes; the
// links that need it spell out the path because the name is ambiguous.
const notesIn = (base) => ({
	"Carbohydrates.md": `Energy molecules.\n\n[[Monosaccharides]]\n[[${base}/Disaccharides|Disaccharides]]\n[[Polysaccharides]]\n\n![[sugar diagram.png]]\n\nSee [[Shared textbook.pdf]] and [[Carbohydrates]] itself.\n`,
	"Biological Molecules.md": "Overview: [[Carbohydrates]] and [[Lipids]]\n",
	"Lipids.md": "Fats.\n",
	"Monosaccharides.md": "Simple sugars, e.g. [[Glucose]].\n\nUp: [[Biological Molecules]]\n",
	"Glucose.md": "A monosaccharide.\n",
	"Disaccharides.md": "Two sugars. Back to [[Carbohydrates]].\n",
	"Sub/Polysaccharides.md": "Many sugars: [[Glycogen]], [[Starch]].\n",
	"Glycogen.md": "Animal storage. See [[Glycogen granule]].\n",
	"Glycogen granule.md": "A granule.\n",
	"Starch.md": "Plant storage.\n",
	"Other note.md": `Cites [[Shared textbook.pdf]], [[Starch]] and [[${base}/Disaccharides|Disaccharides]].\n`,
	"Carbohydrates/Disaccharides.md": "An older note with the same name, already in the folder.\n",
});
const PNG = Uint8Array.from(
	atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
	(c) => c.charCodeAt(0),
);
const BINARIES = {
	"sugar diagram.png": PNG,
	"Shared textbook.pdf": new TextEncoder().encode("%PDF-1.4\n%%EOF\n"),
};

module.exports = class GcmDevHarness extends Plugin {
	onload() {
		for (const name of ["ui", "moveNew", "moveExisting"]) {
			this.addCommand({ id: name, name: `Run check: ${name}`, callback: () => this.run([name]) });
		}
		// Runs the checks named in .gcm-run-checks (on startup, and whenever the file appears), then
		// deletes it. "close" in the file closes this vault window afterwards.
		this.app.workspace.onLayoutReady(() => {
			void this.poll();
			this.registerInterval(window.setInterval(() => void this.poll(), 2000));
		});
	}

	async poll() {
		const { adapter } = this.app.vault;
		if (this.running || !(await adapter.exists(TRIGGER))) return;
		const names = (await adapter.read(TRIGGER)).split(/[\s,]+/).filter(Boolean);
		await adapter.remove(TRIGGER);
		await this.run(names.filter((n) => n !== "close"));
		if (names.includes("close")) setTimeout(() => require("electron").remote.getCurrentWindow().close(), 500);
	}

	async run(names) {
		this.running = true;
		const { adapter } = this.app.vault;
		// setConfig saves Obsidian's whole in-memory config, which can drop keys from app.json, so the
		// file is put back exactly as it was afterwards.
		const appJson = `${this.app.vault.configDir}/app.json`;
		const savedAppJson = (await adapter.exists(appJson)) ? await adapter.read(appJson) : null;
		try {
			await sleep(1500);
			// Pick up a freshly installed main.js without restarting Obsidian.
			await this.app.plugins.disablePlugin(PLUGIN_ID);
			await this.app.plugins.enablePlugin(PLUGIN_ID);
			this.originalUpdateLinks = this.app.vault.getConfig("alwaysUpdateLinks");
			for (const name of names) await this.record(name, () => this[name]());
		} finally {
			this.app.vault.setConfig("alwaysUpdateLinks", this.originalUpdateLinks);
			await sleep(3000); // let Obsidian's debounced config save land before restoring the file
			if (savedAppJson !== null) await adapter.write(appJson, savedAppJson);
			this.running = false;
			await adapter.write(DONE, new Date().toISOString());
		}
	}

	async record(name, check) {
		const errors = [];
		const onError = (event) => errors.push(String(event.error?.stack ?? event.reason?.stack ?? event.message ?? event.reason));
		const consoleError = console.error;
		console.error = (...args) => {
			errors.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(" "));
			consoleError.apply(console, args);
		};
		window.addEventListener("error", onError);
		window.addEventListener("unhandledrejection", onError);
		const outsideBefore = this.outsideSnapshot();
		let result;
		this.partial = {};
		try {
			result = await check();
		} catch (error) {
			result = { ...this.partial, pass: false, error: String(error?.stack ?? error) };
		} finally {
			console.error = consoleError;
			window.removeEventListener("error", onError);
			window.removeEventListener("unhandledrejection", onError);
			await this.closeModals();
			this.closeGraph();
		}
		result.errors = errors;
		if (errors.length > 0) result.pass = false;
		// Nothing outside the fixture folder may be added, removed or modified by a check.
		const outsideAfter = this.outsideSnapshot();
		result.outsideChanged = [...new Set([...outsideBefore.keys(), ...outsideAfter.keys()])].filter((p) => outsideBefore.get(p) !== outsideAfter.get(p));
		if (result.outsideChanged.length > 0) {
			result.pass = false;
			errors.push(`Files outside “${FIXTURES}” changed: ${result.outsideChanged.join(", ")}`);
		}
		const { adapter } = this.app.vault;
		const all = (await adapter.exists(RESULTS)) ? JSON.parse(await adapter.read(RESULTS)) : {};
		all[name] = { at: new Date().toISOString(), ...result };
		await adapter.write(RESULTS, JSON.stringify(all, null, 2));
	}

	// ---- Checks ------------------------------------------------------------------------------

	/** Every dialog and branch, ending with Cancel: nothing may change. */
	async ui() {
		const r = (this.partial = {});
		await this.resetFixtures("ui");
		const before = this.paths();
		await this.openGraph();

		const { menu, titles } = await this.rightClickNode(this.parent);
		r.menuTitles = titles;
		r.shotMenu = await this.shot("1-graph-menu");
		await this.chooseMenuItem(menu, ITEM);
		r.picker = await this.waitForPicker();
		r.shotPicker = await this.shot("2-picker");

		await this.typeInPicker("bad:name");
		r.invalid = this.pickerState();
		this.pressEnter();
		await sleep(400);
		r.invalidStillOpen = this.pickerState() !== null;
		r.invalidNotices = this.notices();

		await this.typeInPicker("sub");
		r.search = this.pickerState();

		// A pre-filled/typed folder that exists asks first; "Back" returns to the picker with it.
		await this.typeInPicker(`${this.base}/Carbohydrates`);
		this.pressEnter();
		let exists = await this.waitForModal("Folder already exists");
		r.folderExists = { text: exists.querySelector("p")?.textContent, buttons: this.buttons(exists) };
		r.shotExists = await this.shot("3-folder-exists");
		this.clickButton(exists, "Back");
		r.afterBack = await this.waitForPicker();

		this.pressEnter();
		exists = await this.waitForModal("Folder already exists");
		this.clickButton(exists, "Create “Carbohydrates 1”");
		let confirm = await this.waitForConfirm();
		r.confirmNumbered = this.confirmState();
		this.clickButton(confirm, "Change folder…");
		r.afterChangeFolder = await this.waitForPicker();

		await this.typeInPicker(`${this.base}/Carbohydrates`);
		this.pressEnter();
		exists = await this.waitForModal("Folder already exists");
		this.clickButton(exists, "Use existing folder");
		confirm = await this.waitForConfirm();
		r.confirmExisting = this.confirmState();
		r.shotConfirmExisting = await this.shot("4-confirm-existing");

		confirm.querySelector(".gcm-row input").click(); // the parent row
		this.chooseClash(confirm, "rename");
		r.confirmAfterChoices = this.confirmState();
		r.shotConfirmChoices = await this.shot("5-confirm-choices");
		this.clickLink(confirm, "None");
		r.afterNone = this.confirmState();
		this.clickLink(confirm, "All");
		r.afterAll = this.confirmState();

		this.clickButton(confirm, "Change folder…");
		await this.waitForPicker();
		await this.typeInPicker(`${this.base}/New/Sugars`);
		r.pickerNew = this.pickerState();
		this.pressEnter();
		confirm = await this.waitForConfirm();
		r.confirmNew = this.confirmState();
		r.shotConfirmNew = await this.shot("6-confirm-new");

		// Levels: 1 is the flat list from before, All adds level 3; ticks survive switching.
		this.clickButton(confirm, "1");
		r.levelOne = this.confirmState();
		this.clickButton(confirm, "All");
		r.levelAll = this.confirmState();
		r.shotLevelAll = await this.shot("7-levels-all");
		this.clickButton(confirm, "2");
		this.rowCheckbox(confirm, `${this.base}/Glucose.md`).click();
		this.clickButton(confirm, "1");
		this.clickButton(confirm, "2");
		r.untickKept = this.confirmState();

		this.clickButton(confirm, "Cancel");
		await sleep(800);
		r.modalsLeft = document.querySelectorAll(".modal-container").length;
		r.newFolderCreated = this.app.vault.getAbstractFileByPath(`${this.base}/New`) !== null;
		r.unchanged = JSON.stringify(before) === JSON.stringify(this.paths());

		// A note with no outgoing links gets a notice instead of a picker.
		this.clearNotices();
		const lonely = await this.rightClickNode(`${this.base}/Glucose.md`);
		await this.chooseMenuItem(lonely.menu, ITEM);
		await sleep(400);
		r.lonelyNotices = this.notices();
		r.lonelyOpenedPicker = this.pickerState() !== null;

		// The item belongs to the graph menu only.
		document.body.querySelectorAll(".menu").forEach((m) => m.remove());
		const explorer = new Menu();
		this.app.workspace.trigger("file-menu", explorer, this.app.vault.getFileByPath(this.parent), "file-explorer-context-menu");
		explorer.showAtPosition({ x: 10, y: 10 });
		r.explorerTitles = this.menuTitles(document.body.querySelector(".menu"));
		explorer.hide();

		const rows = (state) => Object.fromEntries(state.rows.map((row) => [row.name, row]));
		const existing = rows(r.confirmExisting);
		const choices = rows(r.confirmAfterChoices);
		const one = rows(r.levelOne);
		const all = rows(r.levelAll);
		r.checks = {
			menuHasItem: r.menuTitles.includes(ITEM),
			pickerPrefilled: r.picker.input === `${this.base}/Carbohydrates` && r.picker.title.includes("Carbohydrates"),
			pickerListsFolders: r.picker.count > 1,
			invalidRefused: r.invalid.suggestions[0].startsWith("Can't use") && r.invalidStillOpen,
			searchFindsSub: r.search.suggestions.some((s) => s.includes(`${this.base}/Sub`)),
			existsAsks: ["Back", "Create “Carbohydrates 1”", "Use existing folder"].every((b) => r.folderExists.buttons.some((x) => x.text === b)),
			backKeepsName: r.afterBack.input === `${this.base}/Carbohydrates`,
			numberedIsNew: r.confirmNumbered.destination.includes("Carbohydrates 1") && r.confirmNumbered.destination.includes("new folder"),
			changeFolderPrefills: r.afterChangeFolder.input === `${this.base}/Carbohydrates 1`,
			startsAtTwoLevels: r.confirmExisting.levels === "2" && JSON.stringify(r.confirmExisting.levelHeaders) === JSON.stringify(["Children (5)", "Grandchildren (3)"]),
			parentUntickedByDefault: existing.Carbohydrates?.checked === false,
			notesTicked: ["Monosaccharides", "Disaccharides", "Polysaccharides", "Glucose", "Glycogen"].every((n) => existing[n]?.checked),
			grandchildrenSayVia: existing.Glucose?.info === "Via Monosaccharides" && existing.Glycogen?.info === "Via Polysaccharides",
			unsharedAttachmentTicked: existing["sugar diagram.png"]?.checked === true,
			sharedAttachmentUnticked: existing["Shared textbook.pdf"]?.checked === false,
			sharedGrandchildUnticked: existing.Starch?.checked === false && existing.Starch?.info.includes("outside this tree"),
			neverClimbs: !existing["Biological Molecules"] && !existing.Lipids && !existing["Other note"] && (r.confirmExisting.skipped ?? "").includes("Biological Molecules"),
			subfolderPerChild: existing.Monosaccharides?.dest === "→ Monosaccharides/" && existing.Glucose?.dest === "→ Monosaccharides/" && existing.Glycogen?.dest === "→ Polysaccharides/" && existing.Disaccharides?.dest === null,
			clashBlocksMove: existing.Disaccharides?.clash?.value === "" && r.confirmExisting.move.disabled && r.confirmExisting.move.text === "Move 5 files",
			choicesEnableMove: choices.Carbohydrates?.checked && choices.Disaccharides?.clash?.value === "rename" && !r.confirmAfterChoices.move.disabled && r.confirmAfterChoices.move.text === "Move 7 files",
			// "None"/"All" act on everything below the parent; the ticked parent stays.
			noneLeavesParent: r.afterNone.move.text === "Move 1 file" && !r.afterNone.move.disabled,
			allTicksEverything: r.afterAll.move.text === "Move 9 files",
			newFolderPlan:
				r.pickerNew.suggestions[0].startsWith(`Create folder “${this.base}/New/Sugars”`) &&
				r.confirmNew.destination.includes("new folder") &&
				r.confirmNew.move.text === "Move 6 files" &&
				r.confirmNew.summary.includes("with 2 new subfolders"),
			levelOneIsFlat: r.levelOne.move.text === "Move 4 files" && !one.Glucose && Object.values(one).every((row) => row.dest === null),
			levelAllAddsGranule:
				r.levelAll.move.text === "Move 7 files" && all["Glycogen granule"]?.checked && all["Glycogen granule"]?.dest === "→ Polysaccharides/Glycogen/" && all.Glycogen?.dest === "→ Polysaccharides/Glycogen/",
			untickSurvivesSwitch: rows(r.untickKept).Glucose?.checked === false && r.untickKept.levels === "2",
			dialogFitsWindow: [r.confirmExisting, r.confirmAfterChoices, r.confirmNew, r.levelOne, r.levelAll].every((s) => s.fits),
			cancelChangesNothing: r.unchanged && !r.newFolderCreated && r.modalsLeft === 0,
			lonelyNotice: r.lonelyNotices.some((n) => n.includes("doesn't link")) && !r.lonelyOpenedPicker,
			graphOnly: !r.explorerTitles.includes(ITEM),
		};
		r.pass = Object.values(r.checks).every(Boolean);
		return r;
	}

	/**
	 * Moves the default selection (two levels) into a new nested folder and checks every link still
	 * resolves. Runs with "Automatically update internal links" off (Obsidian's default), so Obsidian
	 * asks about links for each moved file; the harness answers "Just once".
	 */
	async moveNew() {
		const r = (this.partial = {});
		this.app.vault.setConfig("alwaysUpdateLinks", false);
		await this.resetFixtures("moveNew");
		const links = this.linkSnapshot();
		await this.openGraph();
		const { menu } = await this.rightClickNode(this.parent);
		await this.chooseMenuItem(menu, ITEM);
		await this.waitForPicker();
		await this.typeInPicker(`${this.base}/New/Sugars`);
		this.pressEnter();
		const confirm = await this.waitForConfirm();
		r.confirm = this.confirmState();
		this.clearNotices();
		this.clickButton(confirm, r.confirm.move.text);
		Object.assign(r, await this.waitForMoveDone());
		r.links = await this.linksAfterMove(links);
		r.files = this.files();
		r.parentText = await this.read(this.parent);
		r.otherText = await this.read(`${this.base}/Other note.md`);

		const dest = `${this.base}/New/Sugars`;
		const moved = [
			"Disaccharides.md",
			"sugar diagram.png",
			"Monosaccharides/Monosaccharides.md",
			"Monosaccharides/Glucose.md",
			"Polysaccharides/Polysaccharides.md",
			"Polysaccharides/Glycogen.md",
		].map((n) => `${dest}/${n}`);
		const stayed = [
			"Carbohydrates.md",
			"Biological Molecules.md",
			"Lipids.md",
			"Other note.md",
			"Shared textbook.pdf",
			"Starch.md",
			"Glycogen granule.md",
			"Carbohydrates/Disaccharides.md",
		].map((n) => `${this.base}/${n}`);
		r.checks = {
			childrenAndGrandchildrenMoved: moved.every((p) => r.files.includes(p)),
			othersStayed: stayed.every((p) => r.files.includes(p)),
			nothingElseInFolder: r.files.filter((p) => p.startsWith(`${dest}/`)).length === moved.length,
			linksIntact: r.links.problems.length === 0,
			notice: r.notice.startsWith("Moved 6 files"),
			warnsAboutPrompts: r.confirm.linkNote.startsWith("Obsidian will ask"),
		};
		r.pass = Object.values(r.checks).every(Boolean);
		return r;
	}

	/**
	 * Moves every level into the existing default folder with the parent ticked and the clash
	 * renamed, with "Automatically update internal links" on, as in the user's vault: no prompts.
	 */
	async moveExisting() {
		const r = (this.partial = {});
		this.app.vault.setConfig("alwaysUpdateLinks", true);
		await this.resetFixtures("moveExisting");
		const links = this.linkSnapshot();
		const olderText = await this.read(`${this.base}/Carbohydrates/Disaccharides.md`);
		await this.openGraph();
		const { menu } = await this.rightClickNode(this.parent);
		await this.chooseMenuItem(menu, ITEM);
		await this.waitForPicker();
		this.pressEnter();
		const exists = await this.waitForModal("Folder already exists");
		this.clickButton(exists, "Use existing folder");
		const confirm = await this.waitForConfirm();
		this.clickButton(confirm, "All");
		confirm.querySelector(".gcm-row input").click();
		this.chooseClash(confirm, "rename");
		r.confirm = this.confirmState();
		this.clearNotices();
		this.clickButton(confirm, r.confirm.move.text);
		Object.assign(r, await this.waitForMoveDone());
		r.links = await this.linksAfterMove(links);
		r.files = this.files();
		r.parentText = await this.read(`${this.base}/Carbohydrates/Carbohydrates.md`);
		r.otherText = await this.read(`${this.base}/Other note.md`);

		const dest = `${this.base}/Carbohydrates`;
		const expected = [
			"Carbohydrates.md",
			"Disaccharides.md",
			"Disaccharides 1.md",
			"sugar diagram.png",
			"Monosaccharides/Monosaccharides.md",
			"Monosaccharides/Glucose.md",
			"Polysaccharides/Polysaccharides.md",
			"Polysaccharides/Glycogen/Glycogen.md",
			"Polysaccharides/Glycogen/Glycogen granule.md",
		].map((n) => `${dest}/${n}`);
		r.checks = {
			everythingInPlace: expected.every((p) => r.files.includes(p)),
			nothingElseInFolder: r.files.filter((p) => p.startsWith(`${dest}/`)).length === expected.length,
			olderNoteUntouched: (await this.read(`${dest}/Disaccharides.md`)) === olderText,
			sharedStayed: [`${this.base}/Shared textbook.pdf`, `${this.base}/Starch.md`].every((p) => r.files.includes(p)),
			aboveStayed: [`${this.base}/Biological Molecules.md`, `${this.base}/Lipids.md`].every((p) => r.files.includes(p)),
			linksIntact: r.links.problems.length === 0,
			notice: r.notice.startsWith("Moved 8 files"),
			noPrompts: r.linkPrompts === 0,
			saysLinksUpdate: r.confirm.linkNote.startsWith("Links to the moved files are updated automatically"),
		};
		r.pass = Object.values(r.checks).every(Boolean);
		return r;
	}

	// ---- Fixtures and links ------------------------------------------------------------------

	/**
	 * Builds a fresh copy of the fixture in its own folder after removing the previous one. Paths are
	 * never reused: on Windows, deleting a folder and recreating the same files straight away lets
	 * late file-watcher events clobber the new copy, and two copies would make links ambiguous.
	 */
	async resetFixtures(name) {
		const { vault } = this.app;
		await this.removeFixtures();
		// Links in the fixture use plain names; a same-named file elsewhere would make them ambiguous.
		const names = new Set([...Object.keys(notesIn("")), ...Object.keys(BINARIES)].map((p) => p.slice(p.lastIndexOf("/") + 1).toLowerCase()));
		const clashes = vault
			.getFiles()
			.filter((f) => !f.path.startsWith(`${FIXTURES}/`) && names.has(f.name.toLowerCase().replace(/( \d+)+(\.[^.]+)$/, "$2")))
			.map((f) => f.path);
		if (clashes.length > 0) {
			throw new Error(`Files outside “${FIXTURES}” share names with the test notes, which makes links ambiguous: ${clashes.join(", ")}. Move them out of the vault first.`);
		}
		if (!vault.getFolderByPath(FIXTURES)) await vault.createFolder(FIXTURES);
		await vault.adapter.write(MARKER, "Made by gcm-dev-harness. Safe to delete.\n");
		this.base = `${FIXTURES}/${name} ${Date.now().toString(36)}`;
		this.parent = `${this.base}/Carbohydrates.md`;
		await vault.createFolder(this.base);
		await vault.createFolder(`${this.base}/Sub`);
		await vault.createFolder(`${this.base}/Carbohydrates`);
		for (const [file, text] of Object.entries(notesIn(this.base))) await vault.create(`${this.base}/${file}`, text);
		for (const [file, bytes] of Object.entries(BINARIES)) await vault.createBinary(`${this.base}/${file}`, bytes.buffer.slice(0));
		const resolved = (file) => Object.keys(this.app.metadataCache.resolvedLinks[`${this.base}/${file}`] ?? {}).length;
		await this.waitFor(
			() => resolved("Carbohydrates.md") >= 5 && resolved("Other note.md") >= 3 && resolved("Sub/Polysaccharides.md") >= 2 && resolved("Monosaccharides.md") >= 2 && resolved("Glycogen.md") >= 1,
			8000,
			"fixture links resolved",
		);
	}

	/** Deletes earlier fixture copies and waits until Obsidian, its link cache and the disk agree they're gone. */
	async removeFixtures() {
		const { vault } = this.app;
		const root = vault.getFolderByPath(FIXTURES);
		if (!root) return;
		// Only ever delete the folder this harness made.
		if (!(await vault.adapter.exists(MARKER))) throw new Error(`“${FIXTURES}” exists but wasn't made by the harness; not touching it.`);
		for (const child of [...root.children]) await vault.delete(child, true);
		const inside = (path) => path.startsWith(`${FIXTURES}/`);
		await this.waitFor(
			() => !vault.getAllLoadedFiles().some((f) => inside(f.path)) && !Object.keys(this.app.metadataCache.resolvedLinks).some(inside),
			8000,
			"old fixtures gone from Obsidian",
		);
		const end = Date.now() + 8000;
		for (;;) {
			const { files, folders } = await vault.adapter.list(FIXTURES);
			if (folders.length === 0 && files.every((f) => f === MARKER)) break;
			if (Date.now() > end) throw new Error("Timed out waiting for old fixtures to leave the disk");
			await sleep(200);
		}
		await sleep(1000); // let any late file-watcher events land before new files appear
	}

	/** Path → modified time for every file outside the fixture folder. */
	outsideSnapshot() {
		return new Map(
			this.app.vault
				.getFiles()
				.filter((f) => !f.path.startsWith(`${FIXTURES}/`))
				.map((f) => [f.path, f.stat.mtime]),
		);
	}

	/** Every file and folder in the fixture. */
	paths() {
		return this.app.vault
			.getAllLoadedFiles()
			.map((f) => f.path)
			.filter((p) => p.startsWith(`${this.base}/`))
			.sort();
	}

	files() {
		return this.app.vault
			.getFiles()
			.map((f) => f.path)
			.filter((p) => p.startsWith(`${this.base}/`))
			.sort();
	}

	read(path) {
		return this.app.vault.adapter.read(path);
	}

	/** Each fixture note's link targets as file objects, which keep their identity when moved. */
	linkSnapshot() {
		const { metadataCache, vault } = this.app;
		const snapshot = new Map();
		for (const file of vault.getMarkdownFiles().filter((f) => f.path.startsWith(`${this.base}/`))) {
			const targets = Object.keys(metadataCache.resolvedLinks[file.path] ?? {}).map((p) => vault.getAbstractFileByPath(p));
			snapshot.set(file, targets);
		}
		return snapshot;
	}

	async linksAfterMove(before) {
		const compare = () => {
			const after = this.linkSnapshot();
			const problems = [];
			const summary = {};
			for (const [file, targets] of before) {
				const now = after.get(file) ?? [];
				summary[file.path] = now.map((t) => t?.path);
				const missing = targets.filter((t) => !now.includes(t)).map((t) => t?.path);
				const unresolved = Object.keys(this.app.metadataCache.unresolvedLinks[file.path] ?? {});
				if (missing.length || unresolved.length || now.length !== targets.length) problems.push({ note: file.path, missing, unresolved });
			}
			return { problems, summary };
		};
		let result = compare();
		for (let i = 0; i < 20 && result.problems.length > 0; i++) {
			await sleep(250);
			result = compare();
		}
		return result;
	}

	// ---- Graph and menus ---------------------------------------------------------------------

	async openGraph() {
		this.closeGraph();
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({ type: "graph", active: true });
		this.graphLeaf = leaf;
		await this.waitFor(() => leaf.view?.renderer?.nodeLookup?.[this.parent], 10000, "graph node for the parent");
		await sleep(500);
	}

	closeGraph() {
		this.graphLeaf?.detach();
		this.graphLeaf = null;
	}

	/** Right-clicks a node through its own pointer handler, the path a real right-click takes. */
	async rightClickNode(path) {
		const view = this.graphLeaf.view;
		const node = await this.waitFor(() => view.renderer.nodeLookup[path], 10000, `graph node ${path}`);
		document.body.querySelectorAll(".menu").forEach((m) => m.remove());
		const rect = view.contentEl.getBoundingClientRect();
		const nativeEvent = new MouseEvent("contextmenu", { clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, button: 2, bubbles: true });
		node.onClick({ button: 2, nativeEvent });
		const menu = await this.waitFor(() => document.body.querySelector(".menu"), 3000, "context menu");
		await sleep(150);
		return { menu, titles: this.menuTitles(menu) };
	}

	menuTitles(menu) {
		return menu ? [...menu.querySelectorAll(".menu-item-title")].map((el) => el.textContent) : [];
	}

	async chooseMenuItem(menu, title) {
		const item = [...menu.querySelectorAll(".menu-item")].find((el) => el.querySelector(".menu-item-title")?.textContent === title);
		if (!item) throw new Error(`No menu item “${title}”`);
		item.click();
		await sleep(300);
	}

	// ---- Modals ------------------------------------------------------------------------------

	pickerEl() {
		return document.querySelector(".modal-container .gcm-picker");
	}

	pickerState() {
		const modal = this.pickerEl();
		if (!modal) return null;
		const items = [...modal.querySelectorAll(".suggestion-item")];
		const text = (el) => el.innerText.replace(/\s*\n+\s*/g, " | ").trim();
		return {
			title: modal.querySelector(".gcm-picker-title")?.textContent ?? "",
			input: modal.querySelector("input").value,
			placeholder: modal.querySelector("input").placeholder,
			selected: items.find((el) => el.classList.contains("is-selected")) ? text(items.find((el) => el.classList.contains("is-selected"))) : null,
			suggestions: items.slice(0, 8).map(text),
			count: items.length,
			instructions: modal.querySelector(".prompt-instructions")?.innerText.replace(/\n+/g, " ") ?? "",
		};
	}

	async waitForPicker() {
		await this.waitFor(() => this.pickerEl(), 3000, "folder picker");
		await sleep(250);
		return this.pickerState();
	}

	async typeInPicker(text) {
		const input = this.pickerEl().querySelector("input");
		input.value = text;
		input.dispatchEvent(new Event("input", { bubbles: true }));
		await sleep(250);
	}

	pressEnter() {
		const target = this.pickerEl()?.querySelector("input") ?? document.activeElement ?? document.body;
		target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, cancelable: true }));
	}

	modalTitled(title) {
		return [...document.querySelectorAll(".modal-container .modal")].find((m) => m.querySelector(".modal-title")?.textContent === title) ?? null;
	}

	async waitForModal(title) {
		const modal = await this.waitFor(() => this.modalTitled(title), 3000, `“${title}” dialog`);
		await sleep(200);
		return modal;
	}

	confirmEl() {
		return [...document.querySelectorAll(".modal-container .gcm-modal")].find((m) => m.querySelector(".modal-title")?.textContent.startsWith("Move child notes of")) ?? null;
	}

	async waitForConfirm() {
		const modal = await this.waitFor(() => this.confirmEl(), 3000, "confirmation dialog");
		await sleep(200);
		return modal;
	}

	confirmState() {
		const modal = this.confirmEl();
		if (!modal) return null;
		const buttons = this.buttons(modal);
		const move = buttons.find((b) => b.text.startsWith("Move")) ?? null;
		const skipped = modal.querySelector(".gcm-skipped");
		const moveEl = [...modal.querySelectorAll("button")].find((b) => b.textContent.startsWith("Move"));
		const moveRect = moveEl?.getBoundingClientRect();
		return {
			// The Move button is on screen without scrolling the dialog.
			fits: !!moveRect && moveRect.bottom <= window.innerHeight && moveRect.top >= 0 && modal.scrollHeight <= modal.clientHeight + 1,
			title: modal.querySelector(".modal-title").textContent,
			destination: modal.querySelector(".setting-item-description")?.innerText.replace(/\s*\n+\s*/g, " ") ?? "",
			levels: modal.querySelector(".gcm-levels button.is-active")?.textContent ?? null,
			sections: [...modal.querySelectorAll(".gcm-section-header")].map((h) => h.innerText.replace(/\s*\n+\s*/g, " ")),
			levelHeaders: [...modal.querySelectorAll(".gcm-level-header")].map((h) => h.textContent),
			levelEmpty: modal.querySelector(".gcm-level-empty")?.textContent ?? null,
			skipped: skipped?.isShown() ? skipped.textContent : null,
			rows: [...modal.querySelectorAll(".gcm-row")].map((row) => {
				const checkbox = row.querySelector("input");
				const clashEl = row.querySelector(".gcm-row-clash");
				const select = clashEl.querySelector("select");
				const destEl = row.querySelector(".gcm-row-dest");
				return {
					name: row.querySelector(".gcm-row-name").textContent,
					path: row.dataset.path,
					badge: row.querySelector(".gcm-row-main .gcm-badge")?.textContent ?? null,
					where: row.querySelector(".gcm-row-where").textContent,
					info: row.querySelector(".gcm-row-info")?.textContent ?? null,
					dest: destEl?.isShown() ? destEl.textContent : null,
					checked: checkbox.checked,
					disabled: checkbox.disabled,
					dimmed: row.classList.contains("is-unselected"),
					clash: clashEl.isShown()
						? { message: clashEl.querySelector(".gcm-clash-message")?.textContent, value: select?.value, options: [...(select?.options ?? [])].map((o) => o.text) }
						: null,
				};
			}),
			summary: modal.querySelector(".gcm-summary").textContent,
			summaryWarning: modal.querySelector(".gcm-summary").classList.contains("mod-warning"),
			linkNote: modal.querySelector(".gcm-link-note").textContent,
			move,
			buttons,
		};
	}

	buttons(modal) {
		return [...modal.querySelectorAll("button")].map((b) => ({
			text: b.textContent,
			disabled: b.disabled || b.classList.contains("mod-disabled") || b.classList.contains("is-disabled"),
			cta: b.classList.contains("mod-cta"),
		}));
	}

	clickButton(modal, text) {
		const button = [...modal.querySelectorAll("button")].find((b) => b.textContent === text);
		if (!button) throw new Error(`No button “${text}” (have: ${this.buttons(modal).map((b) => b.text).join(", ")})`);
		button.click();
	}

	clickLink(modal, text) {
		const link = [...modal.querySelectorAll("a")].find((a) => a.textContent === text);
		if (!link) throw new Error(`No link “${text}”`);
		link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
	}

	rowCheckbox(modal, path) {
		const checkbox = [...modal.querySelectorAll(".gcm-row")].find((row) => row.dataset.path === path)?.querySelector("input");
		if (!checkbox) throw new Error(`No row for “${path}”`);
		return checkbox;
	}

	chooseClash(modal, value) {
		const select = modal.querySelector(".gcm-row-clash select");
		if (!select) throw new Error("No clash dropdown");
		select.value = value;
		select.dispatchEvent(new Event("change"));
	}

	async closeModals() {
		for (let i = 0; i < 6 && document.querySelector(".modal-container"); i++) {
			const close = document.querySelector(".modal-container .modal-close-button");
			if (close) close.click();
			else document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
			await sleep(200);
		}
		document.body.querySelectorAll(".menu").forEach((m) => m.remove());
	}

	// ---- Notices, waiting, screenshots -------------------------------------------------------

	notices() {
		return [...document.querySelectorAll(".notice")].map((n) => n.textContent);
	}

	clearNotices() {
		document.querySelectorAll(".notice").forEach((n) => n.remove());
	}

	/** Waits for the plugin's "Moved …" notice, answering Obsidian's "Update links" prompts with "Just once". */
	async waitForMoveDone() {
		let linkPrompts = 0;
		const end = Date.now() + 20000;
		for (;;) {
			const notice = this.notices().find((n) => n.startsWith("Moved"));
			if (notice) return { notice, linkPrompts };
			const prompt = this.modalTitled("Update links");
			if (prompt) {
				linkPrompts++;
				this.clickButton(prompt, "Just once");
			}
			if (Date.now() > end) throw new Error(`Timed out waiting for the move to finish (${linkPrompts} link prompts answered)`);
			await sleep(150);
		}
	}

	async waitFor(get, timeout, what) {
		const end = Date.now() + timeout;
		for (;;) {
			const value = get();
			if (value) return value;
			if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
			await sleep(100);
		}
	}

	async shot(name) {
		try {
			await sleep(300);
			const image = await require("electron").remote.getCurrentWebContents().capturePage();
			const png = image.toPNG();
			const { adapter } = this.app.vault;
			if (!(await adapter.exists(SHOTS))) await adapter.mkdir(SHOTS);
			await adapter.writeBinary(`${SHOTS}/${name}.png`, png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength));
			return `${SHOTS}/${name}.png`;
		} catch (error) {
			return `screenshot failed: ${error?.message ?? error}`;
		}
	}
};
