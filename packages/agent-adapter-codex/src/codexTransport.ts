/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ethan Krich. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
	type AgentAdapterCheckpoint,
	type AgentAdapterRun,
	type AgentAdapterSessionSummary,
	type AgentCapabilities,
	type AgentChangedFile,
	type AgentChatSummary,
	type AgentCommandRequest,
	type AgentCreateSessionRequest,
	type AgentMessage,
	type AgentMessagePart,
	type AgentModelDescriptor,
	type AgentQuestionRequest,
	type AgentReasoningOption,
	type AgentRunSummary,
	type AgentSendMessageRequest,
	type AgentSessionDefaults,
	type AgentStreamEvent,
	type AgentTerminalCommandRequest,
} from '@pragma/agent-core';
import {
	Codex,
	type CodexOptions,
	type FileChangeItem,
	type ItemCompletedEvent,
	type ItemStartedEvent,
	type ItemUpdatedEvent,
	type RunStreamedResult,
	type ThreadEvent,
	type ThreadItem,
	type ThreadOptions,
} from '@openai/codex-sdk';

const DEFAULT_CHAT_ID = 'chat-1';

export interface CodexTransportDriver {
	listModels(): Promise<readonly AgentModelDescriptor[]>;
	listReasoningOptions(modelId?: string): Promise<readonly AgentReasoningOption[]>;
	listSessions(): Promise<readonly AgentAdapterSessionSummary[]>;
	getSession(sessionId: string): Promise<AgentAdapterSessionSummary | undefined>;
	createSession(request: AgentCreateSessionRequest): Promise<AgentAdapterSessionSummary>;
	archiveSession(sessionId: string): Promise<void>;
	deleteSession(sessionId: string): Promise<void>;
	listChats(sessionId: string): Promise<readonly AgentChatSummary[]>;
	getChatTranscript(sessionId: string, chatId?: string): Promise<{ sessionId: string; chatId: string; messages: readonly AgentMessage[] }>;
	getSessionDefaults(sessionId: string): Promise<AgentSessionDefaults>;
	updateSessionDefaults(sessionId: string, defaults: Partial<AgentSessionDefaults>): Promise<AgentSessionDefaults>;
	sendMessage(sessionId: string, request: AgentSendMessageRequest): Promise<AgentAdapterRun>;
	executeCommand(sessionId: string, request: AgentCommandRequest): Promise<AgentAdapterRun>;
	submitCommandInput(sessionId: string, runId: string, input: string): Promise<void>;
	executeTerminalCommand(sessionId: string, request: AgentTerminalCommandRequest): Promise<AgentAdapterRun>;
	interrupt(sessionId: string, runId: string): Promise<void>;
	createCheckpoint(sessionId: string, chatId?: string, label?: string): Promise<AgentAdapterCheckpoint>;
	listCheckpoints(sessionId: string): Promise<readonly AgentAdapterCheckpoint[]>;
	revertToCheckpoint(sessionId: string, checkpointId: string): Promise<AgentAdapterCheckpoint>;
	truncateConversation(sessionId: string, chatId: string, messageId: string): Promise<void>;
}

export interface CodexSdkTransportOptions {
	readonly cwd?: string;
	readonly env?: Record<string, string>;
	readonly codexPathOverride?: string;
	readonly config?: CodexOptions['config'];
	readonly sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
	readonly approvalPolicy?: 'never' | 'on-request' | 'on-failure' | 'untrusted';
	readonly networkAccessEnabled?: boolean;
	readonly additionalDirectories?: readonly string[];
	readonly skipGitRepoCheck?: boolean;
	readonly webSearchMode?: 'disabled' | 'cached' | 'live';
	readonly webSearchEnabled?: boolean;
	readonly modelCachePath?: string;
	readonly sessionIndexPath?: string;
}

