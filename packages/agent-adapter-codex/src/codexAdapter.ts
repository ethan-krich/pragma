/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ethan Krich. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import {
	AgentAdapter,
	AgentAdapterCheckpoint,
	AgentAdapterRun,
	AgentAdapterSessionSummary,
	AgentCapabilities,
	AgentCapabilityError,
	AgentChatSummary,
	AgentCommandError,
	AgentCommandRequest,
	AgentCreateSessionRequest,
	AgentModelDescriptor,
	AgentReasoningOption,
	AgentSendMessageRequest,
	AgentSessionDefaults,
	AgentStandardCommandId,
	AgentTerminalCommandRequest,
	AgentTurnOptions,
} from '@pragma/agent-core';
import type { CodexTransport } from './codexTransport.js';

const CODEX_CAPABILITIES: AgentCapabilities = {
	supportsImages: true,
	supportsReasoning: true,
	supportsTerminalCommands: true,
	supportsCheckpointRestore: true,
	supportsEditing: true,
	supportsPassthroughCommands: true,
};

const BLOCKED_COMMANDS = new Set(['worktree']);

export interface CodexAdapterOptions {
	readonly transports?: readonly CodexTransport[];
}

export class CodexAdapter implements AgentAdapter {
	public readonly id = 'openai-codex';
	public readonly provider = 'openai';
	public readonly displayName = 'Codex';
	public readonly capabilities = CODEX_CAPABILITIES;
	private selectedTransport?: CodexTransport;

	public constructor(private readonly options: CodexAdapterOptions = {}) { }

	public getStandardCommandMappings(): Partial<Record<AgentStandardCommandId, string>> {
		return {
			plan: '/plan',
			resume: '/resume',
			help: '/help',
			interrupt: '/interrupt',
			'checkpoint.list': '/checkpoints',
			'checkpoint.revert': '/restore-checkpoint',
		};
	}

	public async listModels(): Promise<readonly AgentModelDescriptor[]> {
		const transport = await this.getTransport();
		return this.normalizeModels(await transport.listModels());
	}

	public async listReasoningOptions(modelId?: string): Promise<readonly AgentReasoningOption[]> {
		return (await this.getTransport()).listReasoningOptions(modelId);
	}

	public async listSessions(): Promise<readonly AgentAdapterSessionSummary[]> {
		return (await this.getTransport()).listSessions();
	}

	public async getSession(sessionId: string): Promise<AgentAdapterSessionSummary | undefined> {
		return (await this.getTransport()).getSession(sessionId);
	}

	public async createSession(request: AgentCreateSessionRequest): Promise<AgentAdapterSessionSummary> {
		return (await this.getTransport()).createSession(request);
	}

	public async archiveSession(sessionId: string): Promise<void> {
		await (await this.getTransport()).archiveSession(sessionId);
	}

	public async deleteSession(sessionId: string): Promise<void> {
		await (await this.getTransport()).deleteSession(sessionId);
	}

	public async listChats(sessionId: string): Promise<readonly AgentChatSummary[]> {
		return (await this.getTransport()).listChats(sessionId);
	}

	public async getChatTranscript(sessionId: string, chatId?: string): Promise<{ sessionId: string; chatId: string; messages: readonly import('@pragma/agent-core').AgentMessage[] }> {
		return (await this.getTransport()).getChatTranscript(sessionId, chatId);
	}

	public async getSessionDefaults(sessionId: string): Promise<AgentSessionDefaults> {
		return (await this.getTransport()).getSessionDefaults(sessionId);
	}

	public async updateSessionDefaults(sessionId: string, defaults: Partial<AgentSessionDefaults>): Promise<AgentSessionDefaults> {
		return (await this.getTransport()).updateSessionDefaults(sessionId, defaults);
	}

	public async sendMessage(sessionId: string, request: AgentSendMessageRequest): Promise<AgentAdapterRun> {
		return (await this.getTransport()).sendMessage(sessionId, request);
	}

	public async executeCommand(sessionId: string, request: AgentCommandRequest, _options?: AgentTurnOptions): Promise<AgentAdapterRun> {
		const commandName = this.getCommandName(request.command);
		if (BLOCKED_COMMANDS.has(commandName)) {
			throw new AgentCommandError(`Codex does not allow the "${commandName}" command through this adapter.`);
		}
		return (await this.getTransport()).executeCommand(sessionId, request);
	}

	public async submitCommandInput(sessionId: string, runId: string, input: string): Promise<void> {
		await (await this.getTransport()).submitCommandInput(sessionId, runId, input);
	}

	public async executeTerminalCommand(sessionId: string, request: AgentTerminalCommandRequest): Promise<AgentAdapterRun> {
		return (await this.getTransport()).executeTerminalCommand(sessionId, request);
	}

	public async interrupt(sessionId: string, runId: string): Promise<void> {
		await (await this.getTransport()).interrupt(sessionId, runId);
	}

	public async createCheckpoint(sessionId: string, chatId?: string, label?: string): Promise<AgentAdapterCheckpoint> {
		return (await this.getTransport()).createCheckpoint(sessionId, chatId, label);
	}

	public async listCheckpoints(sessionId: string): Promise<readonly AgentAdapterCheckpoint[]> {
		return (await this.getTransport()).listCheckpoints(sessionId);
	}

	public async revertToCheckpoint(sessionId: string, checkpointId: string): Promise<AgentAdapterCheckpoint> {
		return (await this.getTransport()).revertToCheckpoint(sessionId, checkpointId);
	}

	public async truncateConversation(sessionId: string, chatId: string, messageId: string): Promise<void> {
		await (await this.getTransport()).truncateConversation(sessionId, chatId, messageId);
	}

	private async getTransport(): Promise<CodexTransport> {
		if (this.selectedTransport && await this.selectedTransport.isAvailable()) {
			return this.selectedTransport;
		}
		const transports = this.options.transports ?? [];
		const preferredBridge = transports.find(transport => transport.kind === 'bridge');
		if (preferredBridge && await preferredBridge.isAvailable()) {
			this.selectedTransport = preferredBridge;
			return preferredBridge;
		}
		const fallbackSdk = transports.find(transport => transport.kind === 'sdk');
		if (fallbackSdk && await fallbackSdk.isAvailable()) {
			this.selectedTransport = fallbackSdk;
			return fallbackSdk;
		}
		throw new AgentCapabilityError('No Codex transport is available.');
	}

	private normalizeModels(models: readonly AgentModelDescriptor[]): readonly AgentModelDescriptor[] {
		return models.map(model => ({
			...model,
			adapterId: this.id,
			provider: this.provider,
		}));
	}

	private getCommandName(command: string): string {
		return command.trim().replace(/^\//u, '').split(/\s+/u)[0] ?? '';
	}
}
