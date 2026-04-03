/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ethan Krich. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import "./media/projectCanvas.css";
import {
	$,
	addDisposableListener,
	append,
	clearNode,
	Dimension,
	EventHelper,
	EventType,
	getWindow,
	size,
} from "../../../../base/browser/dom.js";
import { StandardKeyboardEvent } from "../../../../base/browser/keyboardEvent.js";
import { StandardMouseEvent } from "../../../../base/browser/mouseEvent.js";
import { renderIcon } from "../../../../base/browser/ui/iconLabel/iconLabels.js";
import { DomScrollableElement } from "../../../../base/browser/ui/scrollbar/scrollableElement.js";
import { Action } from "../../../../base/common/actions.js";
import { CancellationToken } from "../../../../base/common/cancellation.js";
import { Codicon } from "../../../../base/common/codicons.js";
import { KeyCode } from "../../../../base/common/keyCodes.js";
import { DisposableStore } from "../../../../base/common/lifecycle.js";
import { ScrollbarVisibility } from "../../../../base/common/scrollable.js";
import { ThemeIcon } from "../../../../base/common/themables.js";
import { localize } from "../../../../nls.js";
import { ICommandService } from "../../../../platform/commands/common/commands.js";
import { IContextMenuService } from "../../../../platform/contextview/browser/contextView.js";
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { IThemeService } from "../../../../platform/theme/common/themeService.js";
import { ITelemetryService } from "../../../../platform/telemetry/common/telemetry.js";
import { IStorageService } from "../../../../platform/storage/common/storage.js";
import { IHostService } from "../../../services/host/browser/host.js";
import { EditorPane } from "../../../browser/parts/editor/editorPane.js";
import {
	IEditorOpenContext,
	IEditorSerializer,
} from "../../../common/editor.js";
import { IEditorGroup } from "../../../services/editor/common/editorGroupsService.js";
import {
	IProjectCanvasProject,
	IProjectCanvasService,
	ProjectCanvasCommandIds,
} from "./projectCanvasService.js";
import {
	ProjectCanvasEditorOptions,
	ProjectCanvasInput,
} from "./projectCanvasInput.js";

export class ProjectCanvasPage extends EditorPane {
	static readonly ID = "projectCanvasPage";