export interface CodexTransport {
	readonly id: string;
	readonly kind: 'bridge' | 'sdk';
	readonly capabilities?: Partial<AgentCapabilities>;
	isAvailable(): Promise<boolean>;
	listModels(): Promise<readonly AgentModelDescriptor[]>;
	listReasoningOptions(modelId?: string): Promise<readonly AgentReasoningOption[]>;
	listSessions(): Promise<readonly AgentAdapterSessionSummary[]>;
	getSession(sessionId: string): Promise<AgentAdapterSessionSummary | undefined>;
	createSession(request: AgentCreateSessionRequest): Promise<AgentAdapterSessionSummary>;
	archiveSession(sessionId: string): Promise<void>;
	deleteSession(sessionId: string): Promise<void>;
	listChats(sessionId: string): Promise<readonly AgentChatSummary[]>;
	getChatTranscript(sessionId: string, chatId?: string): Promise<{ sessionId: string; chatId: string; messages: readonly AgentMessage[] }>;
	getSessionDefaults(sessionId: string): Promise<AgentSessionDefaults>;
	updateSessionDefaults(sessionId: string, defaults: Partial<AgentSessionDefaults>): Promise<AgentSessionDefaults>;
	sendMessage(sessionId: string, request: AgentSendMessageRequest): Promise<AgentAdapterRun>;
	executeCommand(sessionId: string, request: AgentCommandRequest): Promise<AgentAdapterRun>;
	submitCommandInput(sessionId: string, runId: string, input: string): Promise<void>;
	executeTerminalCommand(sessionId: string, request: AgentTerminalCommandRequest): Promise<AgentAdapterRun>;
	interrupt(sessionId: string, runId: string): Promise<void>;
	createCheckpoint(sessionId: string, chatId?: string, label?: string): Promise<AgentAdapterCheckpoint>;
	listCheckpoints(sessionId: string): Promise<readonly AgentAdapterCheckpoint[]>;
	revertToCheckpoint(sessionId: string, checkpointId: string): Promise<AgentAdapterCheckpoint>;
	truncateConversation(sessionId: string, chatId: string, messageId: string): Promise<void>;
}

interface CodexModelCache {
	readonly models?: ReadonlyArray<{
		readonly slug: string;
		readonly display_name?: string;
		readonly description?: string;
		readonly default_reasoning_level?: string;
		readonly supported_reasoning_levels?: ReadonlyArray<{
			readonly effort: string;
			readonly description?: string;
		}>;
		readonly priority?: number;
	}>;
}

interface CodexSessionIndexEntry {
	readonly id: string;
	readonly thread_name?: string;
	readonly updated_at?: string;
}

interface CodexSessionRecord {
	readonly id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	defaults: AgentSessionDefaults;
	readonly cwd: string;
	archivedAt?: string;
	threadId?: string;
	checkpoints: AgentAdapterCheckpoint[];
	transcript: AgentMessage[];
}

interface ActiveTerminalRun {
	readonly child: ChildProcessWithoutNullStreams;
}

type AvailabilityPredicate = boolean | (() => Promise<boolean>);

class AsyncEventQueue<T> implements AsyncIterable<T> {
	private readonly values: T[] = [];
	private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
	private error: Error | undefined;
	private done = false;

	public push(value: T): void {
		if (this.done) {
			return;
		}
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter({ value, done: false });
			return;
		}
		this.values.push(value);
	}

	public close(): void {
		if (this.done) {
			return;
		}
		this.done = true;
		for (const waiter of this.waiters.splice(0)) {
			waiter({ value: undefined, done: true });
		}
	}

	public fail(error: unknown): void {
		this.error = asError(error);
		this.close();
	}

	public [Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: async (): Promise<IteratorResult<T>> => {
				if (this.values.length > 0) {
					return { value: this.values.shift()!, done: false };
				}
				if (this.error) {
					throw this.error;
				}
				if (this.done) {
					return { value: undefined, done: true };
				}
				return new Promise<IteratorResult<T>>(resolve => this.waiters.push(resolve));
			},
		};
	}
}

class CodexSdkDriver implements CodexTransportDriver {
	private readonly sessions = new Map<string, CodexSessionRecord>();
	private readonly deletedSessions = new Set<string>();
	private readonly activeRuns = new Map<string, AbortController>();
	private readonly activeTerminalRuns = new Map<string, ActiveTerminalRun>();
	private modelCache: readonly AgentModelDescriptor[] | undefined;

	public constructor(private readonly options: CodexSdkTransportOptions = {}) { }

	public async listModels(): Promise<readonly AgentModelDescriptor[]> {
		if (this.modelCache) {
			return this.modelCache;
		}
		const raw = await readJsonFile<CodexModelCache>(this.getModelCachePath());
		const models = (raw?.models ?? []).map((model, index) => ({
			id: model.slug,
			adapterId: 'openai-codex',
			provider: 'openai',
			label: model.display_name ?? model.slug,
			description: model.description,
			family: model.slug.split('.')[0],
			supportsReasoning: (model.supported_reasoning_levels?.length ?? 0) > 0,
			supportsImages: true,
			supportsTools: true,
			availableReasoningEfforts: (model.supported_reasoning_levels ?? []).map(level => level.effort),
			isDefault: index === 0,
			native: { id: model.slug },
		} satisfies AgentModelDescriptor));
		this.modelCache = models;
		return models;
	}

