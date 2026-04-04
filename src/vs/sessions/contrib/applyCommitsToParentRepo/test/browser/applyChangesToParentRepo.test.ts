/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ethan Krich. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { CommandsRegistry } from '../../../../../platform/commands/common/commands.js';
import { TestInstantiationService } from '../../../../../platform/instantiation/test/common/instantiationServiceMock.js';
import { ILogService, NullLogService } from '../../../../../platform/log/common/log.js';
import { INotification, INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { TestNotificationService } from '../../../../../platform/notification/test/common/testNotificationService.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../../platform/product/common/productService.js';
import { IWorktreeManagerService } from '../../../../../workbench/contrib/worktreeManager/browser/worktreeManagerService.js';
import { ISessionsManagementService } from '../../../sessions/browser/sessionsManagementService.js';
import '../../browser/applyChangesToParentRepo.js';

class RecordingNotificationService extends TestNotificationService {
	readonly notifications: INotification[] = [];

	override notify(notification: INotification) {
		this.notifications.push(notification);
		return super.notify(notification);
	}
}

suite('ApplyChangesToParentRepoAction', () => {
	test('delegates merges to the worktree manager service', async () => {
		const repoRoot = URI.file('/repo');
		const worktreeRoot = URI.file('/repo.worktrees/main');
		const notifications = new RecordingNotificationService();
		const merges: Array<{ projectRoot: URI; visibleBranch: string; worktreePath: URI | undefined; worktreeBranch: string | undefined }> = [];

		const activeSession = {
			resource: URI.file('/session'),
			workspace: observableValue('workspace', {
				repositories: [{
					uri: repoRoot,
					workingDirectory: worktreeRoot,
					detail: 'pragma/worktrees/main-12345678',
					baseBranchName: 'main',
					baseBranchProtected: false,
				}],
			}),
		};

		const instantiationService = new TestInstantiationService();
		instantiationService.set(ISessionsManagementService, {
			_serviceBrand: undefined,
			activeSession: observableValue('activeSession', activeSession),
		} as unknown as ISessionsManagementService);
		instantiationService.set(INotificationService, notifications);
		instantiationService.set(IWorktreeManagerService, {
			_serviceBrand: undefined,
			getCanonicalProjectRoot: async projectRoot => projectRoot,
			getGoodBranches: async () => [],
			getExistingWorktree: async () => undefined,
			getBranchContext: async () => undefined,
			resolveOrCreateWorktree: async () => worktreeRoot,
			mergeWorktreeIntoBase: async (projectRoot, visibleBranch, options) => {
				merges.push({
					projectRoot,
					visibleBranch,
					worktreePath: options?.worktreePath,
					worktreeBranch: options?.worktreeBranch,
				});
			},
			mergeCurrentWorktreeIntoBranch: async () => repoRoot,
			recreateWorktree: async () => worktreeRoot,
		} as IWorktreeManagerService);
		instantiationService.set(IOpenerService, {
			_serviceBrand: undefined,
			open: async () => true,
		} as unknown as IOpenerService);
		instantiationService.set(IProductService, {
			_serviceBrand: undefined,
			quality: 'stable',
		} as unknown as IProductService);
		instantiationService.set(ILogService, new NullLogService());

		const command = CommandsRegistry.getCommand('chatEditing.applyChangesToParentRepo');
		assert.ok(command);

		await command!.handler(instantiationService);

		assert.deepStrictEqual(merges, [{
			projectRoot: repoRoot,
			visibleBranch: 'main',
			worktreePath: worktreeRoot,
			worktreeBranch: 'pragma/worktrees/main-12345678',
		}]);
		assert.strictEqual(notifications.notifications[0].severity, Severity.Info);
	});
});
