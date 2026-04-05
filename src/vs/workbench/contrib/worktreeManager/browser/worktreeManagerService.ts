/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ethan Krich. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { generateUuid } from '../../../../base/common/uuid.js';
import { isEqual, joinPath } from '../../../../base/common/resources.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEnvironmentService } from '../../../../platform/environment/common/environment.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { GitRepositoryState, IGitRepository, IGitService } from '../../git/common/gitService.js';
import { ICreateWorktreeResult, IGitBranchBaseInfo, IGitWorktreeInfo, IWorktreeBranchContext, IWorktreeBranchEntry, WorktreeManagerError, WorktreeManagerErrorCode } from './worktreeManagerTypes.js';

export interface IMergeWorktreeIntoBaseOptions {
	readonly worktreePath?: URI;
	readonly worktreeBranch?: string;
}

export interface IWorktreeManagerService {
	readonly _serviceBrand: undefined;

	getCanonicalProjectRoot(projectRoot: URI): Promise<URI>;
	getGoodBranches(projectRoot: URI): Promise<readonly IWorktreeBranchEntry[]>;
	getExistingWorktree(projectRoot: URI, visibleBranch: string): Promise<URI | undefined>;
	getBranchContext(projectRoot: URI): Promise<IWorktreeBranchContext | undefined>;
	resolveOrCreateWorktree(projectRoot: URI, visibleBranch: string): Promise<URI>;
	mergeWorktreeIntoBase(projectRoot: URI, visibleBranch: string, options?: IMergeWorktreeIntoBaseOptions): Promise<void>;
	mergeCurrentWorktreeIntoBranch(projectRoot: URI): Promise<URI>;
	recreateWorktree(projectRoot: URI): Promise<URI>;
}

export const IWorktreeManagerService = createDecorator<IWorktreeManagerService>('worktreeManagerService');

const STORAGE_KEY_MAPPINGS = 'workbench.worktreeManager.mappings';
const MANAGED_BRANCH_PREFIX = 'pragma/worktrees/';
const WORKTREE_DIRECTORY_NAME = 'worktrees';
const DIRECT_NAVIGATION_BRANCH_NAMES = new Set(['main']);
const MANAGED_BRANCH_SUFFIX_REGEX = /^(?<branch>.+)-[0-9a-f]{8}$/i;

interface IStoredWorktreeMapping {
	readonly managedBranchName: string;
	readonly worktreePath: string;
}

type StoredWorktreeMappings = Record<string, Record<string, IStoredWorktreeMapping>>;

interface IResolvedProjectContext {
	readonly canonicalRoot: URI;
	readonly repository: IGitRepository;
	readonly worktrees: readonly IGitWorktreeInfo[];
}

