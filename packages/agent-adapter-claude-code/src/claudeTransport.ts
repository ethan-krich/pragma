/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ethan Krich. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
	getSessionInfo,
	getSessionMessages,
	listSessions,
	query,
	renameSession,
	tagSession,
	type ModelInfo,
	type Options as ClaudeQueryOptions,
	type SDKMessage,
	type SDKResultMessage,
	type SessionMessage,
} from '@anthropic-ai/claude-agent-sdk';

const DEFAULT_CHAT_ID = 'chat-1';

export interface ClaudeTransportDriver {
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

export interface ClaudeSdkTransportOptions {
	readonly cwd?: string;
	readonly env?: Record<string, string | undefined>;
	readonly executable?: 'node' | 'bun';
	readonly executableArgs?: readonly string[];
	readonly pathToClaudeCodeExecutable?: string;
	readonly permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
	readonly additionalDirectories?: readonly string[];
	readonly allowDangerouslySkipPermissions?: boolean;
	readonly persistSession?: boolean;
}

export interface ClaudeTransport {
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

interface ClaudeSessionRecord {
	readonly id: string;
	title: string;
	createdAt: string;
	updatedAt: string;
	defaults: AgentSessionDefaults;
	readonly cwd: string;
	archivedAt?: string;
	hasStarted?: boolean;
	checkpoints: AgentAdapterCheckpoint[];
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

class ClaudeSdkDriver implements ClaudeTransportDriver {
	private readonly sessions = new Map<string, ClaudeSessionRecord>();
	private readonly deletedSessions = new Set<string>();
	private readonly activeRuns = new Map<string, AbortController>();
	private readonly activeTerminalRuns = new Map<string, ActiveTerminalRun>();
	private modelCache: readonly AgentModelDescriptor[] | undefined;

	public constructor(private readonly options: ClaudeSdkTransportOptions = {}) { }

	public async listModels(): Promise<readonly AgentModelDescriptor[]> {
		if (this.modelCache) {
			return this.modelCache;
		}

		const probe = query({
			prompt: 'List the available models.',
			options: {
				cwd: this.getBaseCwd(),
				persistSession: false,
				permissionMode: this.options.permissionMode ?? 'plan',
				pathToClaudeCodeExecutable: this.options.pathToClaudeCodeExecutable,
				executable: this.options.executable,
				executableArgs: this.options.executableArgs ? [...this.options.executableArgs] : undefined,
				env: this.options.env,
				additionalDirectories: this.options.additionalDirectories ? [...this.options.additionalDirectories] : undefined,
				allowDangerouslySkipPermissions: this.options.allowDangerouslySkipPermissions,
			},
		});

		try {
			const models = await probe.supportedModels();
			this.modelCache = models.map((model, index) => toClaudeModelDescriptor(model, index === 0));
			return this.modelCache;
		} finally {
			probe.close();
		}
	}

	public async listReasoningOptions(modelId?: string): Promise<readonly AgentReasoningOption[]> {
		const model = (await this.listModels()).find(candidate => candidate.id === modelId) ?? (await this.listModels())[0];
		return (model?.availableReasoningEfforts ?? []).map(id => ({ id, label: id }));
	}

