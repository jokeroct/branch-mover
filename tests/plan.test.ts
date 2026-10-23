import { describe, expect, it } from "vitest";
import {
	ROOT,
	backlinkIndex,
	canonicalFolder,
	checkFolderPath,
	descendantTree,
	directChildren,
	layoutFolders,
	newSubfolders,
	numberedFolder,
	outsideLinkers,
	planMoves,
	relativeFolder,
	siblingFolder,
	splitName,
	targetOf,
} from "../src/plan";

const lower = (paths: string[]) => new Set(paths.map((path) => path.toLowerCase()));

describe("directChildren", () => {
	const links = {
		"Bio/Carbohydrates.md": { "Bio/B. Disaccharides.md": 1, "Bio/A. Monosaccharides.md": 2, "Bio/Carbohydrates.md": 1, "img.png": 1 },
		"Bio/A. Monosaccharides.md": { "Bio/Glucose.md": 1 },
		"Biological Molecules.md": { "Bio/Carbohydrates.md": 1 },
	};

	it("returns only the files the parent links to, sorted by name", () => {
		expect(directChildren(links, "Bio/Carbohydrates.md")).toEqual(["Bio/A. Monosaccharides.md", "Bio/B. Disaccharides.md", "img.png"]);
	});

	it("leaves out backlinks, grandchildren and self-links", () => {
		const children = directChildren(links, "Bio/Carbohydrates.md");
		expect(children).not.toContain("Biological Molecules.md");
		expect(children).not.toContain("Bio/Glucose.md");
		expect(children).not.toContain("Bio/Carbohydrates.md");
	});

	it("is empty for a note without links", () => {
		expect(directChildren(links, "Bio/Glucose.md")).toEqual([]);
	});
});

describe("descendantTree", () => {
	// Biological Molecules → Carbohydrates → Mono/Di/Poly → Glucose/Glycogen/Starch → Granule.
	// Mono links up to Biological Molecules (which also leads to Lipids), and Di links back to the root.
	const links = {
		"Biological Molecules.md": { "Carbohydrates.md": 1, "Lipids.md": 1 },
		"Carbohydrates.md": { "Mono.md": 1, "Di.md": 1, "Poly.md": 1, "book.pdf": 1 },
		"Mono.md": { "Glucose.md": 1, "Biological Molecules.md": 1 },
		"Di.md": { "Carbohydrates.md": 1, "Glucose.md": 1 },
		"Poly.md": { "Glycogen.md": 1, "Starch.md": 1, "book.pdf": 1 },
		"Glycogen.md": { "Granule.md": 1 },
		"Lipids.md": { "Fats.md": 1 },
		"Other.md": { "Starch.md": 1, "book.pdf": 1 },
	};
	const paths = (depth: number) => descendantTree(links, "Carbohydrates.md", depth).nodes.map((n) => `${n.depth}:${n.path}<${n.via}`);

	it("stops at the chosen depth", () => {
		expect(paths(1)).toEqual(["1:book.pdf<Carbohydrates.md", "1:Di.md<Carbohydrates.md", "1:Mono.md<Carbohydrates.md", "1:Poly.md<Carbohydrates.md"]);
		expect(paths(2)).toEqual([
			...paths(1),
			"2:Glucose.md<Di.md",
			"2:Glycogen.md<Poly.md",
			"2:Starch.md<Poly.md",
		]);
		expect(paths(Infinity)).toEqual([...paths(2), "3:Granule.md<Glycogen.md"]);
	});

	it("lists a file once, at the first level and first parent it's reached from", () => {
		const glucose = descendantTree(links, "Carbohydrates.md", 2).nodes.filter((n) => n.path === "Glucose.md");
		expect(glucose).toEqual([{ path: "Glucose.md", depth: 2, via: "Di.md" }]);
		// book.pdf is linked from the root and from Poly: it stays a child.
		expect(descendantTree(links, "Carbohydrates.md", 2).nodes.filter((n) => n.path === "book.pdf")).toHaveLength(1);
	});

	it("never climbs above the parent, and says what it skipped", () => {
		const tree = descendantTree(links, "Carbohydrates.md", Infinity);
		const reached = tree.nodes.map((n) => n.path);
		expect(reached).not.toContain("Biological Molecules.md");
		expect(reached).not.toContain("Lipids.md");
		expect(reached).not.toContain("Fats.md");
		expect(reached).not.toContain("Carbohydrates.md");
		expect(tree.skipped).toEqual(["Biological Molecules.md"]);
	});

	it("keeps a child that links back to the parent", () => {
		expect(descendantTree(links, "Carbohydrates.md", 1).nodes.map((n) => n.path)).toContain("Di.md");
	});

	it("counts links from outside the tree", () => {
		const backlinks = backlinkIndex(links);
		const inside = new Set(["Carbohydrates.md", ...descendantTree(links, "Carbohydrates.md", 2).nodes.map((n) => n.path)]);
		expect(outsideLinkers(backlinks, "Starch.md", inside)).toBe(1); // Other
		expect(outsideLinkers(backlinks, "Glycogen.md", inside)).toBe(0);
		expect(outsideLinkers(backlinks, "book.pdf", inside)).toBe(1);
	});
});

