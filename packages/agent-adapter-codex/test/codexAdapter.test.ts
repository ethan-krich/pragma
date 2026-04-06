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
	CodexAdapter,
	CodexSdkTransport,
	CodexSignedInBridgeTransport,
	SdkTransport,
	SignedInBridgeTransport,
	type CodexTransportDriver,
} from '../src/index.js';

class MockCodexDriver implements CodexTransportDriver {
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
		return { id: 'codex-session', title: 'Codex Session', createdAt: now(), updatedAt: now(), defaults: this.defaults };
	}
	public async archiveSession(_sessionId: string): Promise<void> { }
	public async deleteSession(_sessionId: string): Promise<void> { }
	public async listChats(_sessionId: string): Promise<readonly AgentChatSummary[]> { return [{ id: 'chat-1', title: 'Chat', createdAt: now(), updatedAt: now(), messageCount: 0 }]; }
	public async getChatTranscript(sessionId: string, chatId = 'chat-1'): Promise<{ sessionId: string; chatId: string; messages: readonly AgentMessage[] }> { return { sessionId, chatId, messages: [] }; }
	public async getSessionDefaults(_sessionId: string): Promise<AgentSessionDefaults> { return this.defaults; }
	public async updateSessionDefaults(_sessionId: string, defaults: Partial<AgentSessionDefaults>): Promise<AgentSessionDefaults> { this.defaults = { ...this.defaults, ...defaults }; return this.defaults; }
	public async sendMessage(_sessionId: string, request: AgentSendMessageRequest): Promise<AgentAdapterRun> { this.sentMessages.push(request); return completedRun('codex-run'); }
	public async executeCommand(_sessionId: string, request: AgentCommandRequest): Promise<AgentAdapterRun> { this.commands.push(request); return completedRun('codex-command'); }
	public async submitCommandInput(_sessionId: string, _runId: string, _input: string): Promise<void> { }
	public async executeTerminalCommand(_sessionId: string, _request: AgentTerminalCommandRequest): Promise<AgentAdapterRun> { return completedRun('codex-terminal'); }
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
			sessionId: 'codex-session',
			chatId: 'chat-1',
			adapterId: 'openai-codex',
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

describe('CodexAdapter', () => {
	it('exposes the standard adapter and transport export names', () => {
		expect(Adapter).toBe(CodexAdapter);
		expect(SdkTransport).toBe(CodexSdkTransport);
		expect(SignedInBridgeTransport).toBe(CodexSignedInBridgeTransport);
	});

	it('prefers the signed-in bridge transport when available', async () => {
		const bridgeDriver = new MockCodexDriver([]);
		const sdkDriver = new MockCodexDriver([]);
		const bridge = new CodexSignedInBridgeTransport('bridge', bridgeDriver);
		const sdk = new CodexSdkTransport('sdk', sdkDriver);
		const adapter = new CodexAdapter({ transports: [sdk, bridge] });

		await adapter.sendMessage('codex-session', { content: 'hello' });

		expect(bridgeDriver.sentMessages).toHaveLength(1);
		expect(sdkDriver.sentMessages).toHaveLength(0);
	});

	it('falls back to the sdk transport when the bridge is unavailable', async () => {
		const bridgeDriver = new MockCodexDriver([]);
		const sdkDriver = new MockCodexDriver([]);
		const bridge = new CodexSignedInBridgeTransport('bridge', bridgeDriver, async () => false);
		const sdk = new CodexSdkTransport('sdk', sdkDriver);
		const adapter = new CodexAdapter({ transports: [bridge, sdk] });

		await adapter.sendMessage('codex-session', { content: 'hello' });

		expect(sdkDriver.sentMessages).toHaveLength(1);
	});

	it('returns adapter-discovered models and reasoning options', async () => {
		const driver = new MockCodexDriver([
			{
				id: 'gpt-5',
				adapterId: 'ignored',
				provider: 'ignored',
				label: 'GPT-5',
				supportsReasoning: true,
				supportsImages: true,
				supportsTools: true,
				availableReasoningEfforts: ['minimal', 'high'],
				isDefault: true,
				native: { id: 'gpt-5' },
			},
		]);
		const adapter = new CodexAdapter({ transports: [new CodexSignedInBridgeTransport('bridge', driver)] });

		const models = await adapter.listModels();
		const reasoning = await adapter.listReasoningOptions('gpt-5');

		expect(models).toEqual([{
			id: 'gpt-5',
			adapterId: 'openai-codex',
			provider: 'openai',
			label: 'GPT-5',
			supportsReasoning: true,
			supportsImages: true,
			supportsTools: true,
			availableReasoningEfforts: ['minimal', 'high'],
			isDefault: true,
			native: { id: 'gpt-5' },
		}]);
		expect(reasoning.map(option => option.id)).toEqual(['minimal', 'high']);
	});

	it('forwards the selected model and reasoning effort on sends', async () => {
		const driver = new MockCodexDriver([]);
		const adapter = new CodexAdapter({ transports: [new CodexSignedInBridgeTransport('bridge', driver)] });

		await adapter.sendMessage('codex-session', {
			content: 'ship it',
			options: { modelId: 'gpt-5', reasoningEffort: 'high' },
		});

		expect(driver.sentMessages[0]).toMatchObject({
			options: { modelId: 'gpt-5', reasoningEffort: 'high' },
		});
	});

	it('blocks worktree commands while forwarding other commands', async () => {
		const driver = new MockCodexDriver([]);
		const adapter = new CodexAdapter({ transports: [new CodexSignedInBridgeTransport('bridge', driver)] });

		await expect(adapter.executeCommand('codex-session', { command: '/worktree' })).rejects.toThrowError(AgentCommandError);
		await adapter.executeCommand('codex-session', { command: '/plan' });

		expect(driver.commands).toEqual([{ command: '/plan' }]);
	});

	it('maps the native plan command to the canonical plan standard', () => {
		const adapter = new CodexAdapter();
		expect(adapter.getStandardCommandMappings().plan).toBe('/plan');
	});
});
