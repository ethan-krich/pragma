/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ethan Krich. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename, basenameOrAuthority } from '../../../../base/common/resources.js';
import { URI, UriComponents } from '../../../../base/common/uri.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService, WorkbenchState, WORKSPACE_SUFFIX } from '../../../../platform/workspace/common/workspace.js';

export const IProjectCanvasService = createDecorator<IProjectCanvasService>('projectCanvasService');

export const ProjectCanvasCommandIds = {
	Show: 'workbench.action.showProjectCanvas',
	AddProject: 'workbench.action.projectCanvas.addProject',
	RemoveProject: 'workbench.action.projectCanvas.removeProject',
};

export const ProjectCanvasStorageKeys = {
	Projects: 'workbench.projectCanvas.projects',
	OpenOnNextEmptyWindow: 'workbench.projectCanvas.openOnNextEmptyWindow',
};

export type ProjectCanvasProjectKind = 'folder' | 'workspace';

export interface IProjectCanvasProject {
	readonly resource: URI;
	readonly kind: ProjectCanvasProjectKind;
	readonly label: string;
	readonly description: string;
	readonly lastOpened: number;
}

interface IStoredProjectCanvasProject {
	readonly uri: UriComponents;
	readonly kind: ProjectCanvasProjectKind;
	readonly label: string;
	readonly description: string;
	readonly lastOpened: number;
}

export interface IProjectCanvasService {
	readonly _serviceBrand: undefined;

	readonly onDidChangeProjects: Event<readonly IProjectCanvasProject[]>;

	getProjects(): readonly IProjectCanvasProject[];
	upsertProject(resource: URI, kind: ProjectCanvasProjectKind): void;
	removeProject(resource: URI): void;
	flagCanvasToOpenOnNextEmptyWindow(): void;
	clearPendingCanvasOpenRequest(): void;
	consumePendingCanvasOpenRequest(): boolean;
}

export class ProjectCanvasService extends Disposable implements IProjectCanvasService {

	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeProjects = this._register(new Emitter<readonly IProjectCanvasProject[]>());
	readonly onDidChangeProjects = this._onDidChangeProjects.event;

	private projects: IProjectCanvasProject[] = [];

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
	) {
		super();

		this.projects = this.loadProjectsFromStorage();
		this.trackCurrentWorkspace();

		this._register(this.storageService.onDidChangeValue(StorageScope.APPLICATION, ProjectCanvasStorageKeys.Projects, this._store)(e => {
			if (!e.external) {
				return;
			}

			this.projects = this.loadProjectsFromStorage();
			this._onDidChangeProjects.fire(this.projects);
		}));

		this._register(this.workspaceContextService.onDidChangeWorkbenchState(() => this.trackCurrentWorkspace()));
	}

	getProjects(): readonly IProjectCanvasProject[] {
		return this.projects;
	}

	upsertProject(resource: URI, kind: ProjectCanvasProjectKind): void {
		const comparisonKey = resource.toString();
		const updated: IProjectCanvasProject = {
			resource,
			kind,
			label: this.getProjectLabel(resource, kind),
			description: this.getProjectDescription(resource),
			lastOpened: Date.now(),
		};

		this.projects = [
			updated,
			...this.projects.filter(project => project.resource.toString() !== comparisonKey),
		].sort((a, b) => b.lastOpened - a.lastOpened);

		this.saveProjects();
		this._onDidChangeProjects.fire(this.projects);
	}

	removeProject(resource: URI): void {
		const comparisonKey = resource.toString();
		const projects = this.projects.filter(project => project.resource.toString() !== comparisonKey);
		if (projects.length === this.projects.length) {
			return;
		}

		this.projects = projects;
		this.saveProjects();
		this._onDidChangeProjects.fire(this.projects);
	}

	flagCanvasToOpenOnNextEmptyWindow(): void {
		this.storageService.store(ProjectCanvasStorageKeys.OpenOnNextEmptyWindow, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	clearPendingCanvasOpenRequest(): void {
		this.storageService.remove(ProjectCanvasStorageKeys.OpenOnNextEmptyWindow, StorageScope.APPLICATION);
	}

	consumePendingCanvasOpenRequest(): boolean {
		const shouldOpen = this.storageService.getBoolean(ProjectCanvasStorageKeys.OpenOnNextEmptyWindow, StorageScope.APPLICATION, false);
		if (shouldOpen) {
			this.clearPendingCanvasOpenRequest();
		}

		return shouldOpen;
	}

	private trackCurrentWorkspace(): void {
		switch (this.workspaceContextService.getWorkbenchState()) {
			case WorkbenchState.FOLDER: {
				const folder = this.workspaceContextService.getWorkspace().folders[0];
				if (folder) {
					this.upsertProject(folder.uri, 'folder');
				}
				break;
			}
			case WorkbenchState.WORKSPACE: {
				const configuration = this.workspaceContextService.getWorkspace().configuration;
				if (configuration) {
					this.upsertProject(configuration, 'workspace');
				}
				break;
			}
		}
	}

	private loadProjectsFromStorage(): IProjectCanvasProject[] {
		const storedProjects = this.storageService.getObject<IStoredProjectCanvasProject[]>(ProjectCanvasStorageKeys.Projects, StorageScope.APPLICATION, []);
		if (!Array.isArray(storedProjects)) {
			return [];
		}

		return storedProjects
			.filter((project): project is IStoredProjectCanvasProject => ProjectCanvasService.isStoredProject(project))
			.map(project => ({
				resource: URI.revive(project.uri),
				kind: project.kind,
				label: project.label,
				description: project.description,
				lastOpened: project.lastOpened,
			}))
			.sort((a, b) => b.lastOpened - a.lastOpened);
	}

	private saveProjects(): void {
		const storedProjects: IStoredProjectCanvasProject[] = this.projects.map(project => ({
			uri: project.resource.toJSON(),
			kind: project.kind,
			label: project.label,
			description: project.description,
			lastOpened: project.lastOpened,
		}));

		this.storageService.store(ProjectCanvasStorageKeys.Projects, storedProjects, StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	private getProjectLabel(resource: URI, kind: ProjectCanvasProjectKind): string {
		if (kind === 'workspace') {
			return basename(resource, WORKSPACE_SUFFIX) || basename(resource);
		}

		return basenameOrAuthority(resource);
	}

	private getProjectDescription(resource: URI): string {
		return resource.scheme === Schemas.file ? resource.fsPath : resource.toString(true);
	}

	private static isStoredProject(value: unknown): value is IStoredProjectCanvasProject {
		const candidate = value as IStoredProjectCanvasProject | undefined;

		return !!candidate
			&& URI.isUri(URI.revive(candidate.uri))
			&& (candidate.kind === 'folder' || candidate.kind === 'workspace')
			&& typeof candidate.label === 'string'
			&& typeof candidate.description === 'string'
			&& typeof candidate.lastOpened === 'number';
	}
}

registerSingleton(IProjectCanvasService, ProjectCanvasService, InstantiationType.Delayed);
