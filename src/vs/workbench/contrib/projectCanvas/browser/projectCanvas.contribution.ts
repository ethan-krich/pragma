/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ethan Krich. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { getActiveElement } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { onUnexpectedError } from '../../../../base/common/errors.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKey, IContextKeyService, ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { registerWorkbenchContribution2, WorkbenchPhase, IWorkbenchContribution } from '../../../common/contributions.js';
import { AuxiliaryBarMaximizedContext, ProjectCanvasEmptyWorkbenchContext } from '../../../common/contextkeys.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { IEditorFactoryRegistry, EditorExtensions } from '../../../common/editor.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../services/editor/common/editorResolverService.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { ProjectCanvasPage, ProjectCanvasInputSerializer } from './projectCanvas.js';
import { ProjectCanvasEditorOptions, ProjectCanvasInput } from './projectCanvasInput.js';
import { IProjectCanvasService, ProjectCanvasCommandIds } from './projectCanvasService.js';

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory)
	.registerEditorSerializer(ProjectCanvasInput.ID, ProjectCanvasInputSerializer);

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		ProjectCanvasPage,
		ProjectCanvasPage.ID,
		localize('projectCanvasEditor', "Project Canvas")
	),
	[
		new SyncDescriptor(ProjectCanvasInput)
	]
);

class ProjectCanvasEditorResolverContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.projectCanvasEditorResolver';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		this._register(editorResolverService.registerEditor(
			`${ProjectCanvasInput.RESOURCE.scheme}:${ProjectCanvasInput.RESOURCE.authority}/**`,
			{
				id: ProjectCanvasPage.ID,
				label: localize('projectCanvasEditorDisplayName', "Project Canvas"),
				priority: RegisteredEditorPriority.builtin,
			},
			{
				singlePerResource: true,
				canSupportResource: resource =>
					resource.scheme === ProjectCanvasInput.RESOURCE.scheme &&
					resource.authority === ProjectCanvasInput.RESOURCE.authority
			},
			{
				createEditorInput: ({ options }) => ({
					editor: instantiationService.createInstance(ProjectCanvasInput, options as ProjectCanvasEditorOptions),
					options: {
						...options,
						pinned: false
					}
				})
			}
		));
	}
}

class ProjectCanvasRunnerContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.projectCanvasRunner';

	private readonly ensureProjectCanvasScheduler = this._register(new RunOnceScheduler(() => this.ensureProjectCanvas().then(undefined, onUnexpectedError), 0));

	private openingProjectCanvas = false;

	constructor(
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@IEditorService private readonly editorService: IEditorService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IProjectCanvasService private readonly projectCanvasService: IProjectCanvasService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();
		this.registerListeners();
		this.scheduleEnsureProjectCanvas();
	}

	private registerListeners(): void {
		this._register(this.workspaceContextService.onDidChangeWorkbenchState(() => this.scheduleEnsureProjectCanvas()));
		this._register(this.editorService.onDidVisibleEditorsChange(() => this.scheduleEnsureProjectCanvas()));
	}

	private scheduleEnsureProjectCanvas(): void {
		this.ensureProjectCanvasScheduler.schedule();
	}

	private async ensureProjectCanvas(): Promise<void> {
		await this.editorGroupsService.whenReady;

		if (this.openingProjectCanvas || AuxiliaryBarMaximizedContext.getValue(this.contextKeyService)) {
			return;
		}

		if (this.workspaceContextService.getWorkbenchState() !== WorkbenchState.EMPTY) {
			this.projectCanvasService.clearPendingCanvasOpenRequest();
			return;
		}

		if (this.editorService.visibleEditors.length > 0) {
			return;
		}

		await this.openProjectCanvas(this.projectCanvasService.consumePendingCanvasOpenRequest() ? 'command' : 'startup');
	}

	private async openProjectCanvas(initiator: 'startup' | 'command'): Promise<void> {
		this.openingProjectCanvas = true;
		try {
			const input = this.instantiationService.createInstance(ProjectCanvasInput, { initiator });
			await this.editorService.openEditor(input, {
				index: this.editorService.activeEditor ? 0 : undefined,
				pinned: false,
				preserveFocus: this.shouldPreserveFocus()
			});
		} finally {
			this.openingProjectCanvas = false;
		}
	}

	private shouldPreserveFocus(): boolean {
		const activeElement = getActiveElement();
		return !!activeElement && activeElement !== mainWindow.document.body && !this.layoutService.hasFocus(Parts.EDITOR_PART);
	}
}

class ProjectCanvasEmptyWorkbenchContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.projectCanvasEmptyWorkbench';

	private readonly emptyWorkbenchContext: IContextKey<boolean>;

	constructor(
		@IContextKeyService contextKeyService: IContextKeyService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();

		this.emptyWorkbenchContext = ProjectCanvasEmptyWorkbenchContext.bindTo(contextKeyService);
		this.update();

		this._register(this.workspaceContextService.onDidChangeWorkbenchState(() => this.update()));
	}

	private update(): void {
		const isEmptyWorkbench = this.workspaceContextService.getWorkbenchState() === WorkbenchState.EMPTY;
		this.emptyWorkbenchContext.set(isEmptyWorkbench);
		this.layoutService.getContainer(mainWindow).classList.toggle('project-canvas-empty-workbench', isEmptyWorkbench);
	}
}

async function openProjectCanvasEditor(accessor: ServicesAccessor, initiator: 'startup' | 'command'): Promise<void> {
	const editorService = accessor.get(IEditorService);
	const instantiationService = accessor.get(IInstantiationService);
	const input = instantiationService.createInstance(ProjectCanvasInput, { initiator });
	await editorService.openEditor(input, { pinned: false });
}

registerAction2(class ShowProjectCanvasAction extends Action2 {
	constructor() {
		super({
			id: ProjectCanvasCommandIds.Show,
			title: localize2('showProjectCanvas', 'Show Project Canvas'),
			shortTitle: localize2('showProjectCanvasShort', 'Projects'),
			icon: Codicon.folderOpened,
			menu: [
				{
					id: MenuId.CommandCenter,
					order: 4,
					when: ContextKeyExpr.has('config.window.commandCenter')
				},
				{
					id: MenuId.TitleBarAdjacentCenter,
					order: 1,
					when: ContextKeyExpr.has('config.window.commandCenter').negate()
				}
			],
			f1: true
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const workspaceContextService = accessor.get(IWorkspaceContextService);
		if (workspaceContextService.getWorkbenchState() === WorkbenchState.EMPTY) {
			await openProjectCanvasEditor(accessor, 'command');
			return;
		}

		const commandService = accessor.get(ICommandService);
		const projectCanvasService = accessor.get(IProjectCanvasService);

		projectCanvasService.flagCanvasToOpenOnNextEmptyWindow();
		await commandService.executeCommand('workbench.action.closeFolder');

		if (workspaceContextService.getWorkbenchState() !== WorkbenchState.EMPTY) {
			projectCanvasService.clearPendingCanvasOpenRequest();
		}
	}
});

registerAction2(class AddProjectCanvasProjectAction extends Action2 {
	constructor() {
		super({
			id: ProjectCanvasCommandIds.AddProject,
			title: localize2('addProjectToCanvas', 'Open New Project'),
			f1: true
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const fileDialogService = accessor.get(IFileDialogService);
		const hostService = accessor.get(IHostService);
		const projectCanvasService = accessor.get(IProjectCanvasService);
		const selectedFolders = await fileDialogService.showOpenDialog({
			title: localize('openProjectFoldersDialogTitle', "Open Folder Projects"),
			openLabel: localize('openProjectFoldersDialogLabel', "Open Projects"),
			canSelectFiles: false,
			canSelectFolders: true,
			canSelectMany: true
		});

		if (!selectedFolders?.length) {
			return;
		}

		for (const folder of selectedFolders) {
			projectCanvasService.upsertProject(folder, 'folder');
		}

		if (selectedFolders.length === 1) {
			await hostService.openWindow([{ folderUri: selectedFolders[0] }], { forceReuseWindow: true });
		}
	}
});

registerAction2(class RemoveProjectCanvasProjectAction extends Action2 {
	constructor() {
		super({
			id: ProjectCanvasCommandIds.RemoveProject,
			title: localize2('removeProjectCanvasProject', 'Remove Project from Canvas'),
			f1: true
		});
	}

	override async run(accessor: ServicesAccessor, resource: URI | string | undefined): Promise<void> {
		const revivedResource = typeof resource === 'string' ? URI.parse(resource) : resource;
		if (!revivedResource) {
			return;
		}

		accessor.get(IProjectCanvasService).removeProject(revivedResource);
	}
});

registerWorkbenchContribution2(ProjectCanvasEditorResolverContribution.ID, ProjectCanvasEditorResolverContribution, WorkbenchPhase.BlockStartup);
registerWorkbenchContribution2(ProjectCanvasRunnerContribution.ID, ProjectCanvasRunnerContribution, WorkbenchPhase.BlockRestore);
registerWorkbenchContribution2(ProjectCanvasEmptyWorkbenchContribution.ID, ProjectCanvasEmptyWorkbenchContribution, WorkbenchPhase.BlockRestore);
