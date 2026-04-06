/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ethan Krich. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export type AgentStandardCommandId =
	| 'plan'
	| 'resume'
	| 'help'
	| 'interrupt'
	| 'checkpoint.list'
	| 'checkpoint.revert';

export interface AgentCapabilities {
	readonly supportsImages: boolean;
	readonly supportsReasoning: boolean;
	readonly supportsTerminalCommands: boolean;
	readonly supportsCheckpointRestore: boolean;
	readonly supportsEditing: boolean;
	readonly supportsPassthroughCommands: boolean;
}

export interface AgentReasoningOption {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
}

export interface AgentModelDescriptor {
	readonly id: string;
	readonly adapterId: string;
	readonly provider: string;
	readonly label: string;
	readonly family?: string;
	readonly description?: string;
	readonly supportsReasoning: boolean;
	readonly supportsImages: boolean;
	readonly supportsTools: boolean;
	readonly availableReasoningEfforts: readonly string[];
	readonly isDefault: boolean;
	readonly native: {
		readonly id: string;
		readonly metadata?: Record<string, string>;
	};
}

export interface AgentSessionDefaults {
	readonly modelId?: string;
	readonly reasoningEffort?: string;
}

export interface AgentAttachment {
	readonly kind: 'image' | 'file' | 'markdown';
	readonly name: string;
	readonly mimeType?: string;
	readonly uri?: string;
	readonly content?: string;
	readonly metadata?: Record<string, string>;
}

export interface AgentTurnOptions {
	readonly modelId?: string;
	readonly reasoningEffort?: string;
	readonly command?: string;
	readonly attachments?: readonly AgentAttachment[];
	readonly metadata?: Record<string, string>;
}

export interface AgentChangedFile {
	readonly path: string;
	readonly change: 'added' | 'modified' | 'deleted';
}

export interface AgentQuestionRequest {
	readonly id: string;
	readonly prompt: string;
	readonly description?: string;
	readonly options?: readonly string[];
	readonly required: boolean;
}

export interface AgentCommandRequest {
	readonly command: string;
	readonly metadata?: Record<string, string>;
}

export interface AgentTerminalCommandRequest {
	readonly command: string;
	readonly cwd?: string;
	readonly env?: Record<string, string>;
}

export type AgentMessagePart =
	| { readonly kind: 'text'; readonly text: string }
	| { readonly kind: 'markdown'; readonly markdown: string; readonly source?: string }
	| { readonly kind: 'code'; readonly code: string; readonly language?: string }
	| { readonly kind: 'image'; readonly uri: string; readonly alt?: string }
	| { readonly kind: 'file'; readonly path: string; readonly description?: string }
	| { readonly kind: 'reasoning'; readonly text: string }
	| { readonly kind: 'terminal'; readonly stream: 'stdout' | 'stderr'; readonly text: string }
	| { readonly kind: 'question'; readonly question: AgentQuestionRequest }
	| { readonly kind: 'structured'; readonly value: unknown };

export interface AgentMessage {
	readonly id: string;
	readonly role: 'user' | 'assistant' | 'system' | 'tool';
	readonly createdAt: string;
	readonly modelId?: string;
	readonly reasoningEffort?: string;
	readonly editedFromMessageId?: string;
	readonly parts: readonly AgentMessagePart[];
}

export interface AgentChatSummary {
	readonly id: string;
	readonly title: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly messageCount: number;
}

export interface AgentChatTranscript {
	readonly sessionId: string;
	readonly chatId: string;
	readonly messages: readonly AgentMessage[];
}

export interface AgentRunSummary {
	readonly id: string;
	readonly sessionId: string;
	readonly chatId: string;
	readonly adapterId: string;
	readonly status: 'completed' | 'failed' | 'interrupted';
	readonly outputKind: 'markdown' | 'code' | 'mixed' | 'structured' | 'text';
	readonly modelId?: string;
	readonly reasoningEffort?: string;
	readonly lastMessageId?: string;
	readonly filesChanged: readonly AgentChangedFile[];
	readonly questionsAsked: readonly AgentQuestionRequest[];
	readonly terminalCommands: readonly AgentTerminalCommandRequest[];
	readonly completedAt: string;
	readonly errorMessage?: string;
}