describe("layoutFolders", () => {
	const nodes = [
		{ path: "Mono.md", depth: 1, via: "Carbs.md" },
		{ path: "Poly.md", depth: 1, via: "Carbs.md" },
		{ path: "pic.png", depth: 1, via: "Carbs.md" },
		{ path: "Glucose.md", depth: 2, via: "Mono.md" },
		{ path: "Glycogen.md", depth: 2, via: "Poly.md" },
		{ path: "Granule.md", depth: 3, via: "Glycogen.md" },
	];
	const all = new Set(nodes.map((n) => n.path));

	it("gives every note with ticked files below it a subfolder, nested like the tree", () => {
		const folders = layoutFolders(nodes, "Carbs.md", all, "Dest");
		expect(Object.fromEntries(folders)).toEqual({
			"Carbs.md": "Dest",
			"Mono.md": "Dest/Mono",
			"Poly.md": "Dest/Poly",
			"pic.png": "Dest",
			"Glucose.md": "Dest/Mono",
			"Glycogen.md": "Dest/Poly/Glycogen",
			"Granule.md": "Dest/Poly/Glycogen",
		});
	});

	it("keeps a note flat when nothing below it is ticked", () => {
		const folders = layoutFolders(nodes, "Carbs.md", new Set(["Mono.md", "Poly.md", "Glycogen.md"]), "Dest");
		expect(folders.get("Mono.md")).toBe("Dest");
		expect(folders.get("Glycogen.md")).toBe("Dest/Poly");
	});

	it("still nests ticked grandchildren under an unticked child", () => {
		const folders = layoutFolders(nodes, "Carbs.md", new Set(["Granule.md"]), "Dest");
		expect(folders.get("Granule.md")).toBe("Dest/Poly/Glycogen");
	});

	it("works at the vault root", () => {
		expect(layoutFolders(nodes, "Carbs.md", all, ROOT).get("Glucose.md")).toBe("Mono");
	});

	it("names subfolders after the note, cleaned", () => {
		const odd = [{ path: "What is #DNA?.md", depth: 1, via: "R.md" }, { path: "x.md", depth: 2, via: "What is #DNA?.md" }];
		expect(layoutFolders(odd, "R.md", new Set(["x.md"]), "D").get("x.md")).toBe("D/What is DNA");
	});
});

describe("subfolders", () => {
	it("gives folders relative to the destination", () => {
		expect(relativeFolder("Carbs/Poly/Glycogen", "Carbs")).toBe("Poly/Glycogen");
		expect(relativeFolder("Carbs", "Carbs")).toBeNull();
		expect(relativeFolder("Other", "Carbs")).toBeNull();
		expect(relativeFolder("Poly", ROOT)).toBe("Poly");
	});

	it("lists the subfolders that need creating, once each", () => {
		const targets = ["Carbs/Poly/Glycogen/Granule.md", "Carbs/Poly/Poly.md", "Carbs/Mono/Mono.md", "Carbs/pic.png"];
		expect(newSubfolders(targets, "Carbs", lower(["Carbs", "Carbs/Mono"])).sort()).toEqual(["carbs/poly", "carbs/poly/glycogen"]);
	});
});

