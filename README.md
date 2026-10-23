# Branch Mover

Right-click a note in Obsidian's Graph View and move its branch (the notes it links to, and optionally theirs) into a folder. Every link keeps working.

Handy when a topic has grown in the vault root: pick the topic note in the graph, and its notes are filed in one step.

[![Support me on Ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/mdsama)

## How to use

1. Open **Graph View** (or the local graph) and right-click a note: **Move child notes to folder**.
2. Choose a folder. The picker is pre-filled with a new folder named after the note, next to it. Press Enter to use it, search your existing folders, or type a path such as `Biology/Carbohydrates`; missing folders are created.
3. Check the list and click **Move**. Nothing is moved, and no folder is created, until you do.

The same dialog is available from the command palette: **Move child notes of the current note to a folder**.

Branch Mover has nothing to configure. Its page in Settings only holds a **Support me on Ko-fi** button.

## What moves

**Children** are the notes and files the parent links to or embeds. Notes that link *to* the parent are its parents, so they stay where they are.

**Levels** (1 · 2 · All, starting at 2) choose how far down the branch to go: 1 is the children only, 2 adds their children, All takes everything below. Each file is listed once, under the first note it's reached from.

**Layout:** a note with ticked notes below it gets its own subfolder and moves into it with them. For `Carbohydrates` at level 2:

```
Carbohydrates/
  A. Monosaccharides (Simple Sugars)/
    A. Monosaccharides (Simple Sugars).md
    isomers.md
  B. Disaccharides (Two Sugars)/
    B. Disaccharides (Two Sugars).md
    Dehydration synthesis.md
    Hydrolysis.md
  C. Polysaccharides (Many Sugars)/
    C. Polysaccharides (Many Sugars).md
    Cellulose.md
    Chitin.md
    Glycogen.md
    Starch.md
```

With level 1, or with nothing ticked below a note, everything lands flat in the chosen folder. Each row shows where it will go (`→ C. Polysaccharides (Many Sugars)/`).

**What starts unticked**, so you decide:

| | |
| --- | --- |
| **The parent note** | It stays where it is unless you tick it; then it moves into the chosen folder. |
| **Shared attachments** | A PDF or image that notes outside the branch also link to, such as a textbook many notes cite. |
| **Shared notes below the children** | A grandchild (or deeper) that notes outside the branch also link to. |

**It never climbs.** The parent's own parents, and anything above them, are never included, even when a note in the branch links back up to them. The dialog names anything it left out for that reason.

## Name clashes

If a file with the same name is already where a note would go, the dialog asks what to do for that file: **Skip** it, or **Keep both** (it moves as `Glucose 1.md`). Move stays disabled until every clash has an answer. Nothing is ever overwritten.

If the folder you typed already exists, you're asked whether to use it or create a numbered one (`Carbohydrates 1`).

## Links

Files are moved with Obsidian's own rename, so links to them are updated the same way as when you move a file yourself. That follows **Settings → Files and links → Automatically update internal links**. When it's off, Obsidian asks about each moved file, and the dialog says so before you start.

## Installation

**From Obsidian:** Settings → Community plugins → Browse, search for **Branch Mover**, install, and enable it.

**Manually:** download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/jokeroct/branch-mover/releases/latest) into `<your vault>/.obsidian/plugins/branch-mover/`, then enable **Branch Mover** under Settings → Community plugins.

## Known limitations

- The menu item is on graph nodes (Graph View and the local graph). In the file explorer, use the command instead.
- A note below the parent that links *up* to the parent, or to a note above it, counts as above the parent and isn't included. It's named in the dialog. A child that links back to its parent is still a child.
- Not tested on mobile yet.

## Development

```bash
npm install
npm run dev        # rebuild main.js on every change
npm test           # unit tests
npm run build      # type-check and build for release
npm run install-plugin -- "path/to/vault"
```

`npm run dev-test -- "path/to/dev-vault"` runs the in-Obsidian checks: it installs the plugin and a test harness (`dev/harness`) into a vault that already allows community plugins, opens it, drives the graph menu and dialogs, moves test notes inside a `Child mover test` folder, and prints the results. Use a throwaway vault.

To release, run `npm version patch` (or `minor` / `major`) and push the tag (`git push --follow-tags`). The release workflow builds the plugin and drafts a GitHub release with the three files; review it and publish.

## License

[MIT](LICENSE)
