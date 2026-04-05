/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ethan Krich. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { extUri } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ISCMProvider, ISCMRepository, ISCMService } from '../../common/scm.js';
import { getDisplayedRepositories } from '../../browser/util.js';
import { IUriIdentityService } from '../../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService, WorkbenchState, Workspace, WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';

suite('SCM Utilities', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('getDisplayedRepositories prefers the active repository when multiple repositories are visible', () => {
		const repositories = [
			createRepository('/workspace/base'),
			createRepository('/workspace/worktree'),
		];

		const displayedRepositories = getDisplayedRepositories(
			repositories,
			{ repository: repositories[1], pinned: false },
			undefined,
			undefined,
			createScmService(),
			createWorkspaceContextService('/workspace/base'),
			createUriIdentityService()
		);

		assert.deepStrictEqual(displayedRepositories.map(repository => repository.id), ['repo:/workspace/worktree']);
	});

	test('getDisplayedRepositories falls back to the workspace repository', () => {
		const repositories = [
			createRepository('/workspace/base'),
			createRepository('/workspace/worktree'),
		];

		const displayedRepositories = getDisplayedRepositories(
			repositories,
			undefined,
			undefined,
			undefined,
			createScmService(),
			createWorkspaceContextService('/workspace/worktree'),
			createUriIdentityService()
		);

		assert.deepStrictEqual(displayedRepositories.map(repository => repository.id), ['repo:/workspace/worktree']);
	});
});

function createRepository(rootPath: string): ISCMRepository {
	const rootUri = URI.file(rootPath);
	const provider = {
		id: `provider:${rootPath}`,
		providerId: 'git',
		label: rootPath,
		name: rootPath,
		rootUri,
		groups: [],
		onDidChangeResourceGroups: () => { throw new Error('Not implemented.'); },
		onDidChangeResources: () => { throw new Error('Not implemented.'); },
		inputBoxTextModel: undefined!,
		contextValue: undefined!,
		count: undefined!,
		commitTemplate: undefined!,
		artifactProvider: undefined!,
		historyProvider: undefined!,
		actionButton: undefined!,
		statusBarCommands: undefined!,
		getOriginalResource: async () => null,
		dispose: () => { }
	} satisfies ISCMProvider;

	return {
		id: `repo:${rootPath}`,
		provider,
		input: undefined!,
		dispose: () => { }
	} satisfies ISCMRepository;
}

function createScmService(): Pick<ISCMService, 'getRepository'> {
	return {
		getRepository: () => undefined
	};
}

function createWorkspaceContextService(folderPath: string): IWorkspaceContextService {
	const workspaceFolder = new WorkspaceFolder({
		uri: URI.file(folderPath),
		index: 0,
		name: folderPath.split('/').at(-1) ?? folderPath
	});

	return {
		_serviceBrand: undefined,
		onDidChangeWorkspaceFolders: Event.None,
		onDidChangeWorkbenchState: Event.None,
		onDidChangeWorkspaceName: Event.None,
		onWillChangeWorkspaceFolders: Event.None,
		getCompleteWorkspace: async () => new Workspace('test-workspace', [workspaceFolder], false, null, uri => extUri.ignorePathCasing(uri)),
		getWorkspace: () => new Workspace('test-workspace', [workspaceFolder], false, null, uri => extUri.ignorePathCasing(uri)),
		getWorkbenchState: () => WorkbenchState.FOLDER,
		getWorkspaceFolder: resource => extUri.isEqualOrParent(resource, workspaceFolder.uri) ? workspaceFolder : null,
		isCurrentWorkspace: workspaceIdOrFolder => URI.isUri(workspaceIdOrFolder) && extUri.isEqual(workspaceIdOrFolder, workspaceFolder.uri),
		isInsideWorkspace: resource => extUri.isEqualOrParent(resource, workspaceFolder.uri),
		hasWorkspaceData: () => true
	} satisfies IWorkspaceContextService;
}

function createUriIdentityService(): IUriIdentityService {
	return {
		_serviceBrand: undefined,
		extUri,
		asCanonicalUri: uri => uri
	} satisfies IUriIdentityService;
}
