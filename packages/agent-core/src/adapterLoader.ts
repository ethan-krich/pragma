/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ethan Krich. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
	AgentAdapter,
	AgentAdapterConstructor,
	AgentAdapterModule,
	AgentAdapterPackageLoadOptions,
	AgentAdapterPackageReference,
} from './types.js';
import { AgentValidationError } from './errors.js';
const BUILTIN_ADAPTER_PREFIX = '@pragma/adapter-';
const BUILTIN_PACKAGE_PREFIX = '@pragma/agent-adapter-';

interface AgentAdapterPackageManifest {
	readonly name?: string;
	readonly main?: string;
	readonly module?: string;
	readonly exports?: string | Record<string, unknown>;
}

interface ResolvedAdapterPackage {
	readonly packageJsonPath: string;
	readonly entryPointPath: string;
}

export async function loadAdaptersFromPackages(
	references: readonly AgentAdapterPackageReference[],
	options: AgentAdapterPackageLoadOptions = {},
): Promise<readonly AgentAdapter[]> {
	return Promise.all(references.map(reference => loadAdapterFromPackage(reference, options)));
}

export async function loadAdapterFromPackage(
	reference: AgentAdapterPackageReference,
	options: AgentAdapterPackageLoadOptions = {},
): Promise<AgentAdapter> {
	const cwd = path.resolve(options.cwd ?? process.cwd());
	const resolved = await resolveAdapterPackage(reference, cwd);
	const entryPointUrl = pathToFileURL(resolved.entryPointPath).href;
	let adapterModule: AgentAdapterModule;
	try {
		adapterModule = await import(entryPointUrl) as AgentAdapterModule;
	} catch (error) {
		throw new AgentValidationError(`Unable to import adapter package "${reference}" from "${resolved.entryPointPath}": ${String(error)}`);
	}

	const Adapter = getAdapterConstructor(reference, adapterModule);
	let adapter: AgentAdapter;
	try {
		adapter = new Adapter();
	} catch (error) {
		throw new AgentValidationError(`Unable to instantiate adapter package "${reference}": ${String(error)}`);
	}

	if (!isAgentAdapter(adapter)) {
		throw new AgentValidationError(`Adapter package "${reference}" did not produce a valid AgentAdapter instance.`);
	}

	return adapter;
}

async function resolveAdapterPackage(reference: AgentAdapterPackageReference, cwd: string): Promise<ResolvedAdapterPackage> {
	if (isPackageJsonReference(reference)) {
		const packageJsonPath = toPackageJsonPath(reference, cwd);
		const manifest = await readPackageManifest(packageJsonPath, reference);
		return {
			packageJsonPath,
			entryPointPath: resolveEntryPointPath(manifest, packageJsonPath, reference),
		};
	}

	const specifier = normalizeSpecifier(reference);
	const packageJsonPath = await resolveInstalledPackageJsonPath(specifier, cwd, reference);
	const manifest = await readPackageManifest(packageJsonPath, reference);
	return {
		packageJsonPath,
		entryPointPath: resolveEntryPointPath(manifest, packageJsonPath, reference),
	};
}

function normalizeSpecifier(reference: string): string {
	if (reference.startsWith(BUILTIN_ADAPTER_PREFIX)) {
		return `${BUILTIN_PACKAGE_PREFIX}${reference.slice(BUILTIN_ADAPTER_PREFIX.length)}`;
	}
	return reference;
}

function isPackageJsonReference(reference: string): boolean {
	return reference.endsWith('.json')
		|| reference.startsWith('.')
		|| reference.startsWith('/')
		|| reference.startsWith('file:');
}

function toPackageJsonPath(reference: string, cwd: string): string {
	if (reference.startsWith('file:')) {
		return fileURLToPath(reference);
	}
	return path.resolve(cwd, reference);
}

async function readPackageManifest(packageJsonPath: string, reference: string): Promise<AgentAdapterPackageManifest> {
	try {
		await access(packageJsonPath);
		const raw = await readFile(packageJsonPath, 'utf8');
		return JSON.parse(raw) as AgentAdapterPackageManifest;
	} catch (error) {
		throw new AgentValidationError(`Unable to read adapter package manifest "${reference}" at "${packageJsonPath}": ${String(error)}`);
	}
}

function resolveEntryPointPath(
	manifest: AgentAdapterPackageManifest,
	packageJsonPath: string,
	reference: string,
): string {
	const packageRoot = path.dirname(packageJsonPath);
	const exportTarget = getImportExportTarget(manifest.exports);
	const candidate = exportTarget ?? manifest.module ?? manifest.main;
	if (!candidate) {
		throw new AgentValidationError(`Adapter package "${reference}" does not expose an import entry point.`);
	}
	return path.resolve(packageRoot, candidate);
}

function getImportExportTarget(exportsField: AgentAdapterPackageManifest['exports']): string | undefined {
	if (typeof exportsField === 'string') {
		return exportsField;
	}
	if (!exportsField || typeof exportsField !== 'object') {
		return undefined;
	}

	const rootExport = '.' in exportsField ? exportsField['.'] : exportsField;
	return getStringExportTarget(rootExport);
}

function getStringExportTarget(target: unknown): string | undefined {
	if (typeof target === 'string') {
		return target;
	}
	if (!target || typeof target !== 'object') {
		return undefined;
	}

	const record = target as Record<string, unknown>;
	return getStringExportTarget(record.import)
		?? getStringExportTarget(record.default)
		?? getStringExportTarget(record.node)
		?? getStringExportTarget(record.module)
		?? getStringExportTarget(record.require);
}

async function resolveInstalledPackageJsonPath(specifier: string, cwd: string, reference: string): Promise<string> {
	let currentDirectory = cwd;
	while (true) {
		const candidate = path.join(currentDirectory, 'node_modules', ...specifier.split('/'), 'package.json');
		try {
			await access(candidate);
			return candidate;
		} catch {
			// Keep walking upward to mirror Node's package lookup behavior.
		}

		const parentDirectory = path.dirname(currentDirectory);
		if (parentDirectory === currentDirectory) {
			break;
		}
		currentDirectory = parentDirectory;
	}

	throw new AgentValidationError(`Unable to resolve adapter package "${reference}" from "${cwd}".`);
}

function getAdapterConstructor(reference: string, adapterModule: AgentAdapterModule): AgentAdapterConstructor {
	const Adapter = adapterModule.Adapter ?? adapterModule.default;
	if (typeof Adapter !== 'function') {
		throw new AgentValidationError(`Adapter package "${reference}" must export an adapter class as "Adapter" or as the default export.`);
	}
	return Adapter;
}

function isAgentAdapter(value: AgentAdapter): boolean {
	return typeof value.id === 'string'
		&& typeof value.provider === 'string'
		&& typeof value.displayName === 'string'
		&& typeof value.listModels === 'function'
		&& typeof value.listSessions === 'function'
		&& typeof value.createSession === 'function'
		&& typeof value.sendMessage === 'function';
}
