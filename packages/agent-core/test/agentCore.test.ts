/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ethan Krich. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	AgentAdapter,
	AgentAdapterCheckpoint,
	AgentAdapterRun,
	AgentAdapterSessionSummary,
	AgentCapabilities,
	AgentChatSummary,
	AgentCommandRequest,
	AgentCore,
	AgentMessage,
	AgentModelDescriptor,
	AgentQuestionRequest,
	AgentReasoningOption,
	AgentRunSummary,
	AgentSendMessageRequest,
	AgentSessionDefaults,
	AgentStreamEvent,
	AgentTerminalCommandRequest,
	AgentValidationError,
} from '../src/index.js';

class FakeAgentAdapter implements AgentAdapter {
	public readonly displayName: string;
	public readonly capabilities: AgentCapabilities = {
		supportsImages: true,
		supportsReasoning: true,
		supportsTerminalCommands: true,
		supportsCheckpointRestore: true,
		supportsEditing: true,
		supportsPassthroughCommands: true,
	};

	private readonly sessions = new Map<string, AgentAdapterSessionSummary>();
	private readonly chats = new Map<string, AgentChatSummary[]>();
	private readonly transcripts = new Map<string, AgentMessage[]>();
	private readonly checkpoints = new Map<string, AgentAdapterCheckpoint[]>();
	private readonly pendingCommandInputs = new Map<string, { resolve(value: string): void; promise: Promise<string> }>();
	private readonly slowRuns = new Map<string, { resolve(summary: AgentRunSummary): void; promise: Promise<AgentRunSummary> }>();
	public readonly sentRequests: AgentSendMessageRequest[] = [];
	private sessionCounter = 0;
	private messageCounter = 0;
	private runCounter = 0;
	private checkpointCounter = 0;

	public constructor(
		public readonly id: string,
		public readonly provider: string,
		private readonly models: readonly AgentModelDescriptor[],
		private readonly reasoningOptions: Record<string, readonly AgentReasoningOption[]>,
	) {
		this.displayName = id;
	}

	public getStandardCommandMappings() {
		return {
			plan: '/create-plan',
			resume: '/resume',
			help: '/help',
			interrupt: '/stop',
			'checkpoint.list': '/checkpoints',
			'checkpoint.revert': '/restore-checkpoint',
		} as const;
	}

	public async listModels(): Promise<readonly AgentModelDescriptor[]> {
		return this.models;
	}

	public async listReasoningOptions(modelId?: string): Promise<readonly AgentReasoningOption[]> {
		return this.reasoningOptions[modelId ?? this.models[0]!.id] ?? [];
	}

	public async listSessions(): Promise<readonly AgentAdapterSessionSummary[]> {
		return Array.from(this.sessions.values());
	}

	public async getSession(sessionId: string): Promise<AgentAdapterSessionSummary | undefined> {
		return this.sessions.get(sessionId);
	}

	public async createSession(request: { title?: string; defaults?: AgentSessionDefaults }): Promise<AgentAdapterSessionSummary> {
		const id = `session-${++this.sessionCounter}`;
		const now = new Date().toISOString();
		const session: AgentAdapterSessionSummary = {
			id,
			title: request.title ?? `${this.id} session ${this.sessionCounter}`,
			createdAt: now,
			updatedAt: now,
			defaults: request.defaults ?? {},
		};
		this.sessions.set(id, session);
		this.chats.set(id, [{ id: 'chat-1', title: 'Chat 1', createdAt: now, updatedAt: now, messageCount: 0 }]);
		this.transcripts.set(id, []);
		this.checkpoints.set(id, []);
		return session;
	}

	public async archiveSession(sessionId: string): Promise<void> {
		const session = this.mustGetSession(sessionId);
		this.sessions.set(sessionId, { ...session, archivedAt: new Date().toISOString() });
	}

	public async deleteSession(sessionId: string): Promise<void> {
		this.sessions.delete(sessionId);
		this.chats.delete(sessionId);
		this.transcripts.delete(sessionId);
		this.checkpoints.delete(sessionId);
	}

