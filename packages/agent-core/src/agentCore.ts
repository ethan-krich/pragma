/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ethan Krich. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
	AgentAdapter,
	AgentAdapterCheckpoint,
	AgentAdapterPackageLoadOptions,
	AgentAdapterPackageReference,
	AgentAdapterRun,
	AgentAdapterSessionSummary,
	AgentAttachment,
	AgentChatSummary,
	AgentChatTranscript,
	AgentCheckpoint,
	AgentCreateSessionRequest,
	AgentModelDescriptor,
	AgentReasoningOption,
	AgentRunHandle,
	AgentRunSummary,
	AgentSessionDefaults,
	AgentSessionSummary,
	AgentStandardCommandId,
	AgentStreamEvent,
	AgentTerminalCommandRequest,
	AgentTurnOptions,
} from './types.js';
import { AgentCapabilityError, AgentCommandError, AgentNotFoundError, AgentValidationError } from './errors.js';
import { loadAdaptersFromPackages } from './adapterLoader.js';

class AgentCapabilityRegistry {
	public constructor(private readonly adapters: Map<string, AgentAdapter>) { }

	public async listModels(adapterId?: string): Promise<readonly AgentModelDescriptor[]> {
		if (adapterId) {
			return this.normalizeModels(adapterId, await this.getAdapter(adapterId).listModels());
		}

		const models = await Promise.all(
			Array.from(this.adapters.values()).map(async adapter => this.normalizeModels(adapter.id, await adapter.listModels())),
		);
		return models.flat();
	}

	public async listReasoningOptions(adapterId: string, modelId?: string): Promise<readonly AgentReasoningOption[]> {
		return this.getAdapter(adapterId).listReasoningOptions(modelId);
	}

	public async validateTurnOptions(adapterId: string, defaults: AgentSessionDefaults, options?: AgentTurnOptions): Promise<AgentSessionDefaults> {
		const merged: AgentSessionDefaults = {
			modelId: options?.modelId ?? defaults.modelId,
			reasoningEffort: options?.reasoningEffort ?? defaults.reasoningEffort,
		};
		const models = await this.listModels(adapterId);
		const selectedModel = merged.modelId ? models.find(model => model.id === merged.modelId) : models.find(model => model.isDefault);
		if (merged.modelId && !selectedModel) {
			throw new AgentValidationError(`Unknown model "${merged.modelId}" for adapter "${adapterId}".`);
		}
		if (merged.reasoningEffort) {
			const available = selectedModel?.availableReasoningEfforts.length
				? selectedModel.availableReasoningEfforts
				: (await this.listReasoningOptions(adapterId, selectedModel?.id)).map(option => option.id);
			if (!available.includes(merged.reasoningEffort)) {
				throw new AgentValidationError(`Unknown reasoning effort "${merged.reasoningEffort}" for adapter "${adapterId}".`);
			}
		}
		return merged;
	}

	private getAdapter(adapterId: string): AgentAdapter {
		const adapter = this.adapters.get(adapterId);
		if (!adapter) {
			throw new AgentNotFoundError(`Unknown adapter "${adapterId}".`);
		}
		return adapter;
	}

	private normalizeModels(adapterId: string, models: readonly AgentModelDescriptor[]): readonly AgentModelDescriptor[] {
		return models.map(model => ({ ...model, adapterId }));
	}
}

class AgentCommandRegistry {
	public getNativeCommand(adapter: AgentAdapter, commandId: AgentStandardCommandId): string {
		const mappedCommand = adapter.getStandardCommandMappings?.()[commandId];
		if (!mappedCommand) {
			throw new AgentCommandError(`Adapter "${adapter.id}" does not expose a mapping for command "${commandId}".`);
		}
		return mappedCommand;
	}
}

class AgentSessionDirectory {
	public normalizeSession(adapterId: string, session: AgentAdapterSessionSummary): AgentSessionSummary {
		return {
			id: this.toCoreSessionId(adapterId, session.id),
			adapterId,
			nativeSessionId: session.id,
			title: session.title,
			createdAt: session.createdAt,
			updatedAt: session.updatedAt,
			archivedAt: session.archivedAt,
			defaults: session.defaults,
		};
	}

	public toCoreSessionId(adapterId: string, nativeSessionId: string): string {
		return `${adapterId}:${nativeSessionId}`;
	}

