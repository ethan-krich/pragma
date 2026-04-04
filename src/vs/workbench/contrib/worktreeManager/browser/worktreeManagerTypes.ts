/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ethan Krich. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';

export type WorktreeBranchIconHint = 'branch' | 'code';

export interface IWorktreeBranchEntry {
	readonly branchName: string;
	readonly childBranchCount: number;
	readonly iconHint: WorktreeBranchIconHint;
	readonly worktreePath: URI | undefined;
}

export interface IWorktreeBranchContext {
	readonly canonicalRoot: URI;
	readonly currentRoot: URI;
	readonly currentBranch: string;
	readonly visibleBranch: string;
	readonly isManagedWorktree: boolean;
	readonly linkedWorktreePath: URI | undefined;
	readonly hasLinkedWorktree: boolean;
	readonly isLinkedWorktreeMerged: boolean;
	readonly canStageAll: boolean;
	readonly canCommit: boolean;
	readonly canMerge: boolean;
	readonly canPush: boolean;
	readonly canRecreate: boolean;
	readonly hasUpstream: boolean;
}

export interface IGitWorktreeInfo {
	readonly name: string;
	readonly path: string;
	readonly ref: string;
	readonly main: boolean;
	readonly detached: boolean;
	readonly branchName: string | undefined;
}

export interface IGitBranchBaseInfo {
	readonly name: string;
	readonly isProtected: boolean;
	readonly remote: string | undefined;
	readonly localBranchName: string | undefined;
}

export interface ICreateWorktreeResult {
	readonly path: string;
	readonly branch: string;
	readonly commitish: string;
}

export const enum WorktreeManagerErrorCode {
	BranchNotFound = 'branchNotFound',
	NotAGitRepository = 'notAGitRepository',
	WorktreeNotFound = 'worktreeNotFound',
}

export class WorktreeManagerError extends Error {
	constructor(
		readonly code: WorktreeManagerErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'WorktreeManagerError';
	}
}
