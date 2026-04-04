/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ethan Krich. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { Event } from '../../../../../base/common/event.js';
import { URI } from '../../../../../base/common/uri.js';
import { INotification, Severity } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { IHostService } from '../../../../services/host/browser/host.js';
import { ProjectCanvasPageModel } from '../../browser/projectCanvas.js';
import { IProjectCanvasProject } from '../../browser/projectCanvasService.js';
import { IWorktreeManagerService } from '../../../worktreeManager/browser/worktreeManagerService.js';
import { IWorktreeBranchContext, IWorktreeBranchEntry, WorktreeManagerError, WorktreeManagerErrorCode } from '../../../worktreeManager/browser/worktreeManagerTypes.js';

class RecordingNotificationService extends TestNotificationService {
	readonly notifications: INotification[] = [];

	override notify(notification: INotification) {
		this.notifications.push(notification);
		return super.notify(notification);
	}
}

function createFolderProject(label = 'Repo'): IProjectCanvasProject {
	return {
		resource: URI.file('/repo'),
		kind: 'folder',
		label,
		description: '/repo',
		lastOpened: 1,
	};
}

function createWorkspaceProject(): IProjectCanvasProject {
	return {
		resource: URI.file('/repo.code-workspace'),
		kind: 'workspace',
		label: 'Repo Workspace',
		description: '/repo.code-workspace',
		lastOpened: 1,
	};
}

function createBranch(branchName: string, iconHint: 'branch' | 'code' = 'code'): IWorktreeBranchEntry {
	return {
		branchName,
		childBranchCount: iconHint === 'branch' ? 2 : 0,
		iconHint,
		worktreePath: undefined,
	};
}

function createBranchContext(overrides: Partial<IWorktreeBranchContext> = {}): IWorktreeBranchContext {
	return {
		canonicalRoot: URI.file('/repo'),
		currentRoot: URI.file('/repo'),
		currentBranch: 'feature/demo',
		visibleBranch: 'feature/demo',
		isManagedWorktree: false,
		linkedWorktreePath: undefined,
		hasLinkedWorktree: false,
		isLinkedWorktreeMerged: false,
		canStageAll: false,
		canCommit: false,
		canMerge: false,
		canPush: true,
		canRecreate: true,
		hasUpstream: true,
		...overrides,
	};
}

function createHostService(onOpenWindow: (toOpen: unknown, options: unknown) => Promise<void> | void): IHostService {
	return {
		_serviceBrand: undefined,
		onDidChangeFocus: Event.None,
		hasFocus: true,
		hadLastFocus: async () => true,
		focus: async () => undefined,
		onDidChangeActiveWindow: Event.None,
		onDidChangeFullScreen: Event.None,
		openWindow: async (first?: unknown, second?: unknown) => {
			if (Array.isArray(first)) {
				await onOpenWindow(first, second);
				return;
			}

			await onOpenWindow([], first);
		},
		toggleFullScreen: async () => undefined,
		moveTop: async () => undefined,
		setWindowDimmed: async () => undefined,
		getCursorScreenPoint: async () => undefined,
		getWindows: async () => [],
		restart: async () => undefined,
		reload: async () => undefined,
		close: async () => undefined,
		withExpectedShutdown: async <T>(task: () => Promise<T>) => task(),
		getScreenshot: async () => undefined,
		getNativeWindowHandle: async () => undefined,
		showToast: async (_options: unknown, _token: CancellationToken) => ({ supported: false, clicked: false }),
	} as unknown as IHostService;
}