export type AgentStreamEvent =
	| {
		readonly type: 'run.started';
		readonly runId: string;
		readonly sessionId: string;
		readonly chatId: string;
		readonly adapterId: string;
		readonly modelId?: string;
		readonly reasoningEffort?: string;
	}
	| {
		readonly type: 'chat.message.delta';
		readonly runId: string;
		readonly sessionId: string;
		readonly chatId: string;
		readonly messageId: string;
		readonly role: 'assistant' | 'user' | 'system' | 'tool';
		readonly text: string;
	}
	| {
		readonly type: 'reasoning.delta';
		readonly runId: string;
		readonly sessionId: string;
		readonly chatId: string;
		readonly text: string;
	}
	| {
		readonly type: 'markdown.delta';
		readonly runId: string;
		readonly sessionId: string;
		readonly chatId: string;
		readonly messageId: string;
		readonly markdown: string;
		readonly source?: string;
	}
	| {
		readonly type: 'code.delta';
		readonly runId: string;
		readonly sessionId: string;
		readonly chatId: string;
		readonly messageId: string;
		readonly code: string;
		readonly language?: string;
	}
	| {
		readonly type: 'files.changed';
		readonly runId: string;
		readonly sessionId: string;
		readonly files: readonly AgentChangedFile[];
	}
	| {
		readonly type: 'question.asked';
		readonly runId: string;
		readonly sessionId: string;
		readonly chatId: string;
		readonly question: AgentQuestionRequest;
	}
	| {
		readonly type: 'question.answered';
		readonly runId: string;
		readonly sessionId: string;
		readonly chatId: string;
		readonly questionId: string;
		readonly value: string;
	}
	| {
		readonly type: 'command.started';
		readonly runId: string;
		readonly sessionId: string;
		readonly command: string;
	}
	| {
		readonly type: 'command.inputRequested';
		readonly runId: string;
		readonly sessionId: string;
		readonly command: string;
		readonly prompt: string;
	}
	| {
		readonly type: 'command.completed';
		readonly runId: string;
		readonly sessionId: string;
		readonly command: string;
	}
	| {
		readonly type: 'terminal.started';
		readonly runId: string;
		readonly sessionId: string;
		readonly command: AgentTerminalCommandRequest;
	}
	| {
		readonly type: 'terminal.stdout' | 'terminal.stderr';
		readonly runId: string;
		readonly sessionId: string;
		readonly text: string;
	}
	| {
		readonly type: 'terminal.exited';
		readonly runId: string;
		readonly sessionId: string;
		readonly exitCode: number;
	}
	| {
		readonly type: 'checkpoint.created' | 'checkpoint.reverted';
		readonly runId?: string;
		readonly sessionId: string;
		readonly checkpointId: string;
	}
	| {
		readonly type: 'run.completed' | 'run.failed' | 'run.interrupted';
		readonly runId: string;
		readonly sessionId: string;
		readonly summary: AgentRunSummary;
	};

export interface AgentCheckpoint {
	readonly id: string;
	readonly sessionId: string;
	readonly chatId: string;
	readonly createdAt: string;
	readonly label?: string;
	readonly transcript: AgentChatTranscript;
	readonly native?: {
		readonly id: string;
		readonly metadata?: Record<string, string>;
	};
}

export interface AgentSessionSummary {
	readonly id: string;
	readonly adapterId: string;
	readonly nativeSessionId: string;
	readonly title: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly archivedAt?: string;
	readonly defaults: AgentSessionDefaults;
}