	public async listChats(sessionId: string): Promise<readonly AgentChatSummary[]> {
		return this.chats.get(sessionId) ?? [];
	}

	public async getChatTranscript(sessionId: string, chatId = 'chat-1'): Promise<{ sessionId: string; chatId: string; messages: readonly AgentMessage[] }> {
		return {
			sessionId,
			chatId,
			messages: this.transcripts.get(sessionId) ?? [],
		};
	}

	public async getSessionDefaults(sessionId: string): Promise<AgentSessionDefaults> {
		return this.mustGetSession(sessionId).defaults;
	}

	public async updateSessionDefaults(sessionId: string, defaults: Partial<AgentSessionDefaults>): Promise<AgentSessionDefaults> {
		const session = this.mustGetSession(sessionId);
		const nextDefaults = { ...session.defaults, ...defaults };
		this.sessions.set(sessionId, { ...session, defaults: nextDefaults, updatedAt: new Date().toISOString() });
		return nextDefaults;
	}

	public async sendMessage(sessionId: string, request: AgentSendMessageRequest): Promise<AgentAdapterRun> {
		this.sentRequests.push(request);
		return this.createMessageRun(sessionId, request, undefined);
	}

	public async executeCommand(sessionId: string, request: AgentCommandRequest): Promise<AgentAdapterRun> {
		const runId = `run-${++this.runCounter}`;
		if (request.command === '/needs-input') {
			let resolveInput!: (value: string) => void;
			const promise = new Promise<string>(resolve => {
				resolveInput = resolve;
			});
			this.pendingCommandInputs.set(runId, { resolve: resolveInput, promise });
			return {
				runId,
				stream: this.commandStream(sessionId, runId, request.command, promise),
				result: promise.then(value => ({
					id: runId,
					sessionId,
					chatId: 'chat-1',
					adapterId: this.id,
					status: 'completed',
					outputKind: 'text',
					filesChanged: [],
					questionsAsked: [],
					terminalCommands: [],
					completedAt: new Date().toISOString(),
					errorMessage: value,
				})),
			};
		}
		return {
			runId,
			stream: singleUseStream([
				{ type: 'command.started', runId, sessionId, command: request.command },
				{ type: 'command.completed', runId, sessionId, command: request.command },
			]),
			result: Promise.resolve({
				id: runId,
				sessionId,
				chatId: 'chat-1',
				adapterId: this.id,
				status: 'completed',
				outputKind: 'text',
				filesChanged: [],
				questionsAsked: [],
				terminalCommands: [],
				completedAt: new Date().toISOString(),
			}),
		};
	}

	public async submitCommandInput(_sessionId: string, runId: string, input: string): Promise<void> {
		this.pendingCommandInputs.get(runId)?.resolve(input);
	}

	public async executeTerminalCommand(sessionId: string, request: AgentTerminalCommandRequest): Promise<AgentAdapterRun> {
		const runId = `run-${++this.runCounter}`;
		return {
			runId,
			stream: singleUseStream([
				{ type: 'terminal.started', runId, sessionId, command: request },
				{ type: 'terminal.stdout', runId, sessionId, text: `executed ${request.command}` },
				{ type: 'terminal.exited', runId, sessionId, exitCode: 0 },
			]),
			result: Promise.resolve({
				id: runId,
				sessionId,
				chatId: 'chat-1',
				adapterId: this.id,
				status: 'completed',
				outputKind: 'text',
				filesChanged: [],
				questionsAsked: [],
				terminalCommands: [request],
				completedAt: new Date().toISOString(),
			}),
		};
	}

	public async interrupt(_sessionId: string, runId: string): Promise<void> {
		this.slowRuns.get(runId)?.resolve({
			id: runId,
			sessionId: 'slow',
			chatId: 'chat-1',
			adapterId: this.id,
			status: 'interrupted',
			outputKind: 'text',
			filesChanged: [],
			questionsAsked: [],
			terminalCommands: [],
			completedAt: new Date().toISOString(),
		});
	}