	public async listSessions(): Promise<readonly AgentAdapterSessionSummary[]> {
		const sdkSessions = await listSessions({ dir: this.getBaseCwd() });
		const merged = new Map<string, AgentAdapterSessionSummary>();

		for (const session of sdkSessions) {
			if (this.deletedSessions.has(session.sessionId)) {
				continue;
			}
			const local = this.sessions.get(session.sessionId);
			merged.set(session.sessionId, {
				id: session.sessionId,
				title: local?.title ?? session.customTitle ?? session.summary ?? 'Claude Session',
				createdAt: toIso(session.createdAt ?? session.lastModified),
				updatedAt: toIso(session.lastModified),
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
		const info = await getSessionInfo(sessionId, { dir: this.getBaseCwd() });
		if (!info) {
			return undefined;
		}
		return {
			id: info.sessionId,
			title: info.customTitle ?? info.summary ?? 'Claude Session',
			createdAt: toIso(info.createdAt ?? info.lastModified),
			updatedAt: toIso(info.lastModified),
			defaults: {},
		};
	}

	public async createSession(request: AgentCreateSessionRequest): Promise<AgentAdapterSessionSummary> {
		const record: ClaudeSessionRecord = {
			id: randomUUID(),
			title: request.title ?? 'Claude Session',
			createdAt: now(),
			updatedAt: now(),
			defaults: request.defaults ?? {},
			cwd: request.metadata?.cwd ?? this.getBaseCwd(),
			checkpoints: [],
		};
		this.sessions.set(record.id, record);
		return toSessionSummary(record);
	}

	public async archiveSession(sessionId: string): Promise<void> {
		const record = await this.ensureSessionRecord(sessionId);
		record.archivedAt = now();
		record.updatedAt = now();
		await tagSession(sessionId, 'archived', { dir: record.cwd }).catch(() => undefined);
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
		const messages = await getSessionMessages(sessionId, {
			dir: record.cwd,
			includeSystemMessages: true,
		}).catch(() => []);
		return {
			sessionId,
			chatId,
			messages: messages.map(normalizeClaudeSessionMessage),
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
			adapterId: 'claude-code',
			modelId: request.options?.modelId ?? record.defaults.modelId,
			reasoningEffort: request.options?.reasoningEffort ?? record.defaults.reasoningEffort,
		});

		const result = (async (): Promise<AgentRunSummary> => {
			let sawTextDelta = false;
			let sawReasoningDelta = false;
			let sawMarkdown = false;
			let sawCode = false;
			let lastMessageId: string | undefined;
			let latestResult: SDKResultMessage | undefined;
			let latestAssistantText = '';
			const questionsAsked: AgentQuestionRequest[] = [];
			const filesChanged: AgentChangedFile[] = [];
			const terminalCommands: AgentTerminalCommandRequest[] = [];
			const toolOutputs = new Map<string, string>();
			let streamHandle: ReturnType<typeof query> | undefined;

			try {
				streamHandle = query({
					prompt: withAttachments(request.content, request.options?.attachments),
					options: this.toQueryOptions(record, {
						resume: record.hasStarted ? sessionId : undefined,
						sessionId: record.hasStarted ? undefined : sessionId,
						model: request.options?.modelId ?? record.defaults.modelId,
						effort: normalizeClaudeEffort(request.options?.reasoningEffort ?? record.defaults.reasoningEffort),
						includePartialMessages: true,
						persistSession: this.options.persistSession ?? true,
						abortController,
					}),
				});

				for await (const message of streamHandle) {
					lastMessageId = 'uuid' in message ? message.uuid : lastMessageId;

					if (message.type === 'stream_event') {
						const partialEvents = mapClaudePartialEvent(message, runId, sessionId, chatId, lastMessageId ?? `assistant-${runId}`);
						for (const event of partialEvents) {
							if (event.type === 'chat.message.delta') {
								sawTextDelta = true;
								latestAssistantText += event.text;
							} else if (event.type === 'reasoning.delta') {
								sawReasoningDelta = true;
							}
							queue.push(event);
						}
						continue;
					}

					if (message.type === 'assistant') {
						lastMessageId = message.uuid;
						const assistantParts = normalizeClaudeMessageParts(message.message?.content ?? []);
						const text = assistantParts.filter(part => part.kind === 'text').map(part => part.text).join('');
						const markdown = assistantParts.filter(part => part.kind === 'markdown').map(part => part.markdown).join('\n\n');
						const codeBlocks = assistantParts.filter(part => part.kind === 'code');
						if (!sawTextDelta && text) {
							latestAssistantText = text;
							queue.push({
								type: 'chat.message.delta',
								runId,
								sessionId,
								chatId,
								messageId: message.uuid,
								role: 'assistant',
								text,
							});
						}
						if (!sawReasoningDelta) {
							for (const part of assistantParts) {
								if (part.kind === 'reasoning') {
									queue.push({
										type: 'reasoning.delta',
										runId,
										sessionId,
										chatId,
										text: part.text,
									});
								}
							}
						}
						if (markdown) {
							sawMarkdown = true;
							queue.push({
								type: 'markdown.delta',
								runId,
								sessionId,
								chatId,
								messageId: message.uuid,
								markdown,
							});
						}
						for (const codeBlock of codeBlocks) {
							sawCode = true;
							queue.push({
								type: 'code.delta',
								runId,
								sessionId,
								chatId,
								messageId: message.uuid,
								code: codeBlock.code,
								language: codeBlock.language,
							});
						}
						continue;
					}

					if (message.type === 'tool_progress') {
						const command = { command: message.tool_name };
						terminalCommands.push(command);
						queue.push({ type: 'terminal.started', runId, sessionId, command });
						continue;
					}

					if (message.type === 'tool_use_summary') {
						queue.push({
							type: 'reasoning.delta',
							runId,
							sessionId,
							chatId,
							text: message.summary,
						});
						continue;
					}

					if (message.type === 'system' && message.subtype === 'local_command_output' && message.content) {
						sawMarkdown = true;
						queue.push({
							type: 'markdown.delta',
							runId,
							sessionId,
							chatId,
							messageId: message.uuid,
							markdown: message.content,
						});
						continue;
					}

					if (message.type === 'system' && message.subtype === 'files_persisted') {
						for (const file of message.files) {
							filesChanged.push({ path: file.filename, change: 'modified' });
						}
						if (message.files.length > 0) {
							queue.push({ type: 'files.changed', runId, sessionId, files: [...filesChanged] });
						}
						continue;
					}

					if (message.type === 'result') {
						latestResult = message;
						continue;
					}

					if (message.type === 'auth_status' && message.error) {
						toolOutputs.set('auth_status', message.error);
					}
				}

				record.updatedAt = now();
				record.hasStarted = true;
				if (record.title && record.title !== 'Claude Session') {
					await renameSession(sessionId, record.title, { dir: record.cwd }).catch(() => undefined);
				}
				const summary = buildClaudeSummary({
					runId,
					sessionId,
					chatId,
					modelId: request.options?.modelId ?? record.defaults.modelId,
					reasoningEffort: request.options?.reasoningEffort ?? record.defaults.reasoningEffort,
					lastMessageId,
					latestAssistantText,
					result: latestResult,
					filesChanged,
					questionsAsked,
					terminalCommands,
					sawMarkdown,
					sawCode,
					fallbackError: toolOutputs.get('auth_status'),
				});
				queue.push({
					type: summary.status === 'completed' ? 'run.completed' : summary.status === 'failed' ? 'run.failed' : 'run.interrupted',
					runId,
					sessionId,
					summary,
				});
				queue.close();
				return summary;
			} catch (error) {
				const summary: AgentRunSummary = {
					id: runId,
					sessionId,
					chatId,
					adapterId: 'claude-code',
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
				streamHandle?.close();
			}
		})();

		return { runId, stream: queue, result };
	}

	public executeCommand(sessionId: string, request: AgentCommandRequest): Promise<AgentAdapterRun> {
		return this.sendMessage(sessionId, {
			content: request.command,
		});
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
					adapterId: 'claude-code',
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

	private async getDefaultModelId(): Promise<string> {
		return (await this.listModels()).find(model => model.isDefault)?.id ?? (await this.listModels())[0]?.id ?? 'opus';
	}

	private toQueryOptions(record: ClaudeSessionRecord, overrides: Partial<ClaudeQueryOptions>): ClaudeQueryOptions {
		return {
			cwd: record.cwd,
			env: this.options.env,
			executable: this.options.executable,
			executableArgs: this.options.executableArgs ? [...this.options.executableArgs] : undefined,
			pathToClaudeCodeExecutable: this.options.pathToClaudeCodeExecutable,
			permissionMode: this.options.permissionMode ?? 'default',
			additionalDirectories: this.options.additionalDirectories ? [...this.options.additionalDirectories] : undefined,
			allowDangerouslySkipPermissions: this.options.allowDangerouslySkipPermissions,
			persistSession: this.options.persistSession ?? true,
			...overrides,
		};
	}

	private async ensureSessionRecord(sessionId: string): Promise<ClaudeSessionRecord> {
		const existing = this.sessions.get(sessionId);
		if (existing) {
			return existing;
		}

		const info = await getSessionInfo(sessionId, { dir: this.getBaseCwd() });
		if (!info) {
			throw new Error(`Unknown Claude session "${sessionId}".`);
		}

		const record: ClaudeSessionRecord = {
			id: info.sessionId,
			title: info.customTitle ?? info.summary ?? 'Claude Session',
			createdAt: toIso(info.createdAt ?? info.lastModified),
			updatedAt: toIso(info.lastModified),
			defaults: {},
			cwd: info.cwd ?? this.getBaseCwd(),
			hasStarted: true,
			checkpoints: [],
		};
		this.sessions.set(sessionId, record);
		return record;
	}
}

abstract class BaseClaudeTransport implements ClaudeTransport {
	public abstract readonly kind: 'bridge' | 'sdk';
	protected readonly driver: ClaudeTransportDriver;

	public constructor(
		public readonly id: string,
		driverOrOptions?: ClaudeTransportDriver | ClaudeSdkTransportOptions,
		private readonly available: AvailabilityPredicate = true,
		public readonly capabilities?: Partial<AgentCapabilities>,
	) {
		this.driver = isClaudeTransportDriver(driverOrOptions) ? driverOrOptions : new ClaudeSdkDriver(driverOrOptions);
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

export class ClaudeSdkTransport extends BaseClaudeTransport {
	public override readonly kind = 'sdk';
}

export class ClaudeSignedInBridgeTransport extends BaseClaudeTransport {
	public override readonly kind = 'bridge';
}

function isClaudeTransportDriver(value: ClaudeTransportDriver | ClaudeSdkTransportOptions | undefined): value is ClaudeTransportDriver {
	return typeof value === 'object'
		&& value !== null
		&& 'listModels' in value
		&& 'sendMessage' in value;
}

function toClaudeModelDescriptor(model: ModelInfo, isDefault: boolean): AgentModelDescriptor {
	return {
		id: model.value,
		adapterId: 'claude-code',
		provider: 'anthropic',
		label: model.displayName,
		description: model.description,
		family: inferClaudeFamily(model.value),
		supportsReasoning: Boolean(model.supportsEffort || model.supportsAdaptiveThinking),
		supportsImages: true,
		supportsTools: true,
		availableReasoningEfforts: model.supportedEffortLevels ?? [],
		isDefault,
		native: { id: model.value },
	};
}

function inferClaudeFamily(modelId: string): string | undefined {
	if (modelId.includes('opus')) {
		return 'opus';
	}
	if (modelId.includes('sonnet')) {
		return 'sonnet';
	}
	if (modelId.includes('haiku')) {
		return 'haiku';
	}
	return undefined;
}

function normalizeClaudeEffort(effort: string | undefined): 'low' | 'medium' | 'high' | 'max' | undefined {
	if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'max') {
		return effort;
	}
	return undefined;
}

function toSessionSummary(record: ClaudeSessionRecord): AgentAdapterSessionSummary {
	return {
		id: record.id,
		title: record.title,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		archivedAt: record.archivedAt,
		defaults: record.defaults,
	};
}

function toIso(timestamp: number): string {
	return new Date(timestamp).toISOString();
}

function now(): string {
	return new Date().toISOString();
}

function normalizeClaudeSessionMessage(message: SessionMessage): AgentMessage {
	const raw = message.message as { content?: unknown[]; role?: string };
	return {
		id: message.uuid,
		role: message.type,
		createdAt: now(),
		parts: normalizeClaudeMessageParts(raw?.content ?? []),
	};
}

function normalizeClaudeMessageParts(content: unknown[]): AgentMessagePart[] {
	const parts: AgentMessagePart[] = [];
	for (const block of content) {
		if (!block || typeof block !== 'object') {
			continue;
		}
		const typedBlock = block as Record<string, unknown>;
		const type = typeof typedBlock.type === 'string' ? typedBlock.type : undefined;
		if (type === 'text' && typeof typedBlock.text === 'string') {
			parts.push({ kind: 'text', text: typedBlock.text });
			continue;
		}
		if (type === 'thinking' && typeof typedBlock.thinking === 'string') {
			parts.push({ kind: 'reasoning', text: typedBlock.thinking });
			continue;
		}
		if (type === 'code' && typeof typedBlock.code === 'string') {
			parts.push({
				kind: 'code',
				code: typedBlock.code,
				language: typeof typedBlock.language === 'string' ? typedBlock.language : undefined,
			});
			continue;
		}
		if (type === 'image' && typeof typedBlock.source === 'object' && typedBlock.source && 'url' in typedBlock.source) {
			parts.push({ kind: 'image', uri: String((typedBlock.source as Record<string, unknown>).url) });
			continue;
		}
		if (type === 'tool_result' && typeof typedBlock.content === 'string') {
			parts.push({ kind: 'terminal', stream: 'stdout', text: typedBlock.content });
			continue;
		}
		if (type === 'tool_use') {
			parts.push({ kind: 'structured', value: block });
		}
	}
	return parts.length > 0 ? parts : [{ kind: 'structured', value: content }];
}

function mapClaudePartialEvent(message: Extract<SDKMessage, { type: 'stream_event' }>, runId: string, sessionId: string, chatId: string, messageId: string): AgentStreamEvent[] {
	const event = message.event as unknown as Record<string, unknown>;
	if (event.type !== 'content_block_delta') {
		return [];
	}

	const delta = event.delta as Record<string, unknown> | undefined;
	if (!delta || typeof delta.type !== 'string') {
		return [];
	}

	if (delta.type === 'text_delta' && typeof delta.text === 'string') {
		return [{
			type: 'chat.message.delta',
			runId,
			sessionId,
			chatId,
			messageId,
			role: 'assistant',
			text: delta.text,
		}];
	}

	if ((delta.type === 'thinking_delta' || delta.type === 'signature_delta') && typeof delta.thinking === 'string') {
		return [{
			type: 'reasoning.delta',
			runId,
			sessionId,
			chatId,
			text: delta.thinking,
		}];
	}

	return [];
}

function buildClaudeSummary(params: {
	runId: string;
	sessionId: string;
	chatId: string;
	modelId?: string;
	reasoningEffort?: string;
	lastMessageId?: string;
	latestAssistantText: string;
	result?: SDKResultMessage;
	filesChanged: readonly AgentChangedFile[];
	questionsAsked: readonly AgentQuestionRequest[];
	terminalCommands: readonly AgentTerminalCommandRequest[];
	sawMarkdown: boolean;
	sawCode: boolean;
	fallbackError?: string;
}): AgentRunSummary {
	const status = params.result?.type === 'result'
		? params.result.is_error ? 'failed' : 'completed'
		: params.fallbackError ? 'failed' : 'completed';
	return {
		id: params.runId,
		sessionId: params.sessionId,
		chatId: params.chatId,
		adapterId: 'claude-code',
		status,
		outputKind: inferOutputKind(params.sawMarkdown, params.sawCode, params.latestAssistantText),
		modelId: params.modelId,
		reasoningEffort: params.reasoningEffort,
		lastMessageId: params.lastMessageId,
		filesChanged: params.filesChanged,
		questionsAsked: params.questionsAsked,
		terminalCommands: params.terminalCommands,
		completedAt: now(),
		errorMessage: status === 'failed' ? params.fallbackError ?? ('errors' in (params.result ?? {}) ? (params.result as { errors?: string[] }).errors?.join('\n') : undefined) : undefined,
	};
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

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