describe("folder names", () => {
	it("places the default folder next to the parent", () => {
		expect(siblingFolder("Carbohydrates.md")).toBe("Carbohydrates");
		expect(siblingFolder("Bio/Macro/Carbohydrates.md")).toBe("Bio/Macro/Carbohydrates");
		expect(siblingFolder("A. Monosaccharides (Simple Sugars).md")).toBe("A. Monosaccharides (Simple Sugars)");
	});

	it("cleans characters folders can't have", () => {
		expect(siblingFolder("What is #DNA?.md")).toBe("What is DNA");
		expect(siblingFolder("....md")).toBe("Untitled");
	});

	it("accepts nested and backslash paths", () => {
		expect(checkFolderPath(" Biology\\Carbohydrates/ ")).toEqual({ ok: true, path: "Biology/Carbohydrates" });
		expect(checkFolderPath("/")).toEqual({ ok: true, path: ROOT });
	});

	it("rejects names Obsidian or Windows can't use", () => {
		for (const bad of ["", "a:b", "notes?", ".hidden", "dots.", "a/../b", "CON", "x[1]"]) {
			expect(checkFolderPath(bad).ok, bad).toBe(false);
		}
	});

	it("reuses the spelling of existing folders", () => {
		expect(canonicalFolder("biology/new", ["/", "Biology"])).toBe("Biology/new");
		expect(canonicalFolder("Other", ["/", "Biology"])).toBe("Other");
	});

	it("numbers a folder whose name is taken", () => {
		expect(numberedFolder("Bio/Carbohydrates", lower(["Bio/Carbohydrates", "Bio/Carbohydrates 1"]))).toBe("Bio/Carbohydrates 2");
	});

	it("splits extensions only at the last dot", () => {
		expect(splitName("A. Monosaccharides (Simple Sugars).md")).toEqual({ stem: "A. Monosaccharides (Simple Sugars)", ext: ".md" });
	});
});

describe("planMoves", () => {
	const dest = "Carbohydrates";

	it("moves selected files and leaves the rest", () => {
		const statuses = planMoves(
			[
				{ path: "Glucose.md", folder: dest, selected: true },
				{ path: "Starch.md", folder: dest, selected: false },
				{ path: "Carbohydrates/Chitin.md", folder: dest, selected: true },
				{ path: "Carbohydrates/Poly.md", folder: "Carbohydrates/Poly", selected: true },
			],
			lower(["Glucose.md", "Starch.md", "Carbohydrates/Chitin.md", "Carbohydrates/Poly.md"]),
		);
		expect(statuses).toEqual([
			{ kind: "move", target: "Carbohydrates/Glucose.md" },
			{ kind: "unselected" },
			{ kind: "here" },
			{ kind: "move", target: "Carbohydrates/Poly/Poly.md" },
		]);
	});

	it("flags a taken name until the user decides, ignoring case", () => {
		const taken = lower(["Glucose.md", "carbohydrates/glucose.md"]);
		const [undecided] = planMoves([{ path: "Glucose.md", folder: dest, selected: true }], taken);
		expect(undecided).toEqual({ kind: "taken", choice: undefined, renameTarget: "Carbohydrates/Glucose 1.md" });
		expect(targetOf(undecided)).toBeNull();

		const [skipped] = planMoves([{ path: "Glucose.md", folder: dest, selected: true, choice: "skip" }], taken);
		expect(targetOf(skipped)).toBeNull();

		const [renamed] = planMoves([{ path: "Glucose.md", folder: dest, selected: true, choice: "rename" }], taken);
		expect(targetOf(renamed)).toBe("Carbohydrates/Glucose 1.md");
	});

	it("stops two files with the same name from claiming the same path", () => {
		const statuses = planMoves(
			[
				{ path: "a/Notes.md", folder: dest, selected: true },
				{ path: "b/Notes.md", folder: dest, selected: true, choice: "rename" },
				{ path: "c/Notes.md", folder: dest, selected: true, choice: "rename" },
			],
			lower(["a/Notes.md", "b/Notes.md", "c/Notes.md"]),
		);
		expect(statuses.map(targetOf)).toEqual(["Carbohydrates/Notes.md", "Carbohydrates/Notes 1.md", "Carbohydrates/Notes 2.md"]);
	});

	it("allows the same name in different subfolders", () => {
		const statuses = planMoves(
			[
				{ path: "a/Notes.md", folder: "Carbohydrates/Mono", selected: true },
				{ path: "b/Notes.md", folder: "Carbohydrates/Poly", selected: true },
			],
			lower(["a/Notes.md", "b/Notes.md"]),
		);
		expect(statuses.map(targetOf)).toEqual(["Carbohydrates/Mono/Notes.md", "Carbohydrates/Poly/Notes.md"]);
	});

	it("moves into the vault root", () => {
		expect(planMoves([{ path: "Bio/Glucose.md", folder: ROOT, selected: true }], lower(["Bio/Glucose.md"]))).toEqual([
			{ kind: "move", target: "Glucose.md" },
		]);
		expect(planMoves([{ path: "Glucose.md", folder: ROOT, selected: true }], lower(["Glucose.md"]))).toEqual([{ kind: "here" }]);
	});
});
