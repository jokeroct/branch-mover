import { type App, type Plugin, PluginSettingTab, type SettingDefinitionItem, setIcon } from "obsidian";

/** The author's Ko-fi page, also the manifest's fundingUrl. */
const KOFI_URL = "https://ko-fi.com/mdsama";

/** Branch Mover has nothing to configure, so its tab only offers a way to support it. */
export class BranchMoverSettingTab extends PluginSettingTab {
	constructor(app: App, plugin: Plugin) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				type: "group",
				heading: "Support",
				items: [
					{
						name: "Support Branch Mover",
						desc: "If Branch Mover helps you, you can support its development on Ko-fi.",
						render: (setting) => {
							setting.addButton((button) => {
								button.setButtonText("Support me on Ko-fi").onClick(() => window.open(KOFI_URL));
								// A button holds an icon or text, not both, so the icon goes in beside the text.
								button.buttonEl.addClass("gcm-kofi-button");
								setIcon(button.buttonEl.createSpan({ cls: "gcm-kofi-icon", prepend: true }), "coffee");
							});
						},
					},
				],
			},
		];
	}
}
