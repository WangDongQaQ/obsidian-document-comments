import { App, PluginSettingTab, Setting } from "obsidian";
import type DocCommentsPlugin from "./main";

export type DocCommentsSettings = {
	/** Author handle attached to comments you create. Empty falls back to "me". */
	author: string;
	/** Master toggle for the margin column. */
	showComments: boolean;
	/** Keep the synced right sidebar open. */
	showSidebar: boolean;
	/** Show resolved comments in the margin. */
	showResolved: boolean;
};

export const DEFAULT_SETTINGS: DocCommentsSettings = {
	author: "",
	showComments: true,
	showSidebar: true,
	showResolved: false,
};

export class DocCommentsSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private plugin: DocCommentsPlugin,
	) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Author")
			.setDesc("Name attached to comments you create. Defaults to “me”.")
			.addText((text) =>
				text
					.setPlaceholder("Me")
					.setValue(this.plugin.settings.author)
					.onChange(async (value) => {
						this.plugin.settings.author = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Show comments")
			.setDesc("Show comment highlights and inline sticky notes.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showComments).onChange(async (value) => {
					this.plugin.settings.showComments = value;
					await this.plugin.saveSettings();
					this.plugin.refreshEditors();
				}),
			);

		new Setting(containerEl)
			.setName("Show comments sidebar")
			.setDesc("Open the synced comment rail in the right sidebar.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showSidebar).onChange(async (value) => {
					await this.plugin.setSidebarVisible(value);
				}),
			);

		new Setting(containerEl)
			.setName("Show resolved comments")
			.setDesc("Keep resolved comments visible in the margin.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showResolved).onChange(async (value) => {
					this.plugin.settings.showResolved = value;
					await this.plugin.saveSettings();
					this.plugin.refreshEditors();
				}),
			);
	}
}
