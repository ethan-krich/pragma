/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ethan Krich. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import 'mocha';
import codeCompletionSpec from '../../completions/code';
import { testPaths, type ISuiteSpec, type ITestSpec } from '../helpers';
import codeInsidersCompletionSpec from '../../completions/code-insiders';

export const codeSpecOptionsAndSubcommands = [
	'-a <folder>',
	'-d <file> <file>',
	'-g <file:line[:character]>',
	'-h',
	'-m <file> <file> <base> <result>',
	'-n',
	'-r',
	'-s',
	'-v',
	'-w',
	'-',
	'--add <folder>',
	'--add-mcp <json>',
	'--category <category>',
	'--diff <file> <file>',
	'--disable-chromium-sandbox',
	'--disable-extension <extension-id>',
	'--disable-extensions',
	'--disable-gpu',
	'--disable-lcd-text',
	'--enable-proposed-api <extension-id>',
	'--extensions-dir <dir>',
	'--goto <file:line[:character]>',
	'--help',
	'--inspect-brk-extensions <port>',
	'--inspect-extensions <port>',
	'--install-extension <extension-id[@version] | path-to-vsix>',
	'--list-extensions',
	'--locale <locale>',
	'--locate-shell-integration-path <shell>',
	'--log <level>',
	'--max-memory <memory>',
	'--merge <file> <file> <base> <result>',
	'--new-window',
	'--pre-release',
	'--prof-startup',
	'--profile <profileName>',
	'--remove <folder>',
	'--reuse-window',
	'--show-versions',
	'--status',
	'--sync <sync>',
	'--telemetry',
	'--transient',
	'--uninstall-extension <extension-id>',
	'--update-extensions',
	'--user-data-dir <dir>',
	'--verbose',
	'--version',
	'--wait',
	'serve-web',
	'help',
	'status',
	'version'
];

export function createCodeTestSpecs(executable: string): ITestSpec[] {
	const localeOptions = ['bg', 'de', 'en', 'es', 'fr', 'hu', 'it', 'ja', 'ko', 'pt-br', 'ru', 'tr', 'zh-CN', 'zh-TW'];
	const categoryOptions = ['azure', 'data science', 'debuggers', 'extension packs', 'education', 'formatters', 'keymaps', 'language packs', 'linters', 'machine learning', 'notebooks', 'programming languages', 'scm providers', 'snippets', 'testing', 'themes', 'visualization', 'other'];
	const logOptions = ['critical', 'error', 'warn', 'info', 'debug', 'trace', 'off'];
	const syncOptions = ['on', 'off'];

	const typingTests: ITestSpec[] = [];
	for (let i = 1; i < executable.length; i++) {
		const expectedCompletions = [{ label: executable, description: executable === codeCompletionSpec.name ? (codeCompletionSpec as Fig.Subcommand).description : (codeInsidersCompletionSpec as Fig.Subcommand).description }];
		const input = `${executable.slice(0, i)}|`;
		typingTests.push({ input, expectedCompletions, expectedResourceRequests: input.endsWith(' ') ? undefined : { type: 'both', cwd: testPaths.cwd } });
	}

	return [
		// Typing the command
		...typingTests,

		// Basic arguments
		{ input: `${executable} |`, expectedCompletions: codeSpecOptionsAndSubcommands, expectedResourceRequests: { type: 'both', cwd: testPaths.cwd } },
		// Test for --remove
		{ input: `${executable} --remove |`, expectedResourceRequests: { type: 'folders', cwd: testPaths.cwd } },
		// Test for --add-mcp
		{ input: `${executable} --add-mcp |`, expectedCompletions: [] },
		// Test for --update-extensions
		{ input: `${executable} --update-extensions |`, expectedCompletions: codeSpecOptionsAndSubcommands.filter(c => c !== '--update-extensions'), expectedResourceRequests: { type: 'both', cwd: testPaths.cwd } },
		// Test for --disable-lcd-text
		{ input: `${executable} --disable-lcd-text |`, expectedCompletions: codeSpecOptionsAndSubcommands.filter(c => c !== '--disable-lcd-text'), expectedResourceRequests: { type: 'both', cwd: testPaths.cwd } },
		// Test for --disable-chromium-sandbox
		{ input: `${executable} --disable-chromium-sandbox |`, expectedCompletions: codeSpecOptionsAndSubcommands.filter(c => c !== '--disable-chromium-sandbox'), expectedResourceRequests: { type: 'both', cwd: testPaths.cwd } },
		// Test for --enable-proposed-api variadic
		{ input: `${executable} --enable-proposed-api |`, expectedCompletions: [executable] },
		// Test for --log repeatable and extension-specific
		{ input: `${executable} --log |`, expectedCompletions: logOptions },
		{ input: `${executable} --locale |`, expectedCompletions: localeOptions },
		{ input: `${executable} --diff |`, expectedResourceRequests: { type: 'files', cwd: testPaths.cwd } },
		{ input: `${executable} --diff ./file1 |`, expectedResourceRequests: { type: 'files', cwd: testPaths.cwd } },
		{ input: `${executable} --merge |`, expectedResourceRequests: { type: 'files', cwd: testPaths.cwd } },
		{ input: `${executable} --merge ./file1 ./file2 |`, expectedResourceRequests: { type: 'files', cwd: testPaths.cwd } },
		{ input: `${executable} --merge ./file1 ./file2 ./base |`, expectedResourceRequests: { type: 'files', cwd: testPaths.cwd } },
		{ input: `${executable} --goto |`, expectedResourceRequests: { type: 'files', cwd: testPaths.cwd } },
		{ input: `${executable} --user-data-dir |`, expectedResourceRequests: { type: 'folders', cwd: testPaths.cwd } },
		{ input: `${executable} --profile |` },
		{ input: `${executable} --install-extension |`, expectedCompletions: [executable], expectedResourceRequests: { type: 'both', cwd: testPaths.cwd } },
		{ input: `${executable} --uninstall-extension |`, expectedCompletions: [executable] },
		{ input: `${executable} --disable-extension |`, expectedCompletions: [executable] },
		{ input: `${executable} --log |`, expectedCompletions: logOptions },
		{ input: `${executable} --sync |`, expectedCompletions: syncOptions },
		{ input: `${executable} --extensions-dir |`, expectedResourceRequests: { type: 'folders', cwd: testPaths.cwd } },
		{ input: `${executable} --list-extensions |`, expectedCompletions: codeSpecOptionsAndSubcommands.filter(c => c !== '--list-extensions'), expectedResourceRequests: { type: 'both', cwd: testPaths.cwd } },
		{ input: `${executable} --show-versions |`, expectedCompletions: codeSpecOptionsAndSubcommands.filter(c => c !== '--show-versions'), expectedResourceRequests: { type: 'both', cwd: testPaths.cwd } },
		{ input: `${executable} --category |`, expectedCompletions: categoryOptions },
		{ input: `${executable} --category a|`, expectedCompletions: categoryOptions },

		// Middle of command
		{ input: `${executable} | --locale`, expectedCompletions: codeSpecOptionsAndSubcommands, expectedResourceRequests: { type: 'both', cwd: testPaths.cwd } },
	];
}

export const codeTestSuite: ISuiteSpec = {
	name: 'code',
	completionSpecs: codeCompletionSpec,
	availableCommands: 'code',
	testSpecs: createCodeTestSpecs('code')
};
