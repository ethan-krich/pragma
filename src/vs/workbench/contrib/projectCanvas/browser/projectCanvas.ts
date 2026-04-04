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
import { Emitter, Event } from "../../../../base/common/event.js";
import { KeyCode } from "../../../../base/common/keyCodes.js";
import { Disposable, DisposableStore } from "../../../../base/common/lifecycle.js";
import { ScrollbarVisibility } from "../../../../base/common/scrollable.js";
import { ThemeIcon } from "../../../../base/common/themables.js";
import { localize } from "../../../../nls.js";
import { ICommandService } from "../../../../platform/commands/common/commands.js";
import { IContextMenuService } from "../../../../platform/contextview/browser/contextView.js";
import { IInstantiationService } from "../../../../platform/instantiation/common/instantiation.js";
import { INotificationService } from "../../../../platform/notification/common/notification.js";
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
import { IWorktreeManagerService } from "../../worktreeManager/browser/worktreeManagerService.js";
import { IWorktreeBranchEntry, WorktreeManagerError, WorktreeManagerErrorCode } from "../../worktreeManager/browser/worktreeManagerTypes.js";
import {
	ProjectCanvasEditorOptions,
	ProjectCanvasInput,
} from "./projectCanvasInput.js";

export type ProjectCanvasViewState =
	| { readonly kind: 'projects' }
	| {
		readonly kind: 'branches';
		readonly project: IProjectCanvasProject;
		readonly branches: readonly IWorktreeBranchEntry[];
		readonly loading: boolean;
	};

export class ProjectCanvasPageModel extends Disposable {

	private readonly _onDidChangeState = this._register(new Emitter<ProjectCanvasViewState>());
	readonly onDidChangeState: Event<ProjectCanvasViewState> = this._onDidChangeState.event;

	private _state: ProjectCanvasViewState = { kind: 'projects' };
	get state(): ProjectCanvasViewState {
		return this._state;
	}

	constructor(
		private readonly hostService: IHostService,
		private readonly notificationService: INotificationService,
		private readonly worktreeManagerService: IWorktreeManagerService,
	) {
		super();
	}

	async showProjects(): Promise<void> {
		this.setState({ kind: 'projects' });
	}

	async activateProject(project: IProjectCanvasProject): Promise<void> {
		if (project.kind !== 'folder') {
			await this.openProject(project);
			return;
		}

		this.setState({ kind: 'branches', project, branches: [], loading: true });

		try {
			const branches = await this.worktreeManagerService.getGoodBranches(project.resource);
			if (branches.length === 0) {
				this.setState({ kind: 'projects' });
				await this.openProject(project);
				return;
			}

			this.setState({ kind: 'branches', project, branches, loading: false });
		} catch (error) {
			this.setState({ kind: 'projects' });
			this.notificationService.error(error instanceof Error ? error.message : localize('projectCanvas.branchLoadFailed', "Failed to load branches for this project."));
		}
	}

	async activateBranch(branch: IWorktreeBranchEntry): Promise<void> {
		if (this._state.kind !== 'branches') {
			return;
		}

		try {
			const worktreePath = await this.worktreeManagerService.resolveOrCreateWorktree(this._state.project.resource, branch.branchName);
			await this.hostService.openWindow([{ folderUri: worktreePath }], {
				forceReuseWindow: true,
			});
		} catch (error) {
			if (error instanceof WorktreeManagerError && error.code === WorktreeManagerErrorCode.BranchNotFound) {
				await this.activateProject(this._state.project);
				return;
			}

			this.notificationService.error(error instanceof Error ? error.message : localize('projectCanvas.openBranchFailed', "Failed to open a worktree for this branch."));
		}
	}