	public fromCoreSessionId(sessionId: string): { adapterId: string; nativeSessionId: string } {
		const separatorIndex = sessionId.indexOf(':');
		if (separatorIndex === -1) {
			throw new AgentValidationError(`Invalid session id "${sessionId}".`);
		}
		return {
			adapterId: sessionId.slice(0, separatorIndex),
			nativeSessionId: sessionId.slice(separatorIndex + 1),
		};
	}
}

class AgentCheckpointStore {
	public toCoreCheckpointId(coreSessionId: string, nativeCheckpointId: string): string {
		return `${coreSessionId}#checkpoint:${nativeCheckpointId}`;
	}

	public fromCoreCheckpointId(coreSessionId: string, checkpointId: string): string {
		const prefix = `${coreSessionId}#checkpoint:`;
		if (!checkpointId.startsWith(prefix)) {
			throw new AgentValidationError(`Checkpoint "${checkpointId}" does not belong to session "${coreSessionId}".`);
		}
		return checkpointId.slice(prefix.length);
	}

	public normalizeCheckpoint(coreSessionId: string, checkpoint: AgentAdapterCheckpoint): AgentCheckpoint {
		return {
			id: this.toCoreCheckpointId(coreSessionId, checkpoint.id),
			sessionId: coreSessionId,
			chatId: checkpoint.chatId,
			createdAt: checkpoint.createdAt,
			label: checkpoint.label,
			transcript: {
				sessionId: coreSessionId,
				chatId: checkpoint.transcript.chatId,
				messages: checkpoint.transcript.messages,
			},
			native: checkpoint.native,
		};
	}
}

interface ActiveRunRecord {
	readonly adapterId: string;
	readonly nativeSessionId: string;
	readonly nativeRunId: string;
}

export class AgentCore {
	private readonly adapters = new Map<string, AgentAdapter>();
	private readonly capabilityRegistry = new AgentCapabilityRegistry(this.adapters);
	private readonly commandRegistry = new AgentCommandRegistry();
	private readonly sessionDirectory = new AgentSessionDirectory();
	private readonly checkpointStore = new AgentCheckpointStore();
	private readonly activeRuns = new Map<string, ActiveRunRecord>();

	public registerAdapter(adapter: AgentAdapter): void {
		if (this.adapters.has(adapter.id)) {
			throw new AgentValidationError(`Adapter "${adapter.id}" is already registered.`);
		}
		this.adapters.set(adapter.id, adapter);
	}

	public async registerAdapterPackages(
		references: readonly AgentAdapterPackageReference[],
		options?: AgentAdapterPackageLoadOptions,
	): Promise<readonly AgentAdapter[]> {
		const adapters = await loadAdaptersFromPackages(references, options);
		for (const adapter of adapters) {
			this.registerAdapter(adapter);
		}
		return adapters;
	}

	public static async fromAdapterPackages(
		references: readonly AgentAdapterPackageReference[],
		options?: AgentAdapterPackageLoadOptions,
	): Promise<AgentCore> {
		const core = new AgentCore();
		await core.registerAdapterPackages(references, options);
		return core;
	}

	public getAdapter(adapterId: string): AgentAdapter {
		const adapter = this.adapters.get(adapterId);
		if (!adapter) {
			throw new AgentNotFoundError(`Unknown adapter "${adapterId}".`);
		}
		return adapter;
	}

	public listAdapters(): readonly AgentAdapter[] {
		return Array.from(this.adapters.values());
	}

	public listModels(adapterId?: string): Promise<readonly AgentModelDescriptor[]> {
		return this.capabilityRegistry.listModels(adapterId);
	}

	public listReasoningOptions(adapterId: string, modelId?: string): Promise<readonly AgentReasoningOption[]> {
		return this.capabilityRegistry.listReasoningOptions(adapterId, modelId);
	}

	public async createSession(adapterId: string, request: AgentCreateSessionRequest = {}): Promise<AgentSessionSummary> {
		const defaults = await this.capabilityRegistry.validateTurnOptions(adapterId, {}, request.defaults);
		const session = await this.getAdapter(adapterId).createSession({ ...request, defaults });
		return this.sessionDirectory.normalizeSession(adapterId, session);
	}

	public async resumeSession(sessionId: string): Promise<AgentSessionSummary> {
		return this.getSession(sessionId);
	}

	public async deleteSession(sessionId: string): Promise<void> {
		const { adapterId, nativeSessionId } = this.sessionDirectory.fromCoreSessionId(sessionId);
		await this.getAdapter(adapterId).deleteSession(nativeSessionId);
	}