	public async listReasoningOptions(modelId?: string): Promise<readonly AgentReasoningOption[]> {
		const raw = await readJsonFile<CodexModelCache>(this.getModelCachePath());
		const model = raw?.models?.find(candidate => candidate.slug === modelId) ?? raw?.models?.[0];
		return (model?.supported_reasoning_levels ?? []).map(level => ({
			id: level.effort,
			label: level.effort,
			description: level.description,
		}));
	}

	public async listSessions(): Promise<readonly AgentAdapterSessionSummary[]> {
		const indexEntries = await this.readSessionIndex();
		const merged = new Map<string, AgentAdapterSessionSummary>();
		for (const entry of indexEntries) {
			if (this.deletedSessions.has(entry.id)) {
				continue;
			}
			const local = this.sessions.get(entry.id);
			merged.set(entry.id, {
				id: entry.id,
				title: local?.title ?? entry.thread_name ?? 'Codex Session',
				createdAt: local?.createdAt ?? entry.updated_at ?? now(),
				updatedAt: local?.updatedAt ?? entry.updated_at ?? now(),
				archivedAt: local?.archivedAt,
				defaults: local?.defaults ?? {},
			});
		}

		for (const [sessionId, record] of this.sessions) {
			if (this.deletedSessions.has(sessionId) || merged.has(sessionId)) {
				continue;
			}
			merged.set(sessionId, toSessionSummary(record));
		}

		return Array.from(merged.values()).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
	}

	public async getSession(sessionId: string): Promise<AgentAdapterSessionSummary | undefined> {
		if (this.deletedSessions.has(sessionId)) {
			return undefined;
		}
		const record = this.sessions.get(sessionId);
		if (record) {
			return toSessionSummary(record);
		}
		const entry = (await this.readSessionIndex()).find(candidate => candidate.id === sessionId);
		if (!entry) {
			return undefined;
		}
		const hydrated: CodexSessionRecord = {
			id: entry.id,
			title: entry.thread_name ?? 'Codex Session',
			createdAt: entry.updated_at ?? now(),
			updatedAt: entry.updated_at ?? now(),
			defaults: {},
			cwd: this.getBaseCwd(),
			threadId: entry.id,
			checkpoints: [],
			transcript: [],
		};
		this.sessions.set(sessionId, hydrated);
		return toSessionSummary(hydrated);
	}

	public async createSession(request: AgentCreateSessionRequest): Promise<AgentAdapterSessionSummary> {
		const sessionId = randomUUID();
		const record: CodexSessionRecord = {
			id: sessionId,
			title: request.title ?? 'Codex Session',
			createdAt: now(),
			updatedAt: now(),
			defaults: request.defaults ?? {},
			cwd: request.metadata?.cwd ?? this.getBaseCwd(),
			checkpoints: [],
			transcript: [],
		};
		this.sessions.set(sessionId, record);
		return toSessionSummary(record);
	}

	public async archiveSession(sessionId: string): Promise<void> {
		const record = await this.ensureSessionRecord(sessionId);
		record.archivedAt = now();
		record.updatedAt = now();
	}

	public async deleteSession(sessionId: string): Promise<void> {
		this.deletedSessions.add(sessionId);
		this.sessions.delete(sessionId);
	}

	public async listChats(_sessionId: string): Promise<readonly AgentChatSummary[]> {
		return [{
			id: DEFAULT_CHAT_ID,
			title: 'Chat 1',
			createdAt: now(),
			updatedAt: now(),
			messageCount: 0,
		}];
	}

	public async getChatTranscript(sessionId: string, chatId = DEFAULT_CHAT_ID): Promise<{ sessionId: string; chatId: string; messages: readonly AgentMessage[] }> {
		const record = await this.ensureSessionRecord(sessionId);
		return {
			sessionId,
			chatId,
			messages: record.transcript,
		};
	}

	public async getSessionDefaults(sessionId: string): Promise<AgentSessionDefaults> {
		return (await this.ensureSessionRecord(sessionId)).defaults;
	}