export class WorktreeManagerService extends Disposable implements IWorktreeManagerService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IGitService private readonly gitService: IGitService,
		@ICommandService private readonly commandService: ICommandService,
		@IStorageService private readonly storageService: IStorageService,
		@IEnvironmentService private readonly environmentService: IEnvironmentService,
		@IWorkspaceTrustManagementService private readonly workspaceTrustManagementService: IWorkspaceTrustManagementService,
	) {
		super();

		this._register(this.workspaceTrustManagementService.onDidChangeTrustedFolders(() => void this.syncTrustedWorktrees()));
		void this.syncTrustedWorktrees();
	}

	async getCanonicalProjectRoot(projectRoot: URI): Promise<URI> {
		return (await this.resolveProjectContext(projectRoot))?.canonicalRoot ?? projectRoot;
	}

	async getGoodBranches(projectRoot: URI): Promise<readonly IWorktreeBranchEntry[]> {
		const context = await this.resolveProjectContext(projectRoot);
		if (!context) {
			return [];
		}

		const localBranchNames = await this.getLocalBranchNames(context.repository);
		const visibleBranchNames = localBranchNames.filter(branchName => !this.isManagedBranch(branchName));
		if (visibleBranchNames.length === 0) {
			return [];
		}

		const currentBranch = await this.getCurrentBranch(context.canonicalRoot.fsPath);
		const branchBaseInfoByName = new Map<string, IGitBranchBaseInfo | undefined>();

		await Promise.all(visibleBranchNames.map(async branchName => {
			branchBaseInfoByName.set(branchName, await this.getBranchBase(context.canonicalRoot.fsPath, branchName));
		}));

		const childBranchCountByName = new Map<string, number>();
		for (const branchName of visibleBranchNames) {
			childBranchCountByName.set(branchName, 0);
		}

		const visibleBranchSet = new Set(visibleBranchNames);
		for (const branchName of visibleBranchNames) {
			const parentBranch = this.getVisibleBaseBranch(branchBaseInfoByName.get(branchName));
			if (parentBranch && visibleBranchSet.has(parentBranch)) {
				childBranchCountByName.set(parentBranch, (childBranchCountByName.get(parentBranch) ?? 0) + 1);
			}
		}

		const branchOrder = [...visibleBranchNames].sort((a, b) => {
			if (currentBranch && a === currentBranch) {
				return -1;
			}
			if (currentBranch && b === currentBranch) {
				return 1;
			}
			return a.localeCompare(b);
		});

		const localBranchNameSet = new Set(localBranchNames);

		return Promise.all(branchOrder.map(async branchName => {
			if (this.isDirectNavigationBranch(branchName)) {
				this.removeStoredMapping(context.canonicalRoot, branchName);
				return {
					branchName,
					childBranchCount: 0,
					iconHint: 'code',
					worktreePath: context.canonicalRoot,
				} satisfies IWorktreeBranchEntry;
			}

			const worktreePath = await this.validateStoredMapping(context.canonicalRoot, branchName, localBranchNameSet, context.worktrees);
			const childBranchCount = this.isDirectNavigationBranch(branchName) ? 0 : childBranchCountByName.get(branchName) ?? 0;

			return {
				branchName,
				childBranchCount,
				iconHint: childBranchCount > 1 ? 'branch' : 'code',
				worktreePath,
			} satisfies IWorktreeBranchEntry;
		}));
	}

	async getExistingWorktree(projectRoot: URI, visibleBranch: string): Promise<URI | undefined> {
		const context = await this.resolveProjectContext(projectRoot);
		if (!context) {
			return undefined;
		}

		if (this.isDirectNavigationBranch(visibleBranch)) {
			this.removeStoredMapping(context.canonicalRoot, visibleBranch);
			return context.canonicalRoot;
		}

		return this.validateStoredMapping(
			context.canonicalRoot,
			visibleBranch,
			new Set(await this.getLocalBranchNames(context.repository)),
			context.worktrees,
		);
	}

	async getBranchContext(projectRoot: URI): Promise<IWorktreeBranchContext | undefined> {
		const context = await this.resolveProjectContext(projectRoot);
		if (!context) {
			return undefined;
		}

		const currentRoot = isEqual(projectRoot, context.canonicalRoot) ? context.canonicalRoot : URI.file(projectRoot.fsPath);
		const currentBranch = await this.getCurrentBranch(currentRoot.fsPath);
		if (!currentBranch) {
			return undefined;
		}

		const currentRepository = await this.gitService.openRepository(currentRoot) ?? context.repository;
		const gitState = currentRepository.state.get();
		const canonicalGitState = context.repository.state.get();
		const canStageAll = gitState.workingTreeChanges.length > 0 || gitState.untrackedChanges.length > 0 || gitState.mergeChanges.length > 0;
		const canCommit = canStageAll || gitState.indexChanges.length > 0;
		const hasUpstream = !!gitState.HEAD?.upstream;

		if (this.isManagedBranch(currentBranch)) {
			const visibleBranch = this.getVisibleBranchForManagedBranch(context.canonicalRoot, currentBranch, currentRoot);
			if (!visibleBranch) {
				return undefined;
			}

				return {
					canonicalRoot: context.canonicalRoot,
					currentRoot,
					currentBranch,
					visibleBranch,
					isManagedWorktree: true,
					linkedWorktreePath: currentRoot,
					hasLinkedWorktree: true,
					isLinkedWorktreeMerged: false,
					canStageAll,
					canCommit,
					canMerge: !canCommit && !this.hasRepositoryChanges(canonicalGitState),
					canPush: false,
					canRecreate: false,
					hasUpstream,
				};
		}

		if (this.isDirectNavigationBranch(currentBranch)) {
			return undefined;
		}

		const localBranchNames = new Set(await this.getLocalBranchNames(context.repository));
		const storedMapping = await this.getValidatedStoredMapping(
			context.canonicalRoot,
			currentBranch,
			localBranchNames,
			context.worktrees,
		);
		const linkedWorktreePath = storedMapping ? URI.file(storedMapping.worktreePath) : undefined;
		const hasLinkedWorktree = !!storedMapping;
		const isLinkedWorktreeMerged = storedMapping
			? await this.isBranchMergedInto(context.canonicalRoot.fsPath, storedMapping.managedBranchName, currentBranch)
			: false;
		const canPush = (!hasLinkedWorktree || isLinkedWorktreeMerged) && (!hasUpstream || (gitState.HEAD?.ahead ?? 0) > 0);
		const canRecreate = !hasLinkedWorktree || isLinkedWorktreeMerged;

		return {
			canonicalRoot: context.canonicalRoot,
			currentRoot,
			currentBranch,
			visibleBranch: currentBranch,
			isManagedWorktree: false,
			linkedWorktreePath,
			hasLinkedWorktree,
			isLinkedWorktreeMerged,
			canStageAll,
			canCommit,
			canMerge: false,
			canPush,
			canRecreate,
			hasUpstream,
		};
	}

	async resolveOrCreateWorktree(projectRoot: URI, visibleBranch: string): Promise<URI> {
		const context = await this.resolveProjectContext(projectRoot);
		if (!context) {
			throw new WorktreeManagerError(
				WorktreeManagerErrorCode.NotAGitRepository,
				localize('worktreeManager.notGitRepository', "The selected project is not a Git repository."),
			);
		}

		const localBranchNames = await this.getLocalBranchNames(context.repository);
		const visibleBranchNames = new Set(localBranchNames.filter(branchName => !this.isManagedBranch(branchName)));
		if (!visibleBranchNames.has(visibleBranch)) {
			this.removeStoredMapping(context.canonicalRoot, visibleBranch);
			throw new WorktreeManagerError(
				WorktreeManagerErrorCode.BranchNotFound,
				localize('worktreeManager.branchNotFound', "The branch \"{0}\" no longer exists.", visibleBranch),
			);
		}

		if (this.isDirectNavigationBranch(visibleBranch)) {
			this.removeStoredMapping(context.canonicalRoot, visibleBranch);
			return context.canonicalRoot;
		}

		const existingWorktree = await this.validateStoredMapping(
			context.canonicalRoot,
			visibleBranch,
			new Set(localBranchNames),
			context.worktrees,
		);
		if (existingWorktree) {
			return existingWorktree;
		}

		const managedBranchName = this.getUniqueManagedBranchName(visibleBranch, new Set(localBranchNames));
		const worktreePath = this.getManagedWorktreePath(visibleBranch);
		const result = await this.commandService.executeCommand<ICreateWorktreeResult>(
			'_git.createWorktree',
			context.canonicalRoot.fsPath,
			visibleBranch,
			managedBranchName,
			worktreePath,
		);
		if (!result) {
			throw new WorktreeManagerError(
				WorktreeManagerErrorCode.WorktreeNotFound,
				localize('worktreeManager.worktreeCreateFailed', "Failed to create a worktree for \"{0}\".", visibleBranch),
			);
		}

		this.setStoredMapping(context.canonicalRoot, visibleBranch, {
			managedBranchName: result.branch,
			worktreePath: result.path,
		});
		await this.ensureProjectTrust(context.canonicalRoot, URI.file(result.path));

		return URI.file(result.path);
	}

	async mergeWorktreeIntoBase(projectRoot: URI, visibleBranch: string, options?: IMergeWorktreeIntoBaseOptions): Promise<void> {
		const context = await this.resolveProjectContext(projectRoot);
		if (!context) {
			throw new WorktreeManagerError(
				WorktreeManagerErrorCode.NotAGitRepository,
				localize('worktreeManager.notGitRepository', "The selected project is not a Git repository."),
			);
		}

		const localBranchNames = await this.getLocalBranchNames(context.repository);
		const visibleBranchNames = new Set(localBranchNames.filter(branchName => !this.isManagedBranch(branchName)));
		if (!visibleBranchNames.has(visibleBranch)) {
			this.removeStoredMapping(context.canonicalRoot, visibleBranch);
			throw new WorktreeManagerError(
				WorktreeManagerErrorCode.BranchNotFound,
				localize('worktreeManager.branchNotFound', "The branch \"{0}\" no longer exists.", visibleBranch),
			);
		}

		const storedMapping = await this.getValidatedStoredMapping(
			context.canonicalRoot,
			visibleBranch,
			new Set(localBranchNames),
			context.worktrees,
		);

		let worktreeBranch = storedMapping?.managedBranchName;
		if (!worktreeBranch && options?.worktreeBranch) {
			worktreeBranch = options.worktreeBranch;
		}

		if (!worktreeBranch && options?.worktreePath) {
			const worktree = context.worktrees.find(candidate =>
				!candidate.detached &&
				candidate.branchName &&
				isEqual(URI.file(candidate.path), options.worktreePath)
			);
			worktreeBranch = worktree?.branchName;
		}

		if (!worktreeBranch) {
			throw new WorktreeManagerError(
				WorktreeManagerErrorCode.WorktreeNotFound,
				localize('worktreeManager.worktreeNotFound', "No managed worktree was found for \"{0}\".", visibleBranch),
			);
		}

		const currentBranch = await this.getCurrentBranch(context.canonicalRoot.fsPath);
		const canonicalRepository = await this.gitService.openRepository(context.canonicalRoot) ?? context.repository;
		if (this.hasRepositoryChanges(canonicalRepository.state.get())) {
			throw new WorktreeManagerError(
				WorktreeManagerErrorCode.DirtyTargetBranch,
				localize('worktreeManager.targetBranchDirty', "The currently checked out branch at \"{0}\" has uncommitted changes. Clean it up before merging the worktree.", context.canonicalRoot.fsPath),
			);
		}

		if (currentBranch !== visibleBranch) {

			await this.commandService.executeCommand('_git.checkout', context.canonicalRoot.fsPath, visibleBranch);
		}

		await this.commandService.executeCommand('_git.mergeBranch', context.canonicalRoot.fsPath, worktreeBranch);
	}

	async mergeCurrentWorktreeIntoBranch(projectRoot: URI): Promise<URI> {
		const branchContext = await this.getBranchContext(projectRoot);
		if (!branchContext?.isManagedWorktree) {
			throw new WorktreeManagerError(
				WorktreeManagerErrorCode.WorktreeNotFound,
				localize('worktreeManager.currentWorktreeNotFound', "The current branch is not a managed worktree."),
			);
		}
		if (!branchContext.canMerge) {
			throw new WorktreeManagerError(
				WorktreeManagerErrorCode.CannotMerge,
				localize('worktreeManager.currentWorktreeCannotMerge', "The current worktree cannot be merged until both the worktree and its target branch are clean."),
			);
		}

		await this.mergeWorktreeIntoBase(branchContext.canonicalRoot, branchContext.visibleBranch, {
			worktreePath: branchContext.currentRoot,
			worktreeBranch: branchContext.currentBranch,
		});
		await this.commandService.executeCommand('_git.deleteWorktree', branchContext.canonicalRoot.fsPath, branchContext.currentRoot.fsPath);
		this.removeStoredMapping(branchContext.canonicalRoot, branchContext.visibleBranch);

		return branchContext.canonicalRoot;
	}

	async recreateWorktree(projectRoot: URI): Promise<URI> {
		const branchContext = await this.getBranchContext(projectRoot);
		if (!branchContext || branchContext.isManagedWorktree || !branchContext.canRecreate) {
			throw new WorktreeManagerError(
				WorktreeManagerErrorCode.WorktreeNotFound,
				localize('worktreeManager.branchRecreateUnavailable', "The current branch cannot be recreated as a worktree."),
			);
		}

		if (branchContext.linkedWorktreePath) {
			await this.commandService.executeCommand('_git.deleteWorktree', branchContext.canonicalRoot.fsPath, branchContext.linkedWorktreePath.fsPath);
			this.removeStoredMapping(branchContext.canonicalRoot, branchContext.visibleBranch);
		}

		return this.resolveOrCreateWorktree(branchContext.canonicalRoot, branchContext.visibleBranch);
	}

	private async resolveProjectContext(projectRoot: URI): Promise<IResolvedProjectContext | undefined> {
		let repository = await this.gitService.openRepository(projectRoot);
		if (!repository) {
			return undefined;
		}

		let worktrees = await this.getWorktrees(repository.rootUri.fsPath);
		let canonicalRoot = URI.file(worktrees.find(worktree => worktree.main)?.path ?? repository.rootUri.fsPath);

		if (!isEqual(canonicalRoot, repository.rootUri)) {
			repository = await this.gitService.openRepository(canonicalRoot) ?? repository;
			worktrees = await this.getWorktrees(canonicalRoot.fsPath);
		}

		canonicalRoot = URI.file(worktrees.find(worktree => worktree.main)?.path ?? canonicalRoot.fsPath);

		return { canonicalRoot, repository, worktrees };
	}

	private async getLocalBranchNames(repository: IGitRepository): Promise<string[]> {
		const refs = await repository.getRefs({ pattern: 'refs/heads', sort: 'alphabetically' });
		return refs
			.map(ref => ref.name)
			.filter((name): name is string => typeof name === 'string' && name.length > 0);
	}

	private async getCurrentBranch(repositoryPath: string): Promise<string | undefined> {
		try {
			return await this.commandService.executeCommand<string>('_git.revParseAbbrevRef', repositoryPath);
		} catch {
			return undefined;
		}
	}

	private async getWorktrees(repositoryPath: string): Promise<readonly IGitWorktreeInfo[]> {
		try {
			return await this.commandService.executeCommand<readonly IGitWorktreeInfo[]>('_git.getWorktrees', repositoryPath) ?? [];
		} catch {
			return [];
		}
	}

	private async getBranchBase(repositoryPath: string, branchName: string): Promise<IGitBranchBaseInfo | undefined> {
		try {
			return await this.commandService.executeCommand<IGitBranchBaseInfo | undefined>('_git.getBranchBase', repositoryPath, branchName);
		} catch {
			return undefined;
		}
	}

	private async isBranchMergedInto(repositoryPath: string, sourceBranchName: string, targetBranchName: string): Promise<boolean> {
		try {
			const commitsNotInTarget = await this.commandService.executeCommand<number>('_git.revListCount', repositoryPath, targetBranchName, sourceBranchName);
			return commitsNotInTarget === 0;
		} catch {
			return false;
		}
	}

	private hasRepositoryChanges(state: GitRepositoryState): boolean {
		return state.mergeChanges.length > 0 ||
			state.indexChanges.length > 0 ||
			state.workingTreeChanges.length > 0 ||
			state.untrackedChanges.length > 0;
	}

	private getVisibleBaseBranch(baseInfo: IGitBranchBaseInfo | undefined): string | undefined {
		return baseInfo?.localBranchName ?? baseInfo?.name;
	}

	private isManagedBranch(branchName: string): boolean {
		return branchName.startsWith(MANAGED_BRANCH_PREFIX);
	}

	private isDirectNavigationBranch(branchName: string): boolean {
		return DIRECT_NAVIGATION_BRANCH_NAMES.has(branchName);
	}

	private getVisibleBranchForManagedBranch(canonicalRoot: URI, managedBranchName: string, worktreeRoot?: URI): string | undefined {
		const projectMappings = this.getStoredMappings()[canonicalRoot.toString()];
		if (projectMappings) {
			for (const [visibleBranch, mapping] of Object.entries(projectMappings)) {
				if (mapping.managedBranchName !== managedBranchName) {
					continue;
				}

				if (!worktreeRoot || isEqual(URI.file(mapping.worktreePath), worktreeRoot)) {
					return visibleBranch;
				}
			}
		}

		return this.parseVisibleBranchFromManagedBranch(managedBranchName);
	}

	private parseVisibleBranchFromManagedBranch(branchName: string): string | undefined {
		if (!this.isManagedBranch(branchName)) {
			return undefined;
		}

		const encodedVisibleBranch = branchName.substring(MANAGED_BRANCH_PREFIX.length);
		return encodedVisibleBranch.match(MANAGED_BRANCH_SUFFIX_REGEX)?.groups?.branch ?? encodedVisibleBranch;
	}

	private getUniqueManagedBranchName(visibleBranch: string, allBranchNames: Set<string>): string {
		let candidate: string;
		do {
			candidate = `${MANAGED_BRANCH_PREFIX}${visibleBranch}-${this.createUniqueSuffix()}`;
		} while (allBranchNames.has(candidate));
		return candidate;
	}

	private getManagedWorktreePath(visibleBranch: string): string {
		const worktreeName = `${this.sanitizeWorktreeName(visibleBranch)}-${this.createUniqueSuffix()}`;
		return joinPath(this.environmentService.cacheHome, WORKTREE_DIRECTORY_NAME, worktreeName).fsPath;
	}

	private sanitizeWorktreeName(branchName: string): string {
		return branchName
			.replace(/[^a-zA-Z0-9._-]+/g, '-')
			.replace(/-+/g, '-')
			.replace(/^-|-$/g, '')
			|| 'branch';
	}

	private createUniqueSuffix(): string {
		return generateUuid().replace(/-/g, '').slice(0, 8);
	}

	private async validateStoredMapping(
		canonicalRoot: URI,
		visibleBranch: string,
		localBranchNames: ReadonlySet<string>,
		worktrees: readonly IGitWorktreeInfo[],
	): Promise<URI | undefined> {
		const mapping = await this.getValidatedStoredMapping(canonicalRoot, visibleBranch, localBranchNames, worktrees);
		return mapping ? URI.file(mapping.worktreePath) : undefined;
	}

	private async getValidatedStoredMapping(
		canonicalRoot: URI,
		visibleBranch: string,
		localBranchNames: ReadonlySet<string>,
		worktrees: readonly IGitWorktreeInfo[],
	): Promise<IStoredWorktreeMapping | undefined> {
		const mapping = this.getStoredMapping(canonicalRoot, visibleBranch);
		if (!mapping) {
			return undefined;
		}

		if (!localBranchNames.has(mapping.managedBranchName)) {
			this.removeStoredMapping(canonicalRoot, visibleBranch);
			return undefined;
		}

		const matchingWorktree = worktrees.find(worktree =>
			!worktree.main &&
			!worktree.detached &&
			worktree.branchName === mapping.managedBranchName
		);

		if (!matchingWorktree) {
			this.removeStoredMapping(canonicalRoot, visibleBranch);
			return undefined;
		}

		const worktreeRepository = await this.gitService.openRepository(URI.file(matchingWorktree.path));
		if (!worktreeRepository) {
			this.removeStoredMapping(canonicalRoot, visibleBranch);
			return undefined;
		}

		if (matchingWorktree.path !== mapping.worktreePath) {
			const updatedMapping: IStoredWorktreeMapping = {
				managedBranchName: mapping.managedBranchName,
				worktreePath: matchingWorktree.path,
			};
			this.setStoredMapping(canonicalRoot, visibleBranch, updatedMapping);
			return updatedMapping;
		}

		return mapping;
	}

	private getStoredMapping(canonicalRoot: URI, visibleBranch: string): IStoredWorktreeMapping | undefined {
		const mappings = this.getStoredMappings();
		return mappings[canonicalRoot.toString()]?.[visibleBranch];
	}

	private setStoredMapping(canonicalRoot: URI, visibleBranch: string, mapping: IStoredWorktreeMapping): void {
		const mappings = this.getStoredMappings();
		const projectKey = canonicalRoot.toString();
		const existingProjectMappings = mappings[projectKey] ?? {};
		mappings[projectKey] = {
			...existingProjectMappings,
			[visibleBranch]: mapping,
		};
		this.saveStoredMappings(mappings);
	}

	private removeStoredMapping(canonicalRoot: URI, visibleBranch: string): void {
		const mappings = this.getStoredMappings();
		const projectKey = canonicalRoot.toString();
		if (!mappings[projectKey]?.[visibleBranch]) {
			return;
		}

		const { [visibleBranch]: _removed, ...remainingProjectMappings } = mappings[projectKey];
		if (Object.keys(remainingProjectMappings).length > 0) {
			mappings[projectKey] = remainingProjectMappings;
		} else {
			delete mappings[projectKey];
		}

		this.saveStoredMappings(mappings);
	}

	private getStoredMappings(): StoredWorktreeMappings {
		return this.storageService.getObject<StoredWorktreeMappings>(STORAGE_KEY_MAPPINGS, StorageScope.APPLICATION, {}) ?? {};
	}

	private saveStoredMappings(mappings: StoredWorktreeMappings): void {
		this.storageService.store(STORAGE_KEY_MAPPINGS, mappings, StorageScope.APPLICATION, StorageTarget.MACHINE);
	}

	private async ensureProjectTrust(canonicalRoot: URI, worktreeUri: URI): Promise<void> {
		const canonicalTrust = await this.workspaceTrustManagementService.getUriTrustInfo(canonicalRoot);
		const worktreeTrust = await this.workspaceTrustManagementService.getUriTrustInfo(worktreeUri);

		if (canonicalTrust.trusted && !worktreeTrust.trusted) {
			await this.workspaceTrustManagementService.setUrisTrust([worktreeUri], true);
		}
	}

	private async syncTrustedWorktrees(): Promise<void> {
		const mappings = this.getStoredMappings();
		for (const [canonicalRootKey, branchMappings] of Object.entries(mappings)) {
			const uris = [
				URI.parse(canonicalRootKey),
				...Object.values(branchMappings).map(mapping => URI.file(mapping.worktreePath)),
			];

			const trustStates = await Promise.all(uris.map(uri => this.workspaceTrustManagementService.getUriTrustInfo(uri)));
			if (!trustStates.some(trustState => trustState.trusted) || trustStates.every(trustState => trustState.trusted)) {
				continue;
			}

			await this.workspaceTrustManagementService.setUrisTrust(uris, true);
		}
	}
}

registerSingleton(IWorktreeManagerService, WorktreeManagerService, InstantiationType.Delayed);