suite('ProjectCanvasPageModel', () => {
	let disposables: ProjectCanvasPageModel[] = [];

	setup(() => {
		disposables = [];
	});

	teardown(() => {
		for (const disposable of disposables) {
			disposable.dispose();
		}
	});

	test('opens a folder project as a branch subview when git branches exist', async () => {
		const openCalls: unknown[] = [];
		const notificationService = new RecordingNotificationService();
		const worktreeManagerService: IWorktreeManagerService = {
			_serviceBrand: undefined,
			getCanonicalProjectRoot: async projectRoot => projectRoot,
			getGoodBranches: async () => [createBranch('main')],
			getExistingWorktree: async () => undefined,
			getBranchContext: async () => createBranchContext(),
			resolveOrCreateWorktree: async () => URI.file('/repo.worktrees/main'),
			mergeWorktreeIntoBase: async () => undefined,
			mergeCurrentWorktreeIntoBranch: async () => URI.file('/repo'),
			recreateWorktree: async () => URI.file('/repo.worktrees/main'),
		};
		const hostService = createHostService(async (toOpen, options) => { openCalls.push([toOpen, options]); });

		const model = new ProjectCanvasPageModel(hostService, notificationService, worktreeManagerService);
		disposables.push(model);
		await model.activateProject(createFolderProject());

		assert.strictEqual(model.state.kind, 'branches');
		assert.deepStrictEqual(model.state.kind === 'branches' ? model.state.branches.map(branch => branch.branchName) : [], ['main']);
		assert.strictEqual(openCalls.length, 0);
		assert.strictEqual(notificationService.notifications.length, 0);
	});

	test('falls back to opening the folder when no git branches are available', async () => {
		const openCalls: Array<{ toOpen: unknown; options: unknown }> = [];
		const worktreeManagerService = {
			_serviceBrand: undefined,
			getCanonicalProjectRoot: async (projectRoot: URI) => projectRoot,
			getGoodBranches: async () => [],
			getExistingWorktree: async () => undefined,
			getBranchContext: async () => createBranchContext(),
			resolveOrCreateWorktree: async () => URI.file('/repo.worktrees/main'),
			mergeWorktreeIntoBase: async () => undefined,
			mergeCurrentWorktreeIntoBranch: async () => URI.file('/repo'),
			recreateWorktree: async () => URI.file('/repo.worktrees/main'),
		} as IWorktreeManagerService;
		const hostService = createHostService(async (toOpen, options) => { openCalls.push({ toOpen, options }); });

		const model = new ProjectCanvasPageModel(hostService, new RecordingNotificationService(), worktreeManagerService);
		disposables.push(model);
		const project = createFolderProject();
		await model.activateProject(project);

		assert.strictEqual(model.state.kind, 'projects');
		assert.deepStrictEqual(openCalls[0], {
			toOpen: [{ folderUri: project.resource }],
			options: { forceReuseWindow: true },
		});
	});

	test('opens workspace projects directly', async () => {
		const openCalls: Array<{ toOpen: unknown; options: unknown }> = [];
		const worktreeManagerService = {
			_serviceBrand: undefined,
			getCanonicalProjectRoot: async (projectRoot: URI) => projectRoot,
			getGoodBranches: async () => [],
			getExistingWorktree: async () => undefined,
			getBranchContext: async () => createBranchContext(),
			resolveOrCreateWorktree: async () => URI.file('/repo.worktrees/main'),
			mergeWorktreeIntoBase: async () => undefined,
			mergeCurrentWorktreeIntoBranch: async () => URI.file('/repo'),
			recreateWorktree: async () => URI.file('/repo.worktrees/main'),
		} as IWorktreeManagerService;
		const hostService = createHostService(async (toOpen, options) => { openCalls.push({ toOpen, options }); });

		const model = new ProjectCanvasPageModel(hostService, new RecordingNotificationService(), worktreeManagerService);
		disposables.push(model);
		const project = createWorkspaceProject();
		await model.activateProject(project);

		assert.deepStrictEqual(openCalls[0], {
			toOpen: [{ workspaceUri: project.resource }],
			options: { forceReuseWindow: true },
		});
	});

	test('opens a resolved worktree when a branch card is activated', async () => {
		const openCalls: Array<{ toOpen: unknown; options: unknown }> = [];
		const worktreeManagerService = {
			_serviceBrand: undefined,
			getCanonicalProjectRoot: async (projectRoot: URI) => projectRoot,
			getGoodBranches: async () => [createBranch('main')],
			getExistingWorktree: async () => undefined,
			getBranchContext: async () => createBranchContext(),
			resolveOrCreateWorktree: async () => URI.file('/repo.worktrees/main'),
			mergeWorktreeIntoBase: async () => undefined,
			mergeCurrentWorktreeIntoBranch: async () => URI.file('/repo'),
			recreateWorktree: async () => URI.file('/repo.worktrees/main'),
		} as IWorktreeManagerService;
		const hostService = createHostService(async (toOpen, options) => { openCalls.push({ toOpen, options }); });

		const model = new ProjectCanvasPageModel(hostService, new RecordingNotificationService(), worktreeManagerService);
		disposables.push(model);
		await model.activateProject(createFolderProject());
		await model.activateBranch(createBranch('main'));

		assert.deepStrictEqual(openCalls[0], {
			toOpen: [{ folderUri: URI.file('/repo.worktrees/main') }],
			options: { forceReuseWindow: true },
		});
	});

	test('refreshes the branch subview when a branch disappears during activation', async () => {
		let branchRequestCount = 0;
		const notificationService = new RecordingNotificationService();
		const worktreeManagerService = {
			_serviceBrand: undefined,
			getCanonicalProjectRoot: async (projectRoot: URI) => projectRoot,
			getGoodBranches: async () => {
				branchRequestCount++;
				return branchRequestCount === 1 ? [createBranch('main')] : [createBranch('develop')];
			},
			getExistingWorktree: async () => undefined,
			getBranchContext: async () => createBranchContext(),
			resolveOrCreateWorktree: async () => {
				throw new WorktreeManagerError(WorktreeManagerErrorCode.BranchNotFound, 'branch vanished');
			},
			mergeWorktreeIntoBase: async () => undefined,
			mergeCurrentWorktreeIntoBranch: async () => URI.file('/repo'),
			recreateWorktree: async () => URI.file('/repo.worktrees/main'),
		} as IWorktreeManagerService;
		const hostService = createHostService(async () => undefined);

		const model = new ProjectCanvasPageModel(hostService, notificationService, worktreeManagerService);
		disposables.push(model);
		await model.activateProject(createFolderProject());
		await model.activateBranch(createBranch('main'));

		assert.strictEqual(model.state.kind, 'branches');
		assert.deepStrictEqual(model.state.kind === 'branches' ? model.state.branches.map(branch => branch.branchName) : [], ['develop']);
		assert.strictEqual(notificationService.notifications.some(notification => notification.severity === Severity.Error), false);
	});
});