	public async updateSessionDefaults(sessionId: string, defaults: Partial<AgentSessionDefaults>): Promise<AgentSessionDefaults> {
		const record = await this.ensureSessionRecord(sessionId);
		record.defaults = { ...record.defaults, ...defaults };
		record.updatedAt = now();
		return record.defaults;
	}

	public async sendMessage(sessionId: string, request: AgentSendMessageRequest): Promise<AgentAdapterRun> {
		const record = await this.ensureSessionRecord(sessionId);
		const runId = randomUUID();
		const chatId = request.chatId ?? DEFAULT_CHAT_ID;
		const queue = new AsyncEventQueue<AgentStreamEvent>();
		const abortController = new AbortController();
		this.activeRuns.set(runId, abortController);

		queue.push({
			type: 'run.started',
			runId,
			sessionId,
			chatId,
			adapterId: 'openai-codex',
			modelId: request.options?.modelId ?? record.defaults.modelId,
			reasoningEffort: request.options?.reasoningEffort ?? record.defaults.reasoningEffort,
		});

		const result = (async (): Promise<AgentRunSummary> => {
			const client = new Codex(this.getCodexOptions());
			const threadOptions = this.getThreadOptions(record, request);
			const thread = record.threadId ? client.resumeThread(record.threadId, threadOptions) : client.startThread(threadOptions);
			const userMessageId = `user-${runId}`;
			const assistantMessageId = `assistant-${runId}`;
			const userText = withAttachments(request.content, request.options?.attachments);
			record.transcript = [
				...record.transcript,
				{
					id: userMessageId,
					role: 'user',
					createdAt: now(),
					modelId: request.options?.modelId ?? record.defaults.modelId,
					reasoningEffort: request.options?.reasoningEffort ?? record.defaults.reasoningEffort,
					parts: [{ kind: 'text', text: userText }],
				},
			];

			let latestAssistantText = '';
			let sawCode = false;
			let sawMarkdown = false;
			let lastMessageId = assistantMessageId;
			const questionsAsked: AgentQuestionRequest[] = [];
			const filesChanged: AgentChangedFile[] = [];
			const terminalCommands: AgentTerminalCommandRequest[] = [];
			const itemSnapshots = new Map<string, string>();

			try {
				const streamed = await thread.runStreamed(userText, { signal: abortController.signal });
				await this.consumeCodexEvents({
					streamed,
					runId,
					sessionId,
					chatId,
					assistantMessageId,
					record,
					queue,
					filesChanged,
					terminalCommands,
					itemSnapshots,
					onAssistantText: text => {
						latestAssistantText += text;
					},
					onReasoning: () => undefined,
					onFilesChanged: () => { sawCode = true; },
					onMarkdown: () => { sawMarkdown = true; },
				});

				if (thread.id) {
					record.threadId = thread.id;
				}

				if (latestAssistantText) {
					record.transcript = [
						...record.transcript,
						{
							id: assistantMessageId,
							role: 'assistant',
							createdAt: now(),
							modelId: request.options?.modelId ?? record.defaults.modelId,
							reasoningEffort: request.options?.reasoningEffort ?? record.defaults.reasoningEffort,
							parts: [{ kind: 'text', text: latestAssistantText }],
						},
					];
				}
				record.updatedAt = now();

				const summary: AgentRunSummary = {
					id: runId,
					sessionId,
					chatId,
					adapterId: 'openai-codex',
					status: 'completed',
					outputKind: inferOutputKind(sawMarkdown, sawCode, latestAssistantText),
					modelId: request.options?.modelId ?? record.defaults.modelId,
					reasoningEffort: request.options?.reasoningEffort ?? record.defaults.reasoningEffort,
					lastMessageId,
					filesChanged,
					questionsAsked,
					terminalCommands,
					completedAt: now(),
				};
				queue.push({ type: 'run.completed', runId, sessionId, summary });
				queue.close();
				return summary;
			} catch (error) {
				const summary: AgentRunSummary = {
					id: runId,
					sessionId,
					chatId,
					adapterId: 'openai-codex',
					status: abortController.signal.aborted ? 'interrupted' : 'failed',
					outputKind: 'text',
					modelId: request.options?.modelId ?? record.defaults.modelId,
					reasoningEffort: request.options?.reasoningEffort ?? record.defaults.reasoningEffort,
					lastMessageId,
					filesChanged,
					questionsAsked,
					terminalCommands,
					completedAt: now(),
					errorMessage: asError(error).message,
				};
				queue.push({
					type: summary.status === 'interrupted' ? 'run.interrupted' : 'run.failed',
					runId,
					sessionId,
					summary,
				});
				queue.close();
				return summary;
			} finally {
				this.activeRuns.delete(runId);
			}
		})();

		return { runId, stream: queue, result };
	}

