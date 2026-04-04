/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ethan Krich. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../../base/common/lifecycle.js';
import { observableValue } from '../../../../../base/common/observable.js';
import { URI } from '../../../../../base/common/uri.js';
import { ICommandEvent, ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IEnvironmentService } from '../../../../../platform/environment/common/environment.js';
import { StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkspaceTrustManagementService, IWorkspaceTrustUriInfo } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { GitRefType, GitRepositoryState, IGitRepository, IGitService } from '../../../git/common/gitService.js';
import { TestStorageService } from '../../../../test/common/workbenchTestServices.js';
import { WorktreeManagerService } from '../../browser/worktreeManagerService.js';
import { IGitBranchBaseInfo, IGitWorktreeInfo, WorktreeManagerError, WorktreeManagerErrorCode } from '../../browser/worktreeManagerTypes.js';

const STORAGE_KEY_MAPPINGS = 'workbench.worktreeManager.mappings';

class TestGitRepository implements IGitRepository {
	readonly state = observableValue<GitRepositoryState>('gitState', {
		HEAD: undefined,
		mergeChanges: [],
		indexChanges: [],
		workingTreeChanges: [],
		untrackedChanges: [],
	});

	constructor(
		readonly rootUri: URI,
		private refs: { readonly type: GitRefType; readonly name?: string }[],
	) { }

	updateState(state: GitRepositoryState): void {
		this.state.set(state, undefined);
	}

	async getRefs(): Promise<{ readonly type: GitRefType; readonly name?: string }[]> {
		return this.refs;
	}

	async diffBetweenWithStats(): Promise<[]> {
		return [];
	}

	async diffBetweenWithStats2(): Promise<[]> {
		return [];
	}
}

class TestGitService implements IGitService {
	declare readonly _serviceBrand: undefined;

	private readonly repositoriesByUri = new Map<string, IGitRepository>();

	get repositories(): Iterable<IGitRepository> {
		return this.repositoriesByUri.values();
	}

	setDelegate() {
		return Disposable.None;
	}

	registerRepository(uri: URI, repository: IGitRepository): void {
		this.repositoriesByUri.set(uri.toString(), repository);
	}

	async openRepository(uri: URI): Promise<IGitRepository | undefined> {
		return this.repositoriesByUri.get(uri.toString());
	}
}

class TestCommandService implements ICommandService {
	declare readonly _serviceBrand: undefined;

	readonly onWillExecuteCommand: Event<ICommandEvent> = Event.None;
	readonly onDidExecuteCommand: Event<ICommandEvent> = Event.None;

	readonly calls: Array<{ id: string; args: unknown[] }> = [];

	constructor(private readonly handlers: Record<string, (...args: any[]) => any>) { }

	async executeCommand<T>(id: string, ...args: any[]): Promise<T> {
		this.calls.push({ id, args });
		const handler = this.handlers[id];
		if (!handler) {
			throw new Error(`No handler registered for ${id}`);
		}

		return handler(...args) as T;
	}
}

class TestWorkspaceTrustManagementService implements IWorkspaceTrustManagementService {
	declare readonly _serviceBrand: undefined;

	readonly onDidChangeTrust = Event.None;
	readonly onDidChangeTrustedFolders = Event.None;
	readonly workspaceResolved = Promise.resolve();
	readonly workspaceTrustInitialized = Promise.resolve();
	acceptsOutOfWorkspaceFiles = true;

	readonly trustedUris = new Set<string>();
	readonly setUrisTrustCalls: URI[][] = [];

	isWorkspaceTrusted(): boolean {
		return true;
	}

	isWorkspaceTrustForced(): boolean {
		return false;
	}

	canSetParentFolderTrust(): boolean {
		return true;
	}

	async setParentFolderTrust(): Promise<void> {
	}

	canSetWorkspaceTrust(): boolean {
		return true;
	}

	async setWorkspaceTrust(): Promise<void> {
	}

	async getUriTrustInfo(uri: URI): Promise<IWorkspaceTrustUriInfo> {
		return { uri, trusted: this.trustedUris.has(uri.toString()) };
	}

