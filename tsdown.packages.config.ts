/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ethan Krich. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { defineConfig } from 'tsdown';

const sharedConfig = {
	entry: ['./src/index.ts'],
	format: ['esm', 'cjs'] as const,
	dts: true,
	platform: 'node' as const,
	target: 'node20',
	outDir: 'dist',
	clean: true,
	sourcemap: false,
	tsconfig: './tsconfig.json',
};

export default defineConfig([
	{
		...sharedConfig,
		name: '@pragma/agent-core',
		cwd: './packages/agent-core',
	},
	{
		...sharedConfig,
		name: '@pragma/agent-adapter-claude-code',
		cwd: './packages/agent-adapter-claude-code',
	},
	{
		...sharedConfig,
		name: '@pragma/agent-adapter-codex',
		cwd: './packages/agent-adapter-codex',
	},
]);