	public executeCommand(sessionId: string, request: AgentCommandRequest): Promise<AgentAdapterRun> {
		return this.sendMessage(sessionId, { content: request.command });
	}

	public async submitCommandInput(_sessionId: string, _runId: string, _input: string): Promise<void> {
	}

	public async executeTerminalCommand(sessionId: string, request: AgentTerminalCommandRequest): Promise<AgentAdapterRun> {
		const runId = randomUUID();
		const queue = new AsyncEventQueue<AgentStreamEvent>();
		queue.push({ type: 'terminal.started', runId, sessionId, command: request });

		const result = new Promise<AgentRunSummary>((resolve) => {
			const child = spawn(request.command, {
				cwd: request.cwd ?? this.getBaseCwd(),
				env: { ...process.env, ...request.env },
				shell: true,
			});
			this.activeTerminalRuns.set(runId, { child });
			const stdoutChunks: string[] = [];
			const stderrChunks: string[] = [];

			child.stdout.on('data', data => {
				const text = String(data);
				stdoutChunks.push(text);
				queue.push({ type: 'terminal.stdout', runId, sessionId, text });
			});
			child.stderr.on('data', data => {
				const text = String(data);
				stderrChunks.push(text);
				queue.push({ type: 'terminal.stderr', runId, sessionId, text });
			});
			child.on('close', code => {
				this.activeTerminalRuns.delete(runId);
				queue.push({ type: 'terminal.exited', runId, sessionId, exitCode: code ?? 0 });
				const summary: AgentRunSummary = {
					id: runId,
					sessionId,
					chatId: DEFAULT_CHAT_ID,
					adapterId: 'openai-codex',
					status: code === 0 ? 'completed' : 'failed',
					outputKind: 'text',
					filesChanged: [],
					questionsAsked: [],
					terminalCommands: [request],
					completedAt: now(),
					errorMessage: code === 0 ? undefined : stderrChunks.join('').trim() || stdoutChunks.join('').trim() || `Command exited with code ${code ?? 1}.`,
				};
				queue.push({ type: summary.status === 'completed' ? 'run.completed' : 'run.failed', runId, sessionId, summary });
				queue.close();
				resolve(summary);
			});
		});

		return { runId, stream: queue, result };
	}

	public async interrupt(_sessionId: string, runId: string): Promise<void> {
		this.activeRuns.get(runId)?.abort();
		this.activeTerminalRuns.get(runId)?.child.kill('SIGTERM');
	}

	public async createCheckpoint(sessionId: string, chatId = DEFAULT_CHAT_ID, label?: string): Promise<AgentAdapterCheckpoint> {
		const transcript = await this.getChatTranscript(sessionId, chatId);
		const checkpoint: AgentAdapterCheckpoint = {
			id: randomUUID(),
			sessionId,
			chatId,
			createdAt: now(),
			label,
			transcript,
		};
		const record = await this.ensureSessionRecord(sessionId);
		record.checkpoints = [...record.checkpoints, checkpoint];
		return checkpoint;
	}

	public async listCheckpoints(sessionId: string): Promise<readonly AgentAdapterCheckpoint[]> {
		return (await this.ensureSessionRecord(sessionId)).checkpoints;
	}

	public async revertToCheckpoint(sessionId: string, checkpointId: string): Promise<AgentAdapterCheckpoint> {
		const checkpoint = (await this.ensureSessionRecord(sessionId)).checkpoints.find(candidate => candidate.id === checkpointId);
		if (!checkpoint) {
			throw new Error(`Unknown checkpoint "${checkpointId}".`);
		}
		return checkpoint;
	}

	public async truncateConversation(_sessionId: string, _chatId: string, _messageId: string): Promise<void> {
	}

	private getBaseCwd(): string {
		return this.options.cwd ?? process.cwd();
	}

	private getModelCachePath(): string {
		return this.options.modelCachePath ?? path.join(os.homedir(), '.codex', 'models_cache.json');
	}