	async setUrisTrust(uris: URI[], trusted: boolean): Promise<void> {
		this.setUrisTrustCalls.push(uris);
		for (const uri of uris) {
			if (trusted) {
				this.trustedUris.add(uri.toString());
			} else {
				this.trustedUris.delete(uri.toString());
			}
		}
	}

	getTrustedUris(): URI[] {
		return [...this.trustedUris].map(uri => URI.parse(uri));
	}

	async setTrustedUris(uris: URI[]): Promise<void> {
		this.trustedUris.clear();
		for (const uri of uris) {
			this.trustedUris.add(uri.toString());
		}
	}

	addWorkspaceTrustTransitionParticipant(): IDisposable {
		return Disposable.None;
	}
}

function createHeadRef(name: string) {
	return { type: GitRefType.Head, name };
}

function createWorktree(path: string, branchName: string | undefined, main = false): IGitWorktreeInfo {
	return {
		name: main ? 'repo' : branchName?.replace(/\//g, '-') ?? 'detached',
		path,
		ref: branchName ? `refs/heads/${branchName}` : 'HEAD',
		main,
		detached: !branchName,
		branchName,
	};
}

suite('WorktreeManagerService', () => {
	let storageService: TestStorageService;
	let gitService: TestGitService;
	let workspaceTrustManagementService: TestWorkspaceTrustManagementService;
	let disposables: Disposable[] = [];

	const projectRoot = URI.file('/repo');
	const featureBranchName = 'feature/demo';
	const managedFeatureBranchName = 'pragma/worktrees/feature/demo-12345678';
	const worktreeRoot = URI.file('/pragma/worktrees/feature-demo-12345678');
	const environmentService = {
		_serviceBrand: undefined,
		cacheHome: URI.file('/pragma'),
	} as IEnvironmentService;

	setup(() => {
		storageService = new TestStorageService();
		gitService = new TestGitService();
		workspaceTrustManagementService = new TestWorkspaceTrustManagementService();
		disposables = [storageService];
	});

	teardown(() => {
		for (const disposable of disposables) {
			disposable.dispose();
		}
	});

	function createService(options: {
		readonly refs: string[];
		readonly worktrees?: readonly IGitWorktreeInfo[];
		readonly branchBases?: Readonly<Record<string, IGitBranchBaseInfo | undefined>>;
		readonly revListCounts?: Readonly<Record<string, number>>;
		readonly repositoryState?: GitRepositoryState;
		readonly repositoryStatesByPath?: Readonly<Record<string, GitRepositoryState | undefined>>;
		readonly currentBranch?: string;
		readonly currentBranchesByPath?: Readonly<Record<string, string | undefined>>;
		readonly createWorktreeResult?: { readonly path: string; readonly branch: string; readonly commitish: string };
		readonly accessibleRepositories?: readonly URI[];
		readonly trustedUris?: readonly URI[];
	}): { readonly service: WorktreeManagerService; readonly commandService: TestCommandService } {
		const repository = new TestGitRepository(projectRoot, options.refs.map(createHeadRef));
		const projectRepositoryState = options.repositoryStatesByPath?.[projectRoot.fsPath] ?? options.repositoryState;
		if (projectRepositoryState) {
			repository.updateState(projectRepositoryState);
		}
		gitService.registerRepository(projectRoot, repository);
		for (const uri of options.trustedUris ?? []) {
			workspaceTrustManagementService.trustedUris.add(uri.toString());
		}

		for (const uri of options.accessibleRepositories ?? []) {
			const accessibleRepository = new TestGitRepository(uri, options.refs.map(createHeadRef));
			const accessibleRepositoryState = options.repositoryStatesByPath?.[uri.fsPath];
			if (accessibleRepositoryState) {
				accessibleRepository.updateState(accessibleRepositoryState);
			}
			gitService.registerRepository(uri, accessibleRepository);
		}

		const commandService = new TestCommandService({
			'_git.getWorktrees': () => options.worktrees ?? [createWorktree(projectRoot.fsPath, 'main', true)],
			'_git.getBranchBase': (_repositoryPath: string, branchName: string) => options.branchBases?.[branchName],
			'_git.revListCount': (_repositoryPath: string, fromRef: string, toRef: string) => options.revListCounts?.[`${fromRef}..${toRef}`] ?? 1,
				'_git.revParseAbbrevRef': (repositoryPath: string) => options.currentBranchesByPath?.[repositoryPath] ?? options.currentBranch ?? 'main',
			'_git.createWorktree': (_repositoryPath: string, commitish: string, branch: string, requestedWorktreePath: string) => options.createWorktreeResult ?? {
				path: requestedWorktreePath,
				branch,
				commitish,
			},
			'_git.deleteWorktree': () => undefined,
			'_git.checkout': () => undefined,
			'_git.mergeBranch': () => 'merged',
		});

		const service = new WorktreeManagerService(gitService, commandService, storageService, environmentService, workspaceTrustManagementService);
		disposables.push(service);

		return {
			service,
			commandService,
		};
	}

	test('filters managed branches and computes child counts', async () => {
		const { service } = createService({
			refs: ['main', 'feature/parent', 'feature/child-one', 'feature/child-two', 'pragma/worktrees/main-12345678'],
			branchBases: {
				'feature/parent': { name: 'origin/main', isProtected: false, remote: 'origin', localBranchName: 'main' },
				'feature/child-one': { name: 'origin/feature/parent', isProtected: false, remote: 'origin', localBranchName: 'feature/parent' },
				'feature/child-two': { name: 'origin/feature/parent', isProtected: false, remote: 'origin', localBranchName: 'feature/parent' },
			},
			currentBranch: 'main',
		});

		const branches = await service.getGoodBranches(projectRoot);
		assert.deepStrictEqual(branches.map(branch => branch.branchName), ['main', 'feature/child-one', 'feature/child-two', 'feature/parent']);

		const parentBranch = branches.find(branch => branch.branchName === 'feature/parent');
		const mainBranch = branches.find(branch => branch.branchName === 'main');
		assert.strictEqual(parentBranch?.childBranchCount, 2);
		assert.strictEqual(parentBranch?.iconHint, 'branch');
		assert.strictEqual(mainBranch?.childBranchCount, 0);
		assert.strictEqual(mainBranch?.iconHint, 'code');
		assert.ok(!branches.some(branch => branch.branchName === 'pragma/worktrees/main-12345678'));
	});

	test('reuses an existing mapped worktree', async () => {
		storageService.store(STORAGE_KEY_MAPPINGS, {
			[projectRoot.toString()]: {
				[featureBranchName]: {
					managedBranchName: managedFeatureBranchName,
					worktreePath: worktreeRoot.fsPath,
				},
			},
		}, StorageScope.APPLICATION, StorageTarget.MACHINE);

		const { service } = createService({
			refs: ['main', featureBranchName, managedFeatureBranchName],
			worktrees: [
				createWorktree(projectRoot.fsPath, 'main', true),
				createWorktree(worktreeRoot.fsPath, managedFeatureBranchName),
			],
			accessibleRepositories: [worktreeRoot],
		});

		const existing = await service.getExistingWorktree(projectRoot, featureBranchName);
		assert.strictEqual(existing?.fsPath, worktreeRoot.fsPath);
	});

	test('clears stale mappings when the worktree no longer exists', async () => {
		storageService.store(STORAGE_KEY_MAPPINGS, {
			[projectRoot.toString()]: {
				[featureBranchName]: {
					managedBranchName: managedFeatureBranchName,
					worktreePath: worktreeRoot.fsPath,
				},
			},
		}, StorageScope.APPLICATION, StorageTarget.MACHINE);

		const { service } = createService({
			refs: ['main', featureBranchName, managedFeatureBranchName],
			worktrees: [createWorktree(projectRoot.fsPath, 'main', true)],
		});

		const existing = await service.getExistingWorktree(projectRoot, featureBranchName);
		assert.strictEqual(existing, undefined);

		const storedMappings = storageService.getObject(STORAGE_KEY_MAPPINGS, StorageScope.APPLICATION, {}) as Record<string, unknown>;
		assert.deepStrictEqual(storedMappings, {});
	});

	test('rejects creating a worktree when the base branch disappeared', async () => {
		const { service } = createService({
			refs: ['main'],
		});

		await assert.rejects(
			() => service.resolveOrCreateWorktree(projectRoot, 'feature/missing'),
			(error: unknown) => error instanceof WorktreeManagerError && error.code === WorktreeManagerErrorCode.BranchNotFound,
		);
	});

	test('creates a managed worktree and persists the mapping', async () => {
		const { service, commandService } = createService({
			refs: ['main', featureBranchName],
			createWorktreeResult: {
				path: worktreeRoot.fsPath,
				branch: managedFeatureBranchName,
				commitish: featureBranchName,
			},
			trustedUris: [projectRoot],
		});

		const worktree = await service.resolveOrCreateWorktree(projectRoot, featureBranchName);
		assert.strictEqual(worktree.fsPath, worktreeRoot.fsPath);

		const createCall = commandService.calls.find(call => call.id === '_git.createWorktree');
		assert.strictEqual(createCall?.args[0], projectRoot.fsPath);
		assert.strictEqual(createCall?.args[1], featureBranchName);
		assert.ok(typeof createCall?.args[2] === 'string' && String(createCall?.args[2]).startsWith('pragma/worktrees/feature/demo-'));
		assert.ok(typeof createCall?.args[3] === 'string' && String(createCall?.args[3]).startsWith('/pragma/worktrees/feature-demo-'));

		const storedMappings = storageService.getObject(STORAGE_KEY_MAPPINGS, StorageScope.APPLICATION, {}) as Record<string, Record<string, { managedBranchName: string; worktreePath: string }>>;
		assert.deepStrictEqual(storedMappings[projectRoot.toString()][featureBranchName], {
			managedBranchName: managedFeatureBranchName,
			worktreePath: worktreeRoot.fsPath,
		});
		assert.deepStrictEqual(workspaceTrustManagementService.setUrisTrustCalls.at(-1)?.map(uri => uri.fsPath), [worktreeRoot.fsPath]);
	});

	test('returns the canonical root for main without creating a managed worktree', async () => {
		const { service, commandService } = createService({
			refs: ['main', featureBranchName],
		});

		const worktree = await service.resolveOrCreateWorktree(projectRoot, 'main');
		assert.strictEqual(worktree.fsPath, projectRoot.fsPath);
		assert.strictEqual(commandService.calls.some(call => call.id === '_git.createWorktree'), false);
	});

	test('merges the managed worktree branch back into its base branch', async () => {
		storageService.store(STORAGE_KEY_MAPPINGS, {
			[projectRoot.toString()]: {
				[featureBranchName]: {
					managedBranchName: managedFeatureBranchName,
					worktreePath: worktreeRoot.fsPath,
				},
			},
		}, StorageScope.APPLICATION, StorageTarget.MACHINE);

		const { service, commandService } = createService({
			refs: ['main', featureBranchName, managedFeatureBranchName],
			worktrees: [
				createWorktree(projectRoot.fsPath, 'main', true),
				createWorktree(worktreeRoot.fsPath, managedFeatureBranchName),
			],
			accessibleRepositories: [worktreeRoot],
			currentBranch: 'feature/other',
		});

		await service.mergeWorktreeIntoBase(projectRoot, featureBranchName);

		const checkoutCall = commandService.calls.find(call => call.id === '_git.checkout');
		const mergeCall = commandService.calls.find(call => call.id === '_git.mergeBranch');
		assert.deepStrictEqual(checkoutCall?.args, [projectRoot.fsPath, featureBranchName]);
		assert.deepStrictEqual(mergeCall?.args, [projectRoot.fsPath, managedFeatureBranchName]);
	});

	test('refuses to merge when the currently checked out canonical branch has uncommitted changes', async () => {
		storageService.store(STORAGE_KEY_MAPPINGS, {
			[projectRoot.toString()]: {
				[featureBranchName]: {
					managedBranchName: managedFeatureBranchName,
					worktreePath: worktreeRoot.fsPath,
				},
			},
		}, StorageScope.APPLICATION, StorageTarget.MACHINE);

		const { service, commandService } = createService({
			refs: ['main', featureBranchName, managedFeatureBranchName],
			worktrees: [
				createWorktree(projectRoot.fsPath, 'main', true),
				createWorktree(worktreeRoot.fsPath, managedFeatureBranchName),
			],
			accessibleRepositories: [worktreeRoot],
			currentBranch: 'feature/other',
			repositoryState: {
				HEAD: {
					type: GitRefType.Head,
					name: 'feature/other',
					commit: '123',
				},
				mergeChanges: [],
				indexChanges: [],
				workingTreeChanges: [{ uri: URI.file('/repo/dirty.ts'), originalUri: undefined, modifiedUri: undefined }],
				untrackedChanges: [],
			},
		});

		await assert.rejects(
			() => service.mergeWorktreeIntoBase(projectRoot, featureBranchName),
			(error: unknown) => error instanceof WorktreeManagerError && error.code === WorktreeManagerErrorCode.DirtyTargetBranch,
		);
		assert.strictEqual(commandService.calls.some(call => call.id === '_git.checkout'), false);
		assert.strictEqual(commandService.calls.some(call => call.id === '_git.mergeBranch'), false);
	});

	test('refuses to merge when the target canonical branch already checked out has uncommitted changes', async () => {
		storageService.store(STORAGE_KEY_MAPPINGS, {
			[projectRoot.toString()]: {
				[featureBranchName]: {
					managedBranchName: managedFeatureBranchName,
					worktreePath: worktreeRoot.fsPath,
				},
			},
		}, StorageScope.APPLICATION, StorageTarget.MACHINE);

		const { service, commandService } = createService({
			refs: ['main', featureBranchName, managedFeatureBranchName],
			worktrees: [
				createWorktree(projectRoot.fsPath, 'main', true),
				createWorktree(worktreeRoot.fsPath, managedFeatureBranchName),
			],
			accessibleRepositories: [worktreeRoot],
			currentBranch: featureBranchName,
			repositoryState: {
				HEAD: {
					type: GitRefType.Head,
					name: featureBranchName,
					commit: '123',
				},
				mergeChanges: [],
				indexChanges: [],
				workingTreeChanges: [{ uri: URI.file('/repo/dirty.ts'), originalUri: undefined, modifiedUri: undefined }],
				untrackedChanges: [],
			},
		});

		await assert.rejects(
			() => service.mergeWorktreeIntoBase(projectRoot, featureBranchName),
			(error: unknown) => error instanceof WorktreeManagerError && error.code === WorktreeManagerErrorCode.DirtyTargetBranch,
		);
		assert.strictEqual(commandService.calls.some(call => call.id === '_git.checkout'), false);
		assert.strictEqual(commandService.calls.some(call => call.id === '_git.mergeBranch'), false);
	});

	test('returns managed worktree branch context for the active worktree', async () => {
		storageService.store(STORAGE_KEY_MAPPINGS, {
			[projectRoot.toString()]: {
				[featureBranchName]: {
					managedBranchName: managedFeatureBranchName,
					worktreePath: worktreeRoot.fsPath,
				},
			},
		}, StorageScope.APPLICATION, StorageTarget.MACHINE);

		const { service } = createService({
			refs: ['main', featureBranchName, managedFeatureBranchName],
			worktrees: [
				createWorktree(projectRoot.fsPath, 'main', true),
				createWorktree(worktreeRoot.fsPath, managedFeatureBranchName),
			],
			accessibleRepositories: [worktreeRoot],
			currentBranch: managedFeatureBranchName,
		});

		const branchContext = await service.getBranchContext(worktreeRoot);
		assert.deepStrictEqual(branchContext && {
			currentBranch: branchContext.currentBranch,
			visibleBranch: branchContext.visibleBranch,
			isManagedWorktree: branchContext.isManagedWorktree,
			hasLinkedWorktree: branchContext.hasLinkedWorktree,
			canMerge: branchContext.canMerge,
			canRecreate: branchContext.canRecreate,
		}, {
			currentBranch: managedFeatureBranchName,
			visibleBranch: featureBranchName,
			isManagedWorktree: true,
			hasLinkedWorktree: true,
			canMerge: true,
			canRecreate: false,
		});
	});

	test('disables merge in managed worktree context when the canonical repository is dirty', async () => {
		storageService.store(STORAGE_KEY_MAPPINGS, {
			[projectRoot.toString()]: {
				[featureBranchName]: {
					managedBranchName: managedFeatureBranchName,
					worktreePath: worktreeRoot.fsPath,
				},
			},
		}, StorageScope.APPLICATION, StorageTarget.MACHINE);

		const { service } = createService({
			refs: ['main', featureBranchName, managedFeatureBranchName],
			worktrees: [
				createWorktree(projectRoot.fsPath, 'main', true),
				createWorktree(worktreeRoot.fsPath, managedFeatureBranchName),
			],
			accessibleRepositories: [worktreeRoot],
			currentBranchesByPath: {
				[projectRoot.fsPath]: 'feature/other',
				[worktreeRoot.fsPath]: managedFeatureBranchName,
			},
			repositoryStatesByPath: {
				[projectRoot.fsPath]: {
					HEAD: {
						type: GitRefType.Head,
						name: 'feature/other',
						commit: '123',
					},
					mergeChanges: [],
					indexChanges: [],
					workingTreeChanges: [{ uri: URI.file('/repo/dirty.ts'), originalUri: undefined, modifiedUri: undefined }],
					untrackedChanges: [],
				},
			},
		});

		const branchContext = await service.getBranchContext(worktreeRoot);
		assert.strictEqual(branchContext?.canMerge, false);
	});

	test('hides push and recreate while a linked worktree has not been merged yet', async () => {
		storageService.store(STORAGE_KEY_MAPPINGS, {
			[projectRoot.toString()]: {
				[featureBranchName]: {
					managedBranchName: managedFeatureBranchName,
					worktreePath: worktreeRoot.fsPath,
				},
			},
		}, StorageScope.APPLICATION, StorageTarget.MACHINE);

		const { service } = createService({
			refs: ['main', featureBranchName, managedFeatureBranchName],
			worktrees: [
				createWorktree(projectRoot.fsPath, 'main', true),
				createWorktree(worktreeRoot.fsPath, managedFeatureBranchName),
			],
			accessibleRepositories: [worktreeRoot],
			currentBranch: featureBranchName,
			revListCounts: {
				[`${featureBranchName}..${managedFeatureBranchName}`]: 2,
			},
		});

		const branchContext = await service.getBranchContext(projectRoot);
		assert.deepStrictEqual(branchContext && {
			hasLinkedWorktree: branchContext.hasLinkedWorktree,
			isLinkedWorktreeMerged: branchContext.isLinkedWorktreeMerged,
			canPush: branchContext.canPush,
			canRecreate: branchContext.canRecreate,
		}, {
			hasLinkedWorktree: true,
			isLinkedWorktreeMerged: false,
			canPush: false,
			canRecreate: false,
		});
	});

	test('allows push and recreate once the linked worktree is merged', async () => {
		storageService.store(STORAGE_KEY_MAPPINGS, {
			[projectRoot.toString()]: {
				[featureBranchName]: {
					managedBranchName: managedFeatureBranchName,
					worktreePath: worktreeRoot.fsPath,
				},
			},
		}, StorageScope.APPLICATION, StorageTarget.MACHINE);

		const { service } = createService({
			refs: ['main', featureBranchName, managedFeatureBranchName],
			worktrees: [
				createWorktree(projectRoot.fsPath, 'main', true),
				createWorktree(worktreeRoot.fsPath, managedFeatureBranchName),
			],
			accessibleRepositories: [worktreeRoot],
			currentBranch: featureBranchName,
			repositoryState: {
				HEAD: {
					type: GitRefType.Head,
					name: featureBranchName,
					upstream: { remote: 'origin', name: featureBranchName },
					ahead: 1,
					behind: 0,
					commit: '123',
				},
				mergeChanges: [],
				indexChanges: [],
				workingTreeChanges: [],
				untrackedChanges: [],
			},
			revListCounts: {
				[`${featureBranchName}..${managedFeatureBranchName}`]: 0,
			},
		});

		const branchContext = await service.getBranchContext(projectRoot);
		assert.deepStrictEqual(branchContext && {
			hasLinkedWorktree: branchContext.hasLinkedWorktree,
			isLinkedWorktreeMerged: branchContext.isLinkedWorktreeMerged,
			canPush: branchContext.canPush,
			canRecreate: branchContext.canRecreate,
		}, {
			hasLinkedWorktree: true,
			isLinkedWorktreeMerged: true,
			canPush: true,
			canRecreate: true,
		});
	});

	test('recreates a worktree from the current visible branch', async () => {
		const { service, commandService } = createService({
			refs: ['main', featureBranchName],
			currentBranch: featureBranchName,
			createWorktreeResult: {
				path: worktreeRoot.fsPath,
				branch: managedFeatureBranchName,
				commitish: featureBranchName,
			},
			trustedUris: [projectRoot],
		});

		const recreatedWorktree = await service.recreateWorktree(projectRoot);
		assert.strictEqual(recreatedWorktree.fsPath, worktreeRoot.fsPath);
		assert.strictEqual(commandService.calls.some(call => call.id === '_git.createWorktree'), true);
	});

	test('recreates a merged linked worktree by deleting the stale worktree first', async () => {
		storageService.store(STORAGE_KEY_MAPPINGS, {
			[projectRoot.toString()]: {
				[featureBranchName]: {
					managedBranchName: managedFeatureBranchName,
					worktreePath: worktreeRoot.fsPath,
				},
			},
		}, StorageScope.APPLICATION, StorageTarget.MACHINE);

		const { service, commandService } = createService({
			refs: ['main', featureBranchName, managedFeatureBranchName],
			worktrees: [
				createWorktree(projectRoot.fsPath, 'main', true),
				createWorktree(worktreeRoot.fsPath, managedFeatureBranchName),
			],
			accessibleRepositories: [worktreeRoot],
			currentBranch: featureBranchName,
			revListCounts: {
				[`${featureBranchName}..${managedFeatureBranchName}`]: 0,
			},
			createWorktreeResult: {
				path: '/pragma/worktrees/feature-demo-87654321',
				branch: 'pragma/worktrees/feature/demo-87654321',
				commitish: featureBranchName,
			},
			trustedUris: [projectRoot],
		});

		await service.recreateWorktree(projectRoot);

		assert.deepStrictEqual(commandService.calls.find(call => call.id === '_git.deleteWorktree')?.args, [projectRoot.fsPath, worktreeRoot.fsPath]);
		assert.strictEqual(commandService.calls.some(call => call.id === '_git.createWorktree'), true);
	});

	test('merges the current managed worktree, deletes it, and returns the canonical root', async () => {
		storageService.store(STORAGE_KEY_MAPPINGS, {
			[projectRoot.toString()]: {
				[featureBranchName]: {
					managedBranchName: managedFeatureBranchName,
					worktreePath: worktreeRoot.fsPath,
				},
			},
		}, StorageScope.APPLICATION, StorageTarget.MACHINE);

		const { service, commandService } = createService({
			refs: ['main', featureBranchName, managedFeatureBranchName],
			worktrees: [
				createWorktree(projectRoot.fsPath, 'main', true),
				createWorktree(worktreeRoot.fsPath, managedFeatureBranchName),
			],
			accessibleRepositories: [worktreeRoot],
			currentBranch: managedFeatureBranchName,
		});

		const targetRoot = await service.mergeCurrentWorktreeIntoBranch(worktreeRoot);
		assert.strictEqual(targetRoot.fsPath, projectRoot.fsPath);
		assert.deepStrictEqual(commandService.calls.find(call => call.id === '_git.deleteWorktree')?.args, [projectRoot.fsPath, worktreeRoot.fsPath]);

		const storedMappings = storageService.getObject(STORAGE_KEY_MAPPINGS, StorageScope.APPLICATION, {}) as Record<string, unknown>;
		assert.deepStrictEqual(storedMappings, {});
	});
});