	public async createCheckpoint(sessionId: string, chatId = 'chat-1', label?: string): Promise<AgentAdapterCheckpoint> {
		const checkpoint: AgentAdapterCheckpoint = {
			id: `checkpoint-${++this.checkpointCounter}`,
			sessionId,
			chatId,
			createdAt: new Date().toISOString(),
			label,
			transcript: {
				sessionId,
				chatId,
				messages: [...(this.transcripts.get(sessionId) ?? [])],
			},
			native: { id: `native-${this.checkpointCounter}` },
		};
		this.checkpoints.get(sessionId)?.push(checkpoint);
		return checkpoint;
	}

	public async listCheckpoints(sessionId: string): Promise<readonly AgentAdapterCheckpoint[]> {
		return this.checkpoints.get(sessionId) ?? [];
	}

	public async revertToCheckpoint(sessionId: string, checkpointId: string): Promise<AgentAdapterCheckpoint> {
		const checkpoint = (this.checkpoints.get(sessionId) ?? []).find(item => item.id === checkpointId);
		if (!checkpoint) {
			throw new Error(`Missing checkpoint ${checkpointId}`);
		}
		this.transcripts.set(sessionId, [...checkpoint.transcript.messages]);
		return checkpoint;
	}

	public async truncateConversation(sessionId: string, _chatId: string, messageId: string): Promise<void> {
		const transcript = this.transcripts.get(sessionId) ?? [];
		const targetIndex = transcript.findIndex(message => message.id === messageId);
		if (targetIndex === -1) {
			throw new Error(`Missing message ${messageId}`);
		}
		this.transcripts.set(sessionId, transcript.slice(0, targetIndex));
	}

	private async createMessageRun(sessionId: string, request: AgentSendMessageRequest, editedFromMessageId: string | undefined): Promise<AgentAdapterRun> {
		const runId = `run-${++this.runCounter}`;
		const chatId = request.chatId ?? 'chat-1';
		const userMessageId = `message-${++this.messageCounter}`;
		const assistantMessageId = `message-${++this.messageCounter}`;
		const transcript = this.transcripts.get(sessionId) ?? [];
		const userMessage: AgentMessage = {
			id: userMessageId,
			role: 'user',
			createdAt: new Date().toISOString(),
			modelId: request.options?.modelId,
			reasoningEffort: request.options?.reasoningEffort,
			editedFromMessageId,
			parts: [{ kind: 'text', text: request.content }],
		};
		const assistantMessage: AgentMessage = {
			id: assistantMessageId,
			role: 'assistant',
			createdAt: new Date().toISOString(),
			modelId: request.options?.modelId,
			reasoningEffort: request.options?.reasoningEffort,
			parts: [{ kind: 'text', text: `reply:${request.content}` }],
		};
		this.transcripts.set(sessionId, [...transcript, userMessage, assistantMessage]);

		if (request.content.includes('slow')) {
			let resolveSummary!: (summary: AgentRunSummary) => void;
			const summaryPromise = new Promise<AgentRunSummary>(resolve => {
				resolveSummary = resolve;
			});
			this.slowRuns.set(runId, { resolve: resolveSummary, promise: summaryPromise });
			return {
				runId,
				stream: singleUseStream([{ type: 'run.started', runId, sessionId, chatId, adapterId: this.id, modelId: request.options?.modelId, reasoningEffort: request.options?.reasoningEffort }]),
				result: summaryPromise,
			};
		}

		const question: AgentQuestionRequest = {
			id: 'question-1',
			prompt: 'Need more input?',
			required: true,
		};
		const events: AgentStreamEvent[] = [
			{ type: 'run.started', runId, sessionId, chatId, adapterId: this.id, modelId: request.options?.modelId, reasoningEffort: request.options?.reasoningEffort },
			{ type: 'reasoning.delta', runId, sessionId, chatId, text: 'thinking' },
			{ type: 'chat.message.delta', runId, sessionId, chatId, messageId: assistantMessageId, role: 'assistant', text: `reply:${request.content}` },
			{ type: 'markdown.delta', runId, sessionId, chatId, messageId: assistantMessageId, markdown: `# ${request.content}` },
			{ type: 'code.delta', runId, sessionId, chatId, messageId: assistantMessageId, code: `console.log(${JSON.stringify(request.content)})`, language: 'ts' },
			{ type: 'files.changed', runId, sessionId, files: [{ path: 'src/example.ts', change: 'modified' }] },
			{ type: 'question.asked', runId, sessionId, chatId, question },
		];
		return {
			runId,
			stream: singleUseStream(events),
			result: Promise.resolve({
				id: runId,
				sessionId,
				chatId,
				adapterId: this.id,
				status: 'completed',
				outputKind: 'mixed',
				modelId: request.options?.modelId,
				reasoningEffort: request.options?.reasoningEffort,
				lastMessageId: assistantMessageId,
				filesChanged: [{ path: 'src/example.ts', change: 'modified' }],
				questionsAsked: [question],
				terminalCommands: [],
				completedAt: new Date().toISOString(),
			}),
		};
	}