	private setState(state: ProjectCanvasViewState): void {
		this._state = state;
		this._onDidChangeState.fire(state);
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

export class ProjectCanvasPage extends EditorPane {
	static readonly ID = "projectCanvasPage";

	private rootElement!: HTMLElement;
	private headerElement!: HTMLElement;
	private openFolderButton!: HTMLButtonElement;
	private projectsElement!: HTMLElement;
	private projectsScrollableElement!: DomScrollableElement;
	private emptyStateElement!: HTMLElement;
	private readonly renderDisposables = this._register(new DisposableStore());
	private readonly model: ProjectCanvasPageModel;

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
		@IWorktreeManagerService worktreeManagerService: IWorktreeManagerService,
		@IHostService hostService: IHostService,
		@INotificationService notificationService: INotificationService,
	) {
		super(
			ProjectCanvasPage.ID,
			group,
			telemetryService,
			themeService,
			storageService,
		);

		this.model = this._register(new ProjectCanvasPageModel(hostService, notificationService, worktreeManagerService));

		this._register(
			this.projectCanvasService.onDidChangeProjects(() => this.renderVisibleState()),
		);
		this._register(this.model.onDidChangeState(() => this.renderVisibleState()));
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
		this.headerElement = append(contentElement, $(".project-canvas-header"));

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
		this.renderVisibleState();
	}

	override clearInput(): void {
		this.renderDisposables.clear();
		clearNode(this.headerElement);
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

	private renderVisibleState(): void {
		if (!this.projectsElement || !this.headerElement) {
			return;
		}

		this.renderDisposables.clear();
		clearNode(this.headerElement);
		clearNode(this.projectsElement);

		const state = this.model.state;
		if (state.kind === 'projects') {
			this.renderProjectsView();
		} else {
			this.renderBranchesView(state.project, state.branches, state.loading);
		}

		this.projectsScrollableElement.scanDomNode();
	}

	private renderProjectsView(): void {
		append(
			this.headerElement,
			$(
				"h2.project-canvas-title",
				undefined,
				localize("projectCanvasTitle", "Projects"),
			),
		);

		const projects = this.projectCanvasService.getProjects();
		if (projects.length === 0) {
			this.projectsElement.appendChild(this.emptyStateElement);
			return;
		}

		for (const project of projects) {
			this.projectsElement.appendChild(this.renderProjectTile(project));
		}
	}

	private renderBranchesView(project: IProjectCanvasProject, branches: readonly IWorktreeBranchEntry[], loading: boolean): void {
		const backButton = append(
			this.headerElement,
			$("button.project-canvas-back", { type: 'button', 'aria-label': localize('projectCanvas.back', "Back to projects") }),
		) as HTMLButtonElement;
		backButton.appendChild(renderIcon(Codicon.arrowLeft));
		append(backButton, $('span', undefined, localize('projectCanvas.backLabel', "Back")));
		this.renderDisposables.add(addDisposableListener(backButton, EventType.CLICK, event => {
			EventHelper.stop(event, true);
			void this.model.showProjects();
		}));

		const titleContainer = append(this.headerElement, $('.project-canvas-title-container'));
		append(
			titleContainer,
			$('h2.project-canvas-title', undefined, project.label),
		);
		append(
			titleContainer,
			$('p.project-canvas-subtitle', undefined, localize('projectCanvas.branchesSubtitle', "Branches")),
		);

		if (loading) {
			this.projectsElement.appendChild(
				$('.project-canvas-empty', undefined, localize('projectCanvas.loadingBranches', "Loading branches...")),
			);
			return;
		}

		for (const branch of branches) {
			this.projectsElement.appendChild(this.renderBranchTile(branch));
		}
	}

	private getPrimaryFocusableElement(): HTMLElement | undefined {
		return this.projectsElement?.querySelector<HTMLElement>('.project-canvas-project') ?? this.projectsElement?.querySelector<HTMLElement>('.project-canvas-branch') ?? this.openFolderButton;
	}

	private renderProjectTile(project: IProjectCanvasProject): HTMLElement {
		const tile = this.renderCanvasTile(
			'project-canvas-project',
			project.label,
			Codicon.folder,
			localize(
				"projectTileAriaLabel",
				"Open project {0}",
				project.label,
			),
		);

		this.renderDisposables.add(
			addDisposableListener(tile, EventType.CLICK, (event) => {
				EventHelper.stop(event, true);
				void this.model.activateProject(project);
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
					void this.model.activateProject(project);
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

	private renderBranchTile(branch: IWorktreeBranchEntry): HTMLElement {
		const icon = branch.iconHint === 'branch' ? Codicon.gitBranch : Codicon.code;
		const tile = this.renderCanvasTile(
			'project-canvas-branch',
			branch.branchName,
			icon,
			localize('projectCanvas.branchAriaLabel', "Open branch {0}", branch.branchName),
		);

		this.renderDisposables.add(addDisposableListener(tile, EventType.CLICK, event => {
			EventHelper.stop(event, true);
			void this.model.activateBranch(branch);
		}));

		this.renderDisposables.add(addDisposableListener(tile, EventType.KEY_DOWN, event => {
			const keyboardEvent = new StandardKeyboardEvent(event);
			if (keyboardEvent.equals(KeyCode.Enter) || keyboardEvent.equals(KeyCode.Space)) {
				EventHelper.stop(event, true);
				void this.model.activateBranch(branch);
			}
		}));

		return tile;
	}

	private renderCanvasTile(className: string, label: string, iconId: ThemeIcon, ariaLabel: string): HTMLElement {
		const tile = $(`.${className}`, {
			tabIndex: "0",
			role: "button",
			"aria-label": ariaLabel,
		});

		const icon = append(tile, $(".project-canvas-project-icon"));
		icon.appendChild(renderIcon(iconId));

		append(
			tile,
			$("span.project-canvas-project-label", undefined, label),
		);

		return tile;
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
