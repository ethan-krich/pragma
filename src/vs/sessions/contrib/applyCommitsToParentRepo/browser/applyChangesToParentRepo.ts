/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ethan Krich. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { toAction } from '../../../../base/common/actions.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { autorun } from '../../../../base/common/observable.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../workbench/common/contributions.js';
import { IsSessionsWindowContext } from '../../../../workbench/common/contextkeys.js';
import { CHAT_CATEGORY } from '../../../../workbench/contrib/chat/browser/actions/chatActions.js';
import { ISessionsManagementService } from '../../sessions/browser/sessionsManagementService.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { URI } from '../../../../base/common/uri.js';
import { IWorktreeManagerService } from '../../../../workbench/contrib/worktreeManager/browser/worktreeManagerService.js';

const hasWorktreeAndRepositoryContextKey = new RawContextKey<boolean>('agentSessionHasWorktreeAndRepository', false, {
	type: 'boolean',
	description: localize('agentSessionHasWorktreeAndRepository', "True when the active agent session has both a worktree and a parent repository.")
});

class ApplyChangesToParentRepoContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'sessions.contrib.applyChangesToParentRepo';

	constructor(
		@IContextKeyService contextKeyService: IContextKeyService,
		@ISessionsManagementService sessionManagementService: ISessionsManagementService,
	) {
		super();

		const worktreeAndRepoKey = hasWorktreeAndRepositoryContextKey.bindTo(contextKeyService);

		this._register(autorun(reader => {
			const activeSession = sessionManagementService.activeSession.read(reader);
			const repo = activeSession?.workspace.read(reader)?.repositories[0];
			const hasWorktreeAndRepo = !!repo?.workingDirectory && !!repo?.uri;
			worktreeAndRepoKey.set(hasWorktreeAndRepo);
		}));
	}
}

class ApplyChangesToParentRepoAction extends Action2 {
	static readonly ID = 'chatEditing.applyChangesToParentRepo';

	constructor() {
		super({
			id: ApplyChangesToParentRepoAction.ID,
			title: localize2('applyChangesToParentRepo', 'Apply Changes to Parent Repository'),
			icon: Codicon.desktopDownload,
			category: CHAT_CATEGORY,
			precondition: ContextKeyExpr.and(
				IsSessionsWindowContext,
				hasWorktreeAndRepositoryContextKey,
			),
			menu: [
				{
					id: MenuId.ChatEditingSessionApplySubmenu,
					group: 'navigation',
					order: 2,
					when: ContextKeyExpr.and(
						ContextKeyExpr.false(),
						IsSessionsWindowContext,
						hasWorktreeAndRepositoryContextKey
					),
				},
			],
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const sessionManagementService = accessor.get(ISessionsManagementService);
		const notificationService = accessor.get(INotificationService);
		const logService = accessor.get(ILogService);
		const openerService = accessor.get(IOpenerService);
		const productService = accessor.get(IProductService);
		const worktreeManagerService = accessor.get(IWorktreeManagerService);

		const activeSession = sessionManagementService.activeSession.get();
		const repo = activeSession?.workspace.get()?.repositories[0];
		if (!activeSession || !repo?.workingDirectory || !repo?.uri) {
			return;
		}

		const worktreeRoot = repo.workingDirectory;
		const repoRoot = repo.uri;
		const baseBranchName = repo.baseBranchName;

		const openFolderAction = toAction({
			id: 'applyChangesToParentRepo.openFolder',
			label: localize('openInVSCode', "Open in Pragma"),
			run: () => {
				const scheme = productService.quality === 'stable'
					? 'vscode'
					: productService.quality === 'exploration'
						? 'vscode-exploration'
						: 'vscode-insiders';

				const params = new URLSearchParams();
				params.set('windowId', '_blank');
				params.set('session', activeSession.resource.toString());

				openerService.open(URI.from({
					scheme,
					authority: Schemas.file,
					path: repoRoot.path,
					query: params.toString(),
				}), { openExternal: true });
			}
		});

		try {
			if (!baseBranchName) {
				notificationService.notify({
					severity: Severity.Warning,
					message: localize('applyChangesNoBranch', "Could not determine the parent branch for this worktree."),
				});
				return;
			}

			await worktreeManagerService.mergeWorktreeIntoBase(repoRoot, baseBranchName, {
				worktreePath: worktreeRoot,
				worktreeBranch: repo.detail,
			});

			notificationService.notify({
				severity: Severity.Info,
				message: localize('applyChangesSuccess', 'Applied changes to parent repository.'),
				actions: { primary: [openFolderAction] }
			});
		} catch (err) {
			logService.error('[ApplyChangesToParentRepo] Failed to apply changes', err);
			notificationService.notify({
				severity: Severity.Warning,
				message: localize('applyChangesConflict', "Failed to apply changes to parent repo. The parent repo may have diverged — resolve conflicts manually."),
				actions: { primary: [openFolderAction] }
			});
		}
	}
}

registerAction2(ApplyChangesToParentRepoAction);
registerWorkbenchContribution2(ApplyChangesToParentRepoContribution.ID, ApplyChangesToParentRepoContribution, WorkbenchPhase.AfterRestored);

// Register the apply submenu in the session changes toolbar
MenuRegistry.appendMenuItem(MenuId.ChatEditingSessionChangesToolbar, {
	submenu: MenuId.ChatEditingSessionApplySubmenu,
	title: localize2('applyActions', 'Apply Actions'),
	group: 'navigation',
	order: 1,
	when: IsSessionsWindowContext,
});
