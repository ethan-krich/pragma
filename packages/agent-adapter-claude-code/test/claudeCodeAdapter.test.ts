/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ethan Krich. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from 'vitest';
import type {
	AgentAdapterCheckpoint,
	AgentAdapterRun,
	AgentAdapterSessionSummary,
	AgentChatSummary,
	AgentCommandRequest,
	AgentCreateSessionRequest,
	AgentMessage,
	AgentModelDescriptor,
	AgentReasoningOption,
	AgentSendMessageRequest,
	AgentSessionDefaults,
	AgentTerminalCommandRequest,
	AgentStreamEvent,
} from '@pragma/agent-core';
import { AgentCommandError } from '@pragma/agent-core';
import {
	Adapter,
	ClaudeCodeAdapter,
	ClaudeSdkTransport,
	ClaudeSignedInBridgeTransport,
	SdkTransport,
	SignedInBridgeTransport,
	type ClaudeTransportDriver,
} from '../src/index.js';

class MockClaudeDriver implements ClaudeTransportDriver {
	public readonly sentMessages: AgentSendMessageRequest[] = [];
	public readonly commands: AgentCommandRequest[] = [];
	public defaults: AgentSessionDefaults = {};

	public constructor(private readonly models: readonly AgentModelDescriptor[]) { }

	public async listModels(): Promise<readonly AgentModelDescriptor[]> { return this.models; }
	public async listReasoningOptions(modelId?: string): Promise<readonly AgentReasoningOption[]> {
		return this.models.find(model => model.id === modelId)?.availableReasoningEfforts.map(id => ({ id, label: id })) ?? [];
	}
	public async listSessions(): Promise<readonly AgentAdapterSessionSummary[]> { return []; }
	public async getSession(_sessionId: string): Promise<AgentAdapterSessionSummary | undefined> { return undefined; }
	public async createSession(request: AgentCreateSessionRequest): Promise<AgentAdapterSessionSummary> {
		this.defaults = request.defaults ?? {};
		return { id: 'claude-session', title: 'Claude Session', createdAt: now(), updatedAt: now(), defaults: this.defaults };
	}
	public async archiveSession(_sessionId: string): Promise<void> { }
	public async deleteSession(_sessionId: string): Promise<void> { }
	public async listChats(_sessionId: string): Promise<readonly AgentChatSummary[]> { return [{ id: 'chat-1', title: 'Chat', createdAt: now(), updatedAt: now(), messageCount: 0 }]; }
	public async getChatTranscript(sessionId: string, chatId = 'chat-1'): Promise<{ sessionId: string; chatId: string; messages: readonly AgentMessage[] }> { return { sessionId, chatId, messages: [] }; }
	public async getSessionDefaults(_sessionId: string): Promise<AgentSessionDefaults> { return this.defaults; }
	public async updateSessionDefaults(_sessionId: string, defaults: Partial<AgentSessionDefaults>): Promise<AgentSessionDefaults> { this.defaults = { ...this.defaults, ...defaults }; return this.defaults; }
	public async sendMessage(_sessionId: string, request: AgentSendMessageRequest): Promise<AgentAdapterRun> { this.sentMessages.push(request); return completedRun('claude-run'); }
	public async executeCommand(_sessionId: string, request: AgentCommandRequest): Promise<AgentAdapterRun> { this.commands.push(request); return request.command === '/btw' ? interactiveRun('claude-btw', request.command) : completedRun('claude-command'); }
	public async submitCommandInput(_sessionId: string, _runId: string, _input: string): Promise<void> { }
	public async executeTerminalCommand(_sessionId: string, _request: AgentTerminalCommandRequest): Promise<AgentAdapterRun> { return completedRun('claude-terminal'); }
	public async interrupt(_sessionId: string, _runId: string): Promise<void> { }
	public async createCheckpoint(sessionId: string, chatId = 'chat-1'): Promise<AgentAdapterCheckpoint> { return { id: 'checkpoint-1', sessionId, chatId, createdAt: now(), transcript: { sessionId, chatId, messages: [] } }; }
	public async listCheckpoints(_sessionId: string): Promise<readonly AgentAdapterCheckpoint[]> { return []; }
	public async revertToCheckpoint(sessionId: string, checkpointId: string): Promise<AgentAdapterCheckpoint> { return { id: checkpointId, sessionId, chatId: 'chat-1', createdAt: now(), transcript: { sessionId, chatId: 'chat-1', messages: [] } }; }
	public async truncateConversation(_sessionId: string, _chatId: string, _messageId: string): Promise<void> { }
}

function completedRun(runId: string): AgentAdapterRun {
	return {
		runId,
		stream: singleUseStream([]),
		result: Promise.resolve({
			id: runId,
			sessionId: 'claude-session',
			chatId: 'chat-1',
			adapterId: 'claude-code',
			status: 'completed',
			outputKind: 'text',
			filesChanged: [],
			questionsAsked: [],
			terminalCommands: [],
			completedAt: now(),
		}),
	};
}