	private rootElement!: HTMLElement;
	private openFolderButton!: HTMLButtonElement;
	private projectsElement!: HTMLElement;
	private projectsScrollableElement!: DomScrollableElement;
	private emptyStateElement!: HTMLElement;
	private readonly renderDisposables = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ICommandService private readonly commandService: ICommandService,
		@IContextMenuService
		private readonly contextMenuService: IContextMenuService,
		@IProjectCanvasService
		private readonly projectCanvasService: IProjectCanvasService,
		@IHostService private readonly hostService: IHostService,
	) {
		super(
			ProjectCanvasPage.ID,
			group,
			telemetryService,
			themeService,
			storageService,
		);

		this._register(
			this.projectCanvasService.onDidChangeProjects(() =>
				this.renderProjects(),
			),
		);
	}

	protected createEditor(parent: HTMLElement): void {
		this.rootElement = append(
			parent,
			$(".project-canvas-editor", {
				tabIndex: "0",
				role: "document",
				"aria-label": localize("projectCanvasAriaLabel", "Project canvas"),
			}),
		);

		const contentElement = append(
			this.rootElement,
			$(".project-canvas-content"),
		);
		const headerElement = append(contentElement, $(".project-canvas-header"));
		append(
			headerElement,
			$(
				"h2.project-canvas-title",
				undefined,
				localize("projectCanvasTitle", "Projects"),
			),
		);

		this.projectsElement = $(".project-canvas-projects");
		this.projectsScrollableElement = this._register(
			new DomScrollableElement(this.projectsElement, {
				className: "project-canvas-projects-scrollable",
				horizontal: ScrollbarVisibility.Hidden,
				vertical: ScrollbarVisibility.Auto,
			}),
		);
		append(
			contentElement,
			this.projectsScrollableElement.getDomNode(),
		);

		const footerElement = append(contentElement, $(".project-canvas-footer"));
		this.openFolderButton = append(
			footerElement,
			$("button.project-canvas-open-folder", {
				type: "button",
			}),
		) as HTMLButtonElement;
		this.openFolderButton.appendChild(renderIcon(Codicon.folderOpened));
		append(this.openFolderButton, $("span", undefined, localize("openFolder", "Open Folder")));

		this._register(
			addDisposableListener(this.openFolderButton, EventType.CLICK, (event) => {
				EventHelper.stop(event, true);
				this.commandService.executeCommand(ProjectCanvasCommandIds.AddProject);
			}),
		);

		this.emptyStateElement = append(
			this.projectsElement,
			$(
				".project-canvas-empty",
				undefined,
				localize(
					"projectCanvasEmpty",
					"Open a project to add it to your canvas.",
				),
			),
		);
	}

	override async setInput(
		input: ProjectCanvasInput,
		options: ProjectCanvasEditorOptions | undefined,
		context: IEditorOpenContext,
		token: CancellationToken,
	): Promise<void> {
		await super.setInput(input, options, context, token);
		this.renderProjects();
	}

	override clearInput(): void {
		this.renderDisposables.clear();
		clearNode(this.projectsElement);
		this.projectsElement.appendChild(this.emptyStateElement);
		super.clearInput();
	}

	override layout(dimension: Dimension): void {
		size(this.rootElement, dimension.width, dimension.height);
		this.projectsScrollableElement.scanDomNode();
	}

	override focus(): void {
		super.focus();
		this.getPrimaryFocusableElement()?.focus();
	}

	override dispose(): void {
		this.rootElement?.remove();
		super.dispose();
	}

	private renderProjects(): void {
		if (!this.projectsElement) {
			return;
		}

		const projects = this.projectCanvasService.getProjects();

		this.renderDisposables.clear();
		clearNode(this.projectsElement);

		if (projects.length === 0) {
			this.projectsElement.appendChild(this.emptyStateElement);
			this.projectsScrollableElement.scanDomNode();
			return;
		}

		for (const project of projects) {
			this.projectsElement.appendChild(this.renderProjectTile(project));
		}

		this.projectsScrollableElement.scanDomNode();
	}

	private getPrimaryFocusableElement(): HTMLElement | undefined {
		return this.projectsElement?.querySelector<HTMLElement>('.project-canvas-project') ?? this.openFolderButton;
	}

	private renderProjectTile(project: IProjectCanvasProject): HTMLElement {
		const tile = $(".project-canvas-project", {
			tabIndex: "0",
			role: "button",
			"aria-label": localize(
				"projectTileAriaLabel",
				"Open project {0}",
				project.label,
			),
		});

		const icon = append(tile, $(".project-canvas-project-icon"));
		icon.appendChild(renderIcon(Codicon.folder));

		append(
			tile,
			$("span.project-canvas-project-label", undefined, project.label),
		);

		this.renderDisposables.add(
			addDisposableListener(tile, EventType.CLICK, (event) => {
				EventHelper.stop(event, true);
				this.openProject(project);
			}),
		);

		this.renderDisposables.add(
			addDisposableListener(tile, EventType.KEY_DOWN, (event) => {
				const keyboardEvent = new StandardKeyboardEvent(event);
				if (
					keyboardEvent.equals(KeyCode.Enter) ||
					keyboardEvent.equals(KeyCode.Space)
				) {
					EventHelper.stop(event, true);
					this.openProject(project);
				}
			}),
		);

		this.renderDisposables.add(
			addDisposableListener(tile, EventType.CONTEXT_MENU, (event) => {
				EventHelper.stop(event, true);
				const anchor = new StandardMouseEvent(getWindow(tile), event);
				const disposables = new DisposableStore();
				const removeAction = disposables.add(
					new Action(
						ProjectCanvasCommandIds.RemoveProject,
						localize("removeProjectFromCanvas", "Remove from Canvas"),
						ThemeIcon.asClassName(Codicon.close),
						true,
						async () =>
							this.commandService.executeCommand(
								ProjectCanvasCommandIds.RemoveProject,
								project.resource,
							),
					),
				);

				this.contextMenuService.showContextMenu({
					getAnchor: () => anchor,
					getActions: () => [removeAction],
					onHide: () => disposables.dispose(),
				});
			}),
		);

		return tile;
	}

	private async openProject(project: IProjectCanvasProject): Promise<void> {
		if (project.kind === "folder") {
			await this.hostService.openWindow([{ folderUri: project.resource }], {
				forceReuseWindow: true,
			});
			return;
		}

		await this.hostService.openWindow([{ workspaceUri: project.resource }], {
			forceReuseWindow: true,
		});
	}
}

export class ProjectCanvasInputSerializer implements IEditorSerializer {
	canSerialize(_editorInput: ProjectCanvasInput): boolean {
		return true;
	}

	serialize(_editorInput: ProjectCanvasInput): string {
		return JSON.stringify({});
	}

	deserialize(
		_instantiationService: IInstantiationService,
		_serializedEditorInput: string,
	): ProjectCanvasInput {
		return new ProjectCanvasInput({});
	}
}