	private async *commandStream(sessionId: string, runId: string, command: string, inputPromise: Promise<string>): AsyncIterable<AgentStreamEvent> {
		yield { type: 'command.started', runId, sessionId, command };
		yield { type: 'command.inputRequested', runId, sessionId, command, prompt: 'More details?' };
		const value = await inputPromise;
		yield { type: 'question.answered', runId, sessionId, chatId: 'chat-1', questionId: 'command-input', value };
		yield { type: 'command.completed', runId, sessionId, command };
	}

	private mustGetSession(sessionId: string): AgentAdapterSessionSummary {
		const session = this.sessions.get(sessionId);
		if (!session) {
			throw new Error(`Missing session ${sessionId}`);
		}
		return session;
	}
}

function singleUseStream(events: readonly AgentStreamEvent[]): AsyncIterable<AgentStreamEvent> {
	return {
		async *[Symbol.asyncIterator]() {
			for (const event of events) {
				yield event;
			}
		},
	};
}

async function collectEvents(stream: AsyncIterable<AgentStreamEvent>): Promise<readonly AgentStreamEvent[]> {
	const events: AgentStreamEvent[] = [];
	for await (const event of stream) {
		events.push(event);
	}
	return events;
}

function createFakeAdapter(id: string): FakeAgentAdapter {
	return new FakeAgentAdapter(
		id,
		id.includes('claude') ? 'anthropic' : 'openai',
		[
			{
				id: `${id}-default`,
				adapterId: id,
				provider: id,
				label: 'Default',
				supportsReasoning: true,
				supportsImages: true,
				supportsTools: true,
				availableReasoningEfforts: ['low', 'high'],
				isDefault: true,
				native: { id: `${id}-default` },
			},
			{
				id: `${id}-advanced`,
				adapterId: id,
				provider: id,
				label: 'Advanced',
				supportsReasoning: true,
				supportsImages: true,
				supportsTools: true,
				availableReasoningEfforts: ['medium', 'max'],
				isDefault: false,
				native: { id: `${id}-advanced` },
			},
		],
		{
			[`${id}-default`]: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }],
			[`${id}-advanced`]: [{ id: 'medium', label: 'Medium' }, { id: 'max', label: 'Max' }],
		},
	);
}