function interactiveRun(runId: string, command: string): AgentAdapterRun {
	return {
		runId,
		stream: singleUseStream([
			{ type: 'command.started', runId, sessionId: 'claude-session', command },
			{ type: 'command.inputRequested', runId, sessionId: 'claude-session', command, prompt: 'Extra context?' },
		]),
		result: Promise.resolve({
			id: runId,
			sessionId: 'claude-session',
			chatId: 'chat-1',
			adapterId: 'claude-code',
			status: 'completed',
			outputKind: 'text',
			filesChanged: [],
			questionsAsked: [],
			terminalCommands: [],
			completedAt: now(),
		}),
	};
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

function now(): string {
	return new Date().toISOString();
}

describe('ClaudeCodeAdapter', () => {
	it('exposes the standard adapter and transport export names', () => {
		expect(Adapter).toBe(ClaudeCodeAdapter);
		expect(SdkTransport).toBe(ClaudeSdkTransport);
		expect(SignedInBridgeTransport).toBe(ClaudeSignedInBridgeTransport);
	});

	it('prefers the signed-in bridge transport when available', async () => {
		const bridgeDriver = new MockClaudeDriver([]);
		const sdkDriver = new MockClaudeDriver([]);
		const bridge = new ClaudeSignedInBridgeTransport('bridge', bridgeDriver);
		const sdk = new ClaudeSdkTransport('sdk', sdkDriver);
		const adapter = new ClaudeCodeAdapter({ transports: [sdk, bridge] });

		await adapter.listSessions();
		await adapter.sendMessage('claude-session', { content: 'hello' });

		expect(bridgeDriver.sentMessages).toHaveLength(1);
		expect(sdkDriver.sentMessages).toHaveLength(0);
	});

	it('falls back to the sdk transport when the bridge is unavailable', async () => {
		const bridgeDriver = new MockClaudeDriver([]);
		const sdkDriver = new MockClaudeDriver([]);
		const bridge = new ClaudeSignedInBridgeTransport('bridge', bridgeDriver, async () => false);
		const sdk = new ClaudeSdkTransport('sdk', sdkDriver);
		const adapter = new ClaudeCodeAdapter({ transports: [bridge, sdk] });

		await adapter.sendMessage('claude-session', { content: 'hello' });

		expect(sdkDriver.sentMessages).toHaveLength(1);
	});

	it('returns adapter-discovered models and reasoning options', async () => {
		const driver = new MockClaudeDriver([
			{
				id: 'claude-opus',
				adapterId: 'ignored',
				provider: 'ignored',
				label: 'Claude Opus',
				supportsReasoning: true,
				supportsImages: true,
				supportsTools: true,
				availableReasoningEfforts: ['low', 'high'],
				isDefault: true,
				native: { id: 'claude-opus' },
			},
		]);
		const adapter = new ClaudeCodeAdapter({ transports: [new ClaudeSignedInBridgeTransport('bridge', driver)] });

		const models = await adapter.listModels();
		const reasoning = await adapter.listReasoningOptions('claude-opus');

		expect(models).toEqual([{
			id: 'claude-opus',
			adapterId: 'claude-code',
			provider: 'anthropic',
			label: 'Claude Opus',
			supportsReasoning: true,
			supportsImages: true,
			supportsTools: true,
			availableReasoningEfforts: ['low', 'high'],
			isDefault: true,
			native: { id: 'claude-opus' },
		}]);
		expect(reasoning.map(option => option.id)).toEqual(['low', 'high']);
	});

	it('forwards the selected model and reasoning effort on sends', async () => {
		const driver = new MockClaudeDriver([]);
		const adapter = new ClaudeCodeAdapter({ transports: [new ClaudeSignedInBridgeTransport('bridge', driver)] });

		await adapter.sendMessage('claude-session', {
			content: 'ship it',
			options: { modelId: 'claude-opus', reasoningEffort: 'high' },
		});

		expect(driver.sentMessages[0]).toMatchObject({
			options: { modelId: 'claude-opus', reasoningEffort: 'high' },
		});
	});

	it('blocks source-control and worktree commands', async () => {
		const driver = new MockClaudeDriver([]);
		const adapter = new ClaudeCodeAdapter({ transports: [new ClaudeSignedInBridgeTransport('bridge', driver)] });

		await expect(adapter.executeCommand('claude-session', { command: '/worktree' })).rejects.toThrowError(AgentCommandError);
		await expect(adapter.executeCommand('claude-session', { command: '/git status' })).rejects.toThrowError(AgentCommandError);
	});

	it('forwards commands that require follow-up input like /btw', async () => {
		const driver = new MockClaudeDriver([]);
		const adapter = new ClaudeCodeAdapter({ transports: [new ClaudeSignedInBridgeTransport('bridge', driver)] });

		const run = await adapter.executeCommand('claude-session', { command: '/btw' });
		const events = [];
		for await (const event of run.stream) {
			events.push(event.type);
		}

		expect(driver.commands).toEqual([{ command: '/btw' }]);
		expect(events).toEqual(['command.started', 'command.inputRequested']);
	});
});