	private getSessionIndexPath(): string {
		return this.options.sessionIndexPath ?? path.join(os.homedir(), '.codex', 'session_index.jsonl');
	}

	private getCodexOptions(): CodexOptions {
		return {
			codexPathOverride: this.options.codexPathOverride,
			env: this.options.env,
			config: this.options.config,
		};
	}

	private getThreadOptions(record: CodexSessionRecord, request: AgentSendMessageRequest): ThreadOptions {
		return {
			model: request.options?.modelId ?? record.defaults.modelId,
			modelReasoningEffort: normalizeCodexEffort(request.options?.reasoningEffort ?? record.defaults.reasoningEffort),
			sandboxMode: this.options.sandboxMode ?? 'workspace-write',
			workingDirectory: record.cwd,
			skipGitRepoCheck: this.options.skipGitRepoCheck ?? false,
			networkAccessEnabled: this.options.networkAccessEnabled,
			approvalPolicy: this.options.approvalPolicy ?? 'on-request',
			additionalDirectories: this.options.additionalDirectories ? [...this.options.additionalDirectories] : undefined,
			webSearchMode: this.options.webSearchMode,
			webSearchEnabled: this.options.webSearchEnabled,
		};
	}

	private async readSessionIndex(): Promise<readonly CodexSessionIndexEntry[]> {
		const raw = await readFile(this.getSessionIndexPath(), 'utf8').catch(() => '');
		return raw
			.split('\n')
			.map(line => line.trim())
			.filter(Boolean)
			.map(line => JSON.parse(line) as CodexSessionIndexEntry);
	}

	private async ensureSessionRecord(sessionId: string): Promise<CodexSessionRecord> {
		const existing = this.sessions.get(sessionId);
		if (existing) {
			return existing;
		}
		const persisted = (await this.readSessionIndex()).find(candidate => candidate.id === sessionId);
		if (!persisted) {
			throw new Error(`Unknown Codex session "${sessionId}".`);
		}
		const record: CodexSessionRecord = {
			id: sessionId,
			title: persisted.thread_name ?? 'Codex Session',
			createdAt: persisted.updated_at ?? now(),
			updatedAt: persisted.updated_at ?? now(),
			defaults: {},
			cwd: this.getBaseCwd(),
			threadId: persisted.id,
			checkpoints: [],
			transcript: [],
		};
		this.sessions.set(sessionId, record);
		return record;
	}

	private async consumeCodexEvents(params: {
		streamed: RunStreamedResult;
		runId: string;
		sessionId: string;
		chatId: string;
		assistantMessageId: string;
		record: CodexSessionRecord;
		queue: AsyncEventQueue<AgentStreamEvent>;
		filesChanged: AgentChangedFile[];
		terminalCommands: AgentTerminalCommandRequest[];
		itemSnapshots: Map<string, string>;
		onAssistantText(text: string): void;
		onReasoning(): void;
		onFilesChanged(): void;
		onMarkdown(): void;
	}): Promise<void> {
		for await (const event of params.streamed.events) {
			if (event.type === 'thread.started') {
				params.record.threadId = event.thread_id;
				continue;
			}

			if (event.type === 'item.started' || event.type === 'item.updated' || event.type === 'item.completed') {
				this.handleCodexItemEvent(event, params);
				continue;
			}

			if (event.type === 'error') {
				throw new Error(event.message);
			}

			if (event.type === 'turn.failed') {
				throw new Error(event.error.message);
			}
		}
	}