export interface AgentCreateSessionRequest {
	readonly title?: string;
	readonly defaults?: AgentSessionDefaults;
	readonly metadata?: Record<string, string>;
}

export interface AgentSendMessageRequest {
	readonly chatId?: string;
	readonly content: string;
	readonly options?: AgentTurnOptions;
}

export interface AgentAdapterSessionSummary {
	readonly id: string;
	readonly title: string;
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly archivedAt?: string;
	readonly defaults: AgentSessionDefaults;
}

export interface AgentAdapterChatTranscript {
	readonly sessionId: string;
	readonly chatId: string;
	readonly messages: readonly AgentMessage[];
}

export interface AgentAdapterCheckpoint {
	readonly id: string;
	readonly sessionId: string;
	readonly chatId: string;
	readonly createdAt: string;
	readonly label?: string;
	readonly transcript: AgentAdapterChatTranscript;
	readonly native?: {
		readonly id: string;
		readonly metadata?: Record<string, string>;
	};
}

export interface AgentAdapterRun {
	readonly runId: string;
	readonly stream: AsyncIterable<AgentStreamEvent>;
	readonly result: Promise<AgentRunSummary>;
}

export interface AgentRunHandle {
	readonly runId: string;
	readonly stream: AsyncIterable<AgentStreamEvent>;
	readonly result: Promise<AgentRunSummary>;
	interrupt(): Promise<void>;
}

export interface AgentAdapter {
	readonly id: string;
	readonly provider: string;
	readonly displayName: string;
	readonly capabilities: AgentCapabilities;

	getStandardCommandMappings?(): Partial<Record<AgentStandardCommandId, string>>;

	listModels(): Promise<readonly AgentModelDescriptor[]>;
	listReasoningOptions(modelId?: string): Promise<readonly AgentReasoningOption[]>;

	listSessions(): Promise<readonly AgentAdapterSessionSummary[]>;
	getSession(sessionId: string): Promise<AgentAdapterSessionSummary | undefined>;
	createSession(request: AgentCreateSessionRequest): Promise<AgentAdapterSessionSummary>;
	archiveSession(sessionId: string): Promise<void>;
	deleteSession(sessionId: string): Promise<void>;

	listChats(sessionId: string): Promise<readonly AgentChatSummary[]>;
	getChatTranscript(sessionId: string, chatId?: string): Promise<AgentAdapterChatTranscript>;

	getSessionDefaults(sessionId: string): Promise<AgentSessionDefaults>;
	updateSessionDefaults(sessionId: string, defaults: Partial<AgentSessionDefaults>): Promise<AgentSessionDefaults>;

	sendMessage(sessionId: string, request: AgentSendMessageRequest): Promise<AgentAdapterRun>;
	executeCommand(sessionId: string, request: AgentCommandRequest, options?: AgentTurnOptions): Promise<AgentAdapterRun>;
	submitCommandInput(sessionId: string, runId: string, input: string): Promise<void>;
	executeTerminalCommand(sessionId: string, request: AgentTerminalCommandRequest): Promise<AgentAdapterRun>;
	interrupt(sessionId: string, runId: string): Promise<void>;

	createCheckpoint(sessionId: string, chatId?: string, label?: string): Promise<AgentAdapterCheckpoint>;
	listCheckpoints(sessionId: string): Promise<readonly AgentAdapterCheckpoint[]>;
	revertToCheckpoint(sessionId: string, checkpointId: string): Promise<AgentAdapterCheckpoint>;
	truncateConversation(sessionId: string, chatId: string, messageId: string): Promise<void>;
}

export type AgentAdapterPackageReference = string;

export interface AgentAdapterPackageLoadOptions {
	readonly cwd?: string;
}

export interface AgentAdapterConstructor {
	new(options?: unknown): AgentAdapter;
}

export interface AgentAdapterModule {
	readonly default?: AgentAdapterConstructor;
	readonly Adapter?: AgentAdapterConstructor;
}