	public async archiveSession(sessionId: string): Promise<void> {
		const { adapterId, nativeSessionId } = this.sessionDirectory.fromCoreSessionId(sessionId);
		await this.getAdapter(adapterId).archiveSession(nativeSessionId);
	}

	public async listSessions(adapterId?: string): Promise<readonly AgentSessionSummary[]> {
		if (adapterId) {
			return this.listSessionsForAdapter(this.getAdapter(adapterId));
		}
		const sessions = await Promise.all(this.listAdapters().map(adapter => this.listSessionsForAdapter(adapter)));
		return sessions.flat();
	}

	public async getSession(sessionId: string): Promise<AgentSessionSummary> {
		const { adapterId, nativeSessionId } = this.sessionDirectory.fromCoreSessionId(sessionId);
		const session = await this.getAdapter(adapterId).getSession(nativeSessionId);
		if (!session) {
			throw new AgentNotFoundError(`Unknown session "${sessionId}".`);
		}
		return this.sessionDirectory.normalizeSession(adapterId, session);
	}

	public async listChats(sessionId: string): Promise<readonly AgentChatSummary[]> {
		const { adapterId, nativeSessionId } = this.sessionDirectory.fromCoreSessionId(sessionId);
		return this.getAdapter(adapterId).listChats(nativeSessionId);
	}

	public async getChatTranscript(sessionId: string, chatId?: string): Promise<AgentChatTranscript> {
		const { adapterId, nativeSessionId } = this.sessionDirectory.fromCoreSessionId(sessionId);
		const transcript = await this.getAdapter(adapterId).getChatTranscript(nativeSessionId, chatId);
		return {
			sessionId,
			chatId: transcript.chatId,
			messages: transcript.messages,
		};
	}

	public async getSessionDefaults(sessionId: string): Promise<AgentSessionDefaults> {
		const { adapterId, nativeSessionId } = this.sessionDirectory.fromCoreSessionId(sessionId);
		return this.getAdapter(adapterId).getSessionDefaults(nativeSessionId);
	}

	public async updateSessionDefaults(sessionId: string, defaults: Partial<AgentSessionDefaults>): Promise<AgentSessionDefaults> {
		const { adapterId, nativeSessionId } = this.sessionDirectory.fromCoreSessionId(sessionId);
		const currentDefaults = await this.getAdapter(adapterId).getSessionDefaults(nativeSessionId);
		const validated = await this.capabilityRegistry.validateTurnOptions(adapterId, currentDefaults, defaults);
		return this.getAdapter(adapterId).updateSessionDefaults(nativeSessionId, validated);
	}

	public async sendMessage(sessionId: string, content: string, options?: AgentTurnOptions): Promise<AgentRunHandle> {
		const { adapterId, nativeSessionId } = this.sessionDirectory.fromCoreSessionId(sessionId);
		const adapter = this.getAdapter(adapterId);
		const defaults = await adapter.getSessionDefaults(nativeSessionId);
		const resolvedDefaults = await this.capabilityRegistry.validateTurnOptions(adapterId, defaults, options);
		const attachments = await this.resolveAttachments(content, options);
		const run = await adapter.sendMessage(nativeSessionId, {
			content,
			options: {
				...options,
				attachments,
				modelId: resolvedDefaults.modelId,
				reasoningEffort: resolvedDefaults.reasoningEffort,
			},
		});
		return this.wrapRun(sessionId, adapterId, nativeSessionId, run);
	}

	public async editMessage(sessionId: string, chatId: string, messageId: string, content: string, options?: AgentTurnOptions): Promise<AgentRunHandle> {
		const { adapterId, nativeSessionId } = this.sessionDirectory.fromCoreSessionId(sessionId);
		const adapter = this.getAdapter(adapterId);
		await adapter.truncateConversation(nativeSessionId, chatId, messageId);
		return this.sendMessage(sessionId, content, options);
	}

	public async resendMessage(sessionId: string, chatId: string, messageId: string, options?: AgentTurnOptions): Promise<AgentRunHandle> {
		const transcript = await this.getChatTranscript(sessionId, chatId);
		const targetMessage = transcript.messages.find(message => message.id === messageId);
		if (!targetMessage) {
			throw new AgentNotFoundError(`Unknown message "${messageId}" in chat "${chatId}".`);
		}
		const text = targetMessage.parts
			.filter(part => part.kind === 'text')
			.map(part => part.text)
			.join('');
		return this.editMessage(sessionId, chatId, messageId, text, options);
	}