describe('AgentCore', () => {
	it('registers adapters and rejects duplicates', () => {
		const core = new AgentCore();
		core.registerAdapter(createFakeAdapter('claude-code'));
		expect(() => core.registerAdapter(createFakeAdapter('claude-code'))).toThrowError(AgentValidationError);
	});

	it('aggregates models and reasoning options across adapters', async () => {
		const core = new AgentCore();
		core.registerAdapter(createFakeAdapter('claude-code'));
		core.registerAdapter(createFakeAdapter('openai-codex'));

		const models = await core.listModels();
		const reasoning = await core.listReasoningOptions('claude-code', 'claude-code-default');

		expect(models.map(model => model.id)).toEqual([
			'claude-code-default',
			'claude-code-advanced',
			'openai-codex-default',
			'openai-codex-advanced',
		]);
		expect(reasoning.map(option => option.id)).toEqual(['low', 'high']);
	});

	it('stores session defaults and lets a send override them per turn', async () => {
		const core = new AgentCore();
		core.registerAdapter(createFakeAdapter('claude-code'));
		const session = await core.createSession('claude-code', {
			defaults: { modelId: 'claude-code-default', reasoningEffort: 'low' },
		});

		await core.updateSessionDefaults(session.id, { modelId: 'claude-code-advanced', reasoningEffort: 'medium' });
		const handle = await core.sendMessage(session.id, 'hello', { modelId: 'claude-code-default', reasoningEffort: 'high' });
		const summary = await handle.result;

		expect(await core.getSessionDefaults(session.id)).toEqual({ modelId: 'claude-code-advanced', reasoningEffort: 'medium' });
		expect({ modelId: summary.modelId, reasoningEffort: summary.reasoningEffort }).toEqual({
			modelId: 'claude-code-default',
			reasoningEffort: 'high',
		});
	});

	it('rejects invalid model ids and reasoning efforts', async () => {
		const core = new AgentCore();
		core.registerAdapter(createFakeAdapter('claude-code'));
		const session = await core.createSession('claude-code');

		await expect(core.sendMessage(session.id, 'hello', { modelId: 'missing-model' })).rejects.toThrowError(AgentValidationError);
		await expect(core.sendMessage(session.id, 'hello', { modelId: 'claude-code-default', reasoningEffort: 'invalid' })).rejects.toThrowError(AgentValidationError);
	});

	it('streams reasoning, markdown, code, files changed, and completion events in order', async () => {
		const core = new AgentCore();
		core.registerAdapter(createFakeAdapter('claude-code'));
		const session = await core.createSession('claude-code');

		const handle = await core.sendMessage(session.id, 'stream me', { modelId: 'claude-code-default', reasoningEffort: 'low' });
		const events = await collectEvents(handle.stream);
		const summary = await handle.result;

		expect(events.map(event => event.type)).toEqual([
			'run.started',
			'reasoning.delta',
			'chat.message.delta',
			'markdown.delta',
			'code.delta',
			'files.changed',
			'question.asked',
		]);
		expect(summary.status).toBe('completed');
		expect(summary.id).toBe(handle.runId);
	});

	it('maps standard commands and supports command input continuation', async () => {
		const core = new AgentCore();
		core.registerAdapter(createFakeAdapter('claude-code'));
		const session = await core.createSession('claude-code');

		const planRun = await core.runStandardCommand(session.id, 'plan');
		expect((await planRun.result).status).toBe('completed');

		const interactiveRun = await core.runPassthroughCommand(session.id, '/needs-input');
		const eventsPromise = collectEvents(interactiveRun.stream);
		await core.submitCommandInput(session.id, interactiveRun.runId, 'details');
		const events = await eventsPromise;
		const summary = await interactiveRun.result;

		expect(events.map(event => event.type)).toEqual([
			'command.started',
			'command.inputRequested',
			'question.answered',
			'command.completed',
		]);
		expect(summary.errorMessage).toBe('details');
	});

	it('creates, lists, and reverts checkpoints', async () => {
		const core = new AgentCore();
		core.registerAdapter(createFakeAdapter('claude-code'));
		const session = await core.createSession('claude-code');

		await core.sendMessage(session.id, 'first');
		const checkpoint = await core.createCheckpoint(session.id, 'chat-1', 'before-edit');
		await core.sendMessage(session.id, 'second');
		const checkpoints = await core.listCheckpoints(session.id);
		await core.revertToCheckpoint(session.id, checkpoint.id);
		const transcript = await core.getChatTranscript(session.id, 'chat-1');

		expect(checkpoints.map(item => item.id)).toEqual([checkpoint.id]);
		expect(transcript.messages.some(message => message.parts.some(part => part.kind === 'text' && part.text === 'second'))).toBe(false);
	});

	it('edits and resends by truncating the prior transcript', async () => {
		const core = new AgentCore();
		core.registerAdapter(createFakeAdapter('claude-code'));
		const session = await core.createSession('claude-code');

		await core.sendMessage(session.id, 'original');
		const beforeEdit = await core.getChatTranscript(session.id, 'chat-1');
		const userMessage = beforeEdit.messages.find(message => message.role === 'user');
		if (!userMessage) {
			throw new Error('Expected a user message');
		}

		await core.editMessage(session.id, 'chat-1', userMessage.id, 'replacement');
		const afterEdit = await core.getChatTranscript(session.id, 'chat-1');

		expect(afterEdit.messages.some(message => message.parts.some(part => part.kind === 'text' && part.text === 'original'))).toBe(false);
		expect(afterEdit.messages.some(message => message.parts.some(part => part.kind === 'text' && part.text === 'replacement'))).toBe(true);
	});

	it('interrupts an active run', async () => {
		const core = new AgentCore();
		core.registerAdapter(createFakeAdapter('claude-code'));
		const session = await core.createSession('claude-code');

		const handle = await core.sendMessage(session.id, 'slow message');
		await handle.interrupt();
		const summary = await handle.result;

		expect(summary.status).toBe('interrupted');
	});

	it('resolves @file mentions into file attachments', async () => {
		const core = new AgentCore();
		const adapter = createFakeAdapter('claude-code');
		core.registerAdapter(adapter);
		const session = await core.createSession('claude-code');
		const tempDir = path.join(process.cwd(), 'tmp', 'agent-core-mentions');
		const filePath = path.join(tempDir, 'example.ts');
		await mkdir(tempDir, { recursive: true });
		await writeFile(filePath, 'export const answer = 42;\n', 'utf8');

		try {
			await core.sendMessage(session.id, 'please inspect @example.ts', {
				metadata: { cwd: tempDir },
			});

			expect(adapter.sentRequests.at(-1)?.options?.attachments).toEqual([
				{
					kind: 'file',
					name: 'example.ts',
					uri: filePath,
					content: 'export const answer = 42;\n',
					metadata: {
						path: filePath,
						mention: 'example.ts',
					},
				},
			]);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it('supports quoted @file mentions with spaces and dedupes duplicates', async () => {
		const core = new AgentCore();
		const adapter = createFakeAdapter('claude-code');
		core.registerAdapter(adapter);
		const session = await core.createSession('claude-code');
		const tempDir = path.join(process.cwd(), 'tmp', 'agent-core-quoted-mentions');
		const filePath = path.join(tempDir, 'folder name', 'demo file.md');
		await mkdir(path.dirname(filePath), { recursive: true });
		await writeFile(filePath, '# demo\n', 'utf8');

		try {
			await core.sendMessage(session.id, 'check @"folder name/demo file.md" and @"folder name/demo file.md"', {
				metadata: { cwd: tempDir },
			});

			expect(adapter.sentRequests.at(-1)?.options?.attachments).toHaveLength(1);
			expect(adapter.sentRequests.at(-1)?.options?.attachments?.[0]?.uri).toBe(filePath);
		} finally {
			await rm(tempDir, { recursive: true, force: true });
		}
	});

	it('throws a validation error when a mentioned file does not exist', async () => {
		const core = new AgentCore();
		core.registerAdapter(createFakeAdapter('claude-code'));
		const session = await core.createSession('claude-code');

		await expect(core.sendMessage(session.id, 'open @missing.ts', {
			metadata: { cwd: path.join(process.cwd(), 'tmp', 'missing-mentions') },
		})).rejects.toThrowError(AgentValidationError);
	});
});