	private handleCodexItemEvent(event: ItemStartedEvent | ItemUpdatedEvent | ItemCompletedEvent, params: {
		runId: string;
		sessionId: string;
		chatId: string;
		assistantMessageId: string;
		queue: AsyncEventQueue<AgentStreamEvent>;
		filesChanged: AgentChangedFile[];
		terminalCommands: AgentTerminalCommandRequest[];
		itemSnapshots: Map<string, string>;
		onAssistantText(text: string): void;
		onReasoning(): void;
		onFilesChanged(): void;
		onMarkdown(): void;
	}): void {
		const item = event.item;

		if (item.type === 'agent_message') {
			const previous = params.itemSnapshots.get(item.id) ?? '';
			const next = item.text;
			const delta = next.slice(previous.length);
			if (delta) {
				params.onAssistantText(delta);
				params.queue.push({
					type: 'chat.message.delta',
					runId: params.runId,
					sessionId: params.sessionId,
					chatId: params.chatId,
					messageId: params.assistantMessageId,
					role: 'assistant',
					text: delta,
				});
			}
			params.itemSnapshots.set(item.id, next);
			return;
		}

		if (item.type === 'reasoning') {
			const previous = params.itemSnapshots.get(item.id) ?? '';
			const delta = item.text.slice(previous.length);
			if (delta) {
				params.onReasoning();
				params.queue.push({
					type: 'reasoning.delta',
					runId: params.runId,
					sessionId: params.sessionId,
					chatId: params.chatId,
					text: delta,
				});
			}
			params.itemSnapshots.set(item.id, item.text);
			return;
		}

		if (item.type === 'command_execution') {
			handleCodexCommandItem(event, item, params);
			return;
		}

		if (item.type === 'file_change' && event.type === 'item.completed') {
			params.onFilesChanged();
			const normalized = normalizeFileChanges(item);
			params.filesChanged.push(...normalized);
			params.queue.push({
				type: 'files.changed',
				runId: params.runId,
				sessionId: params.sessionId,
				files: [...params.filesChanged],
			});
			return;
		}

		if (item.type === 'todo_list') {
			params.onMarkdown();
			params.queue.push({
				type: 'markdown.delta',
				runId: params.runId,
				sessionId: params.sessionId,
				chatId: params.chatId,
				messageId: params.assistantMessageId,
				markdown: item.items.map((todo, index) => `${index + 1}. [${todo.completed ? 'x' : ' '}] ${todo.text}`).join('\n'),
			});
			return;
		}
	}
}

abstract class BaseCodexTransport implements CodexTransport {
	public abstract readonly kind: 'bridge' | 'sdk';
	protected readonly driver: CodexTransportDriver;

	public constructor(
		public readonly id: string,
		driverOrOptions?: CodexTransportDriver | CodexSdkTransportOptions,
		private readonly available: AvailabilityPredicate = true,
		public readonly capabilities?: Partial<AgentCapabilities>,
	) {
		this.driver = isCodexTransportDriver(driverOrOptions) ? driverOrOptions : new CodexSdkDriver(driverOrOptions);
	}

	public async isAvailable(): Promise<boolean> {
		return typeof this.available === 'function' ? this.available() : this.available;
	}

	public listModels(): Promise<readonly AgentModelDescriptor[]> { return this.driver.listModels(); }
	public listReasoningOptions(modelId?: string): Promise<readonly AgentReasoningOption[]> { return this.driver.listReasoningOptions(modelId); }
	public listSessions(): Promise<readonly AgentAdapterSessionSummary[]> { return this.driver.listSessions(); }
	public getSession(sessionId: string): Promise<AgentAdapterSessionSummary | undefined> { return this.driver.getSession(sessionId); }
	public createSession(request: AgentCreateSessionRequest): Promise<AgentAdapterSessionSummary> { return this.driver.createSession(request); }
	public archiveSession(sessionId: string): Promise<void> { return this.driver.archiveSession(sessionId); }
	public deleteSession(sessionId: string): Promise<void> { return this.driver.deleteSession(sessionId); }
	public listChats(sessionId: string): Promise<readonly AgentChatSummary[]> { return this.driver.listChats(sessionId); }
	public getChatTranscript(sessionId: string, chatId?: string): Promise<{ sessionId: string; chatId: string; messages: readonly AgentMessage[] }> { return this.driver.getChatTranscript(sessionId, chatId); }
	public getSessionDefaults(sessionId: string): Promise<AgentSessionDefaults> { return this.driver.getSessionDefaults(sessionId); }
	public updateSessionDefaults(sessionId: string, defaults: Partial<AgentSessionDefaults>): Promise<AgentSessionDefaults> { return this.driver.updateSessionDefaults(sessionId, defaults); }
	public sendMessage(sessionId: string, request: AgentSendMessageRequest): Promise<AgentAdapterRun> { return this.driver.sendMessage(sessionId, request); }
	public executeCommand(sessionId: string, request: AgentCommandRequest): Promise<AgentAdapterRun> { return this.driver.executeCommand(sessionId, request); }
	public submitCommandInput(sessionId: string, runId: string, input: string): Promise<void> { return this.driver.submitCommandInput(sessionId, runId, input); }
	public executeTerminalCommand(sessionId: string, request: AgentTerminalCommandRequest): Promise<AgentAdapterRun> { return this.driver.executeTerminalCommand(sessionId, request); }
	public interrupt(sessionId: string, runId: string): Promise<void> { return this.driver.interrupt(sessionId, runId); }
	public createCheckpoint(sessionId: string, chatId?: string, label?: string): Promise<AgentAdapterCheckpoint> { return this.driver.createCheckpoint(sessionId, chatId, label); }
	public listCheckpoints(sessionId: string): Promise<readonly AgentAdapterCheckpoint[]> { return this.driver.listCheckpoints(sessionId); }
	public revertToCheckpoint(sessionId: string, checkpointId: string): Promise<AgentAdapterCheckpoint> { return this.driver.revertToCheckpoint(sessionId, checkpointId); }
	public truncateConversation(sessionId: string, chatId: string, messageId: string): Promise<void> { return this.driver.truncateConversation(sessionId, chatId, messageId); }
}