	public async interrupt(sessionId: string, runId: string): Promise<void> {
		const record = this.getActiveRun(runId, sessionId);
		await this.getAdapter(record.adapterId).interrupt(record.nativeSessionId, record.nativeRunId);
	}

	public async createCheckpoint(sessionId: string, chatId?: string, label?: string): Promise<AgentCheckpoint> {
		const { adapterId, nativeSessionId } = this.sessionDirectory.fromCoreSessionId(sessionId);
		const checkpoint = await this.getAdapter(adapterId).createCheckpoint(nativeSessionId, chatId, label);
		return this.checkpointStore.normalizeCheckpoint(sessionId, checkpoint);
	}

	public async listCheckpoints(sessionId: string): Promise<readonly AgentCheckpoint[]> {
		const { adapterId, nativeSessionId } = this.sessionDirectory.fromCoreSessionId(sessionId);
		const checkpoints = await this.getAdapter(adapterId).listCheckpoints(nativeSessionId);
		return checkpoints.map(checkpoint => this.checkpointStore.normalizeCheckpoint(sessionId, checkpoint));
	}

	public async revertToCheckpoint(sessionId: string, checkpointId: string): Promise<AgentCheckpoint> {
		const { adapterId, nativeSessionId } = this.sessionDirectory.fromCoreSessionId(sessionId);
		const nativeCheckpointId = this.checkpointStore.fromCoreCheckpointId(sessionId, checkpointId);
		const checkpoint = await this.getAdapter(adapterId).revertToCheckpoint(nativeSessionId, nativeCheckpointId);
		return this.checkpointStore.normalizeCheckpoint(sessionId, checkpoint);
	}

	public async runStandardCommand(sessionId: string, commandId: AgentStandardCommandId, options?: AgentTurnOptions): Promise<AgentRunHandle> {
		const { adapterId } = this.sessionDirectory.fromCoreSessionId(sessionId);
		const adapter = this.getAdapter(adapterId);
		const command = this.commandRegistry.getNativeCommand(adapter, commandId);
		return this.runPassthroughCommand(sessionId, command, options);
	}

	public async runPassthroughCommand(sessionId: string, command: string, options?: AgentTurnOptions): Promise<AgentRunHandle> {
		const { adapterId, nativeSessionId } = this.sessionDirectory.fromCoreSessionId(sessionId);
		const adapter = this.getAdapter(adapterId);
		if (!adapter.capabilities.supportsPassthroughCommands) {
			throw new AgentCapabilityError(`Adapter "${adapterId}" does not support passthrough commands.`);
		}
		const defaults = await adapter.getSessionDefaults(nativeSessionId);
		const resolvedDefaults = await this.capabilityRegistry.validateTurnOptions(adapterId, defaults, options);
		const run = await adapter.executeCommand(nativeSessionId, { command }, {
			...options,
			modelId: resolvedDefaults.modelId,
			reasoningEffort: resolvedDefaults.reasoningEffort,
		});
		return this.wrapRun(sessionId, adapterId, nativeSessionId, run);
	}

	public async submitCommandInput(sessionId: string, runId: string, input: string): Promise<void> {
		const record = this.getActiveRun(runId, sessionId);
		await this.getAdapter(record.adapterId).submitCommandInput(record.nativeSessionId, record.nativeRunId, input);
	}

	public async executeTerminalCommand(sessionId: string, request: AgentTerminalCommandRequest): Promise<AgentRunHandle> {
		const { adapterId, nativeSessionId } = this.sessionDirectory.fromCoreSessionId(sessionId);
		const adapter = this.getAdapter(adapterId);
		if (!adapter.capabilities.supportsTerminalCommands) {
			throw new AgentCapabilityError(`Adapter "${adapterId}" does not support terminal commands.`);
		}
		const run = await adapter.executeTerminalCommand(nativeSessionId, request);
		return this.wrapRun(sessionId, adapterId, nativeSessionId, run);
	}

	private async listSessionsForAdapter(adapter: AgentAdapter): Promise<readonly AgentSessionSummary[]> {
		const sessions = await adapter.listSessions();
		return sessions.map(session => this.sessionDirectory.normalizeSession(adapter.id, session));
	}

