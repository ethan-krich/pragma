/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ethan Krich. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { timeout } from '../../../../../base/common/async.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { Workspace } from '../../../../../platform/workspace/test/common/testWorkspace.js';
import { TestContextService, TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { ProjectCanvasService, ProjectCanvasStorageKeys } from '../../browser/projectCanvasService.js';
import { IWorktreeManagerService } from '../../../worktreeManager/browser/worktreeManagerService.js';

suite('ProjectCanvasService', () => {
	const repoRoot = URI.file('/repo');
	const worktreeRoot = URI.file('/pragma/worktrees/main-12345678');

	test('normalizes stored worktrees back to their canonical project root', async () => {
		const disposables = new DisposableStore();
		try {
			const storageService = disposables.add(new TestStorageService());
			storageService.store(ProjectCanvasStorageKeys.Projects, [
				{
					uri: repoRoot.toJSON(),
					kind: 'folder',
					label: 'repo',
					description: repoRoot.fsPath,
					lastOpened: 10,
				},
				{
					uri: worktreeRoot.toJSON(),
					kind: 'folder',
					label: 'main-12345678',
					description: worktreeRoot.fsPath,
					lastOpened: 20,
				},
			], StorageScope.APPLICATION, StorageTarget.MACHINE);

			const workspaceContextService = new TestContextService(new Workspace('empty', []));
			const worktreeManagerService: IWorktreeManagerService = {
				_serviceBrand: undefined,
				getCanonicalProjectRoot: async resource => resource.toString() === worktreeRoot.toString() ? repoRoot : resource,
				getGoodBranches: async () => [],
				getExistingWorktree: async () => undefined,
				getBranchContext: async () => undefined,
				resolveOrCreateWorktree: async () => worktreeRoot,
				mergeWorktreeIntoBase: async () => undefined,
				mergeCurrentWorktreeIntoBranch: async () => repoRoot,
				recreateWorktree: async () => worktreeRoot,
			};

			const service = disposables.add(new ProjectCanvasService(storageService, workspaceContextService, worktreeManagerService));
			await timeout(0);

			assert.deepStrictEqual(service.getProjects().map(project => ({
				resource: project.resource.toString(),
				kind: project.kind,
				lastOpened: project.lastOpened,
			})), [{
				resource: repoRoot.toString(),
				kind: 'folder',
				lastOpened: 20,
			}]);
		} finally {
			disposables.dispose();
		}
	});
});