export class CodexSdkTransport extends BaseCodexTransport {
	public override readonly kind = 'sdk';
}

export class CodexSignedInBridgeTransport extends BaseCodexTransport {
	public override readonly kind = 'bridge';
}

function isCodexTransportDriver(value: CodexTransportDriver | CodexSdkTransportOptions | undefined): value is CodexTransportDriver {
	return typeof value === 'object'
		&& value !== null
		&& 'listModels' in value
		&& 'sendMessage' in value;
}

function toSessionSummary(record: CodexSessionRecord): AgentAdapterSessionSummary {
	return {
		id: record.id,
		title: record.title,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		archivedAt: record.archivedAt,
		defaults: record.defaults,
	};
}

function normalizeCodexEffort(effort: string | undefined): ThreadOptions['modelReasoningEffort'] {
	if (effort === 'minimal' || effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh') {
		return effort;
	}
	return undefined;
}

function handleCodexCommandItem(
	event: ItemStartedEvent | ItemUpdatedEvent | ItemCompletedEvent,
	item: Extract<ThreadItem, { type: 'command_execution' }>,
	params: {
		runId: string;
		sessionId: string;
		queue: AsyncEventQueue<AgentStreamEvent>;
		terminalCommands: AgentTerminalCommandRequest[];
		itemSnapshots: Map<string, string>;
	},
): void {
	if (event.type === 'item.started') {
		const command = { command: item.command };
		params.terminalCommands.push(command);
		params.queue.push({ type: 'terminal.started', runId: params.runId, sessionId: params.sessionId, command });
	}

	const previous = params.itemSnapshots.get(item.id) ?? '';
	const delta = item.aggregated_output.slice(previous.length);
	if (delta) {
		params.queue.push({ type: 'terminal.stdout', runId: params.runId, sessionId: params.sessionId, text: delta });
	}
	params.itemSnapshots.set(item.id, item.aggregated_output);

	if (event.type === 'item.completed') {
		params.queue.push({ type: 'terminal.exited', runId: params.runId, sessionId: params.sessionId, exitCode: item.exit_code ?? 0 });
	}
}

function normalizeFileChanges(item: FileChangeItem): AgentChangedFile[] {
	return item.changes.map(change => ({
		path: change.path,
		change: change.kind === 'add' ? 'added' : change.kind === 'delete' ? 'deleted' : 'modified',
	}));
}

function inferOutputKind(sawMarkdown: boolean, sawCode: boolean, text: string): AgentRunSummary['outputKind'] {
	if (sawMarkdown && sawCode) {
		return 'mixed';
	}
	if (sawCode) {
		return 'code';
	}
	if (sawMarkdown) {
		return 'markdown';
	}
	return text ? 'text' : 'structured';
}

function withAttachments(content: string, attachments: readonly { kind: string; name: string; content?: string; uri?: string }[] | undefined): string {
	if (!attachments || attachments.length === 0) {
		return content;
	}
	const renderedAttachments = attachments.map(attachment => {
		if (attachment.kind === 'image') {
			return `Attachment ${attachment.name}: ${attachment.uri ?? ''}`.trim();
		}
		if (attachment.content) {
			return `Attachment ${attachment.name}:\n${attachment.content}`;
		}
		return `Attachment ${attachment.name}`;
	});
	return `${content}\n\n${renderedAttachments.join('\n\n')}`;
}

async function readJsonFile<T>(filePath: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(filePath, 'utf8')) as T;
	} catch {
		return undefined;
	}
}

function now(): string {
	return new Date().toISOString();
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