	private async resolveAttachments(content: string, options?: AgentTurnOptions): Promise<readonly AgentAttachment[] | undefined> {
		const configuredAttachments = [...(options?.attachments ?? [])];
		const mentionAttachments = await this.resolveFileMentions(content, options?.metadata?.cwd);
		if (mentionAttachments.length === 0) {
			return configuredAttachments.length ? configuredAttachments : undefined;
		}

		const seen = new Set(
			configuredAttachments
				.filter(attachment => attachment.kind === 'file' && attachment.uri)
				.map(attachment => attachment.uri!),
		);

		for (const attachment of mentionAttachments) {
			if (!attachment.uri || seen.has(attachment.uri)) {
				continue;
			}
			seen.add(attachment.uri);
			configuredAttachments.push(attachment);
		}

		return configuredAttachments;
	}

	private async resolveFileMentions(content: string, cwdFromMetadata?: string): Promise<readonly AgentAttachment[]> {
		const cwd = cwdFromMetadata ? path.resolve(cwdFromMetadata) : process.cwd();
		const mentions = this.parseFileMentions(content);
		const dedupedMentions = [...new Set(mentions)];
		const attachments = await Promise.all(dedupedMentions.map(async mention => {
			const absolutePath = path.isAbsolute(mention) ? mention : path.resolve(cwd, mention);
			let fileContent: string;
			try {
				fileContent = await readFile(absolutePath, 'utf8');
			} catch (error) {
				throw new AgentValidationError(`Unable to resolve mentioned file "${mention}" from "${cwd}": ${String(error)}`);
			}
			return {
				kind: 'file' as const,
				name: path.basename(absolutePath),
				uri: absolutePath,
				content: fileContent,
				metadata: {
					path: absolutePath,
					mention: mention,
				},
			};
		}));
		return attachments;
	}

	private parseFileMentions(content: string): readonly string[] {
		const mentions: string[] = [];
		const mentionPattern = /(^|\s)@(?:"([^"]+)"|'([^']+)'|([^\s"'`]+))/gu;
		for (const match of content.matchAll(mentionPattern)) {
			const mention = match[2] ?? match[3] ?? match[4];
			if (!mention) {
				continue;
			}
			if (mention.includes('@')) {
				continue;
			}
			mentions.push(mention);
		}
		return mentions;
	}

	private wrapRun(coreSessionId: string, adapterId: string, nativeSessionId: string, run: AgentAdapterRun): AgentRunHandle {
		const coreRunId = `${coreSessionId}#run:${run.runId}`;
		this.activeRuns.set(coreRunId, { adapterId, nativeSessionId, nativeRunId: run.runId });

		return {
			runId: coreRunId,
			stream: this.normalizeStream(coreRunId, coreSessionId, run.stream),
			result: run.result.then(summary => this.normalizeSummary(coreRunId, coreSessionId, adapterId, summary)).finally(() => {
				this.activeRuns.delete(coreRunId);
			}),
			interrupt: async () => this.interrupt(coreSessionId, coreRunId),
		};
	}

	private async *normalizeStream(coreRunId: string, coreSessionId: string, stream: AsyncIterable<AgentStreamEvent>): AsyncIterable<AgentStreamEvent> {
		for await (const event of stream) {
			yield this.normalizeEvent(coreRunId, coreSessionId, event);
		}
	}

	private normalizeEvent(coreRunId: string, coreSessionId: string, event: AgentStreamEvent): AgentStreamEvent {
		const result = { ...event } as Record<string, unknown>;
		if (typeof result.runId === 'string') {
			result.runId = coreRunId;
		}
		if (typeof result.sessionId === 'string') {
			result.sessionId = coreSessionId;
		}
		if (result.type === 'run.completed' || result.type === 'run.failed' || result.type === 'run.interrupted') {
			result.summary = this.normalizeSummary(coreRunId, coreSessionId, String((event as { summary: AgentRunSummary }).summary.adapterId), (event as { summary: AgentRunSummary }).summary);
		}
		return result as AgentStreamEvent;
	}

	private normalizeSummary(coreRunId: string, coreSessionId: string, adapterId: string, summary: AgentRunSummary): AgentRunSummary {
		return {
			...summary,
			id: coreRunId,
			sessionId: coreSessionId,
			adapterId,
		};
	}

	private getActiveRun(runId: string, sessionId: string): ActiveRunRecord {
		const record = this.activeRuns.get(runId);
		if (!record || this.sessionDirectory.toCoreSessionId(record.adapterId, record.nativeSessionId) !== sessionId) {
			throw new AgentNotFoundError(`Unknown run "${runId}" for session "${sessionId}".`);
		}
		return record;
	}
}
