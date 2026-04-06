/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ethan Krich. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentModelDescriptor, AgentStreamEvent } from '@pragma/agent-core';
import { AgentCore } from '@pragma/agent-core';
import { ClaudeCodeAdapter, ClaudeSignedInBridgeTransport } from '@pragma/agent-adapter-claude-code';
import { CodexAdapter, CodexSignedInBridgeTransport } from '@pragma/agent-adapter-codex';

async function logRun(prefix: string, stream: AsyncIterable<AgentStreamEvent>): Promise<void> {
	for await (const event of stream) {
		switch (event.type) {
			case 'run.started':
				console.log(`${prefix} started`, { modelId: event.modelId, reasoningEffort: event.reasoningEffort });
				break;
			case 'reasoning.delta':
				console.log(`${prefix} reasoning`, event.text);
				break;
			case 'chat.message.delta':
				process.stdout.write(`${prefix} ${event.text}`);
				if (!event.text.endsWith('\n')) {
					process.stdout.write('\n');
				}
				break;
			case 'markdown.delta':
				console.log(`${prefix} markdown\n${event.markdown}`);
				break;
			case 'code.delta':
				console.log(`${prefix} code (${event.language ?? 'text'})\n${event.code}`);
				break;
			case 'files.changed':
				console.log(`${prefix} files changed`, event.files);
				break;
			case 'terminal.started':
				console.log(`${prefix} terminal`, event.command.command);
				break;
			case 'terminal.stdout':
			case 'terminal.stderr':
				process.stdout.write(`${prefix} ${event.text}`);
				if (!event.text.endsWith('\n')) {
					process.stdout.write('\n');
				}
				break;
			case 'run.completed':
			case 'run.failed':
			case 'run.interrupted':
				console.log(`${prefix} ${event.type}`, event.summary);
				break;
			default:
				console.log(prefix, event.type, JSON.stringify(event));
				break;
		}
	}
}

function pickDefaultModel(models: readonly AgentModelDescriptor[], adapterId: string): AgentModelDescriptor {
	const model = models.find(candidate => candidate.adapterId === adapterId && candidate.isDefault)
		?? models.find(candidate => candidate.adapterId === adapterId);
	if (!model) {
		throw new Error(`No models available for adapter "${adapterId}".`);
	}
	return model;
}

async function main(): Promise<void> {
	const core = new AgentCore();
	core.registerAdapter(new ClaudeCodeAdapter({
		transports: [
			new ClaudeSignedInBridgeTransport('claude-sdk', {
				cwd: process.cwd(),
			}),
		],
	}));
	core.registerAdapter(new CodexAdapter({
		transports: [
			new CodexSignedInBridgeTransport('codex-sdk', {
				cwd: process.cwd(),
				skipGitRepoCheck: false,
			}),
		],
	}));

	console.log('Registered adapters:', core.listAdapters().map(adapter => adapter.id));

	const models = await core.listModels();
	console.log('Available models:', models);

	const claudeModel = pickDefaultModel(models, 'claude-code');
	const codexModel = pickDefaultModel(models, 'openai-codex');
	const claudeReasoning = (await core.listReasoningOptions('claude-code', claudeModel.id))[0]?.id;
	const codexReasoning = (await core.listReasoningOptions('openai-codex', codexModel.id))[0]?.id;

	console.log('Claude reasoning options:', await core.listReasoningOptions('claude-code', claudeModel.id));
	console.log('Codex reasoning options:', await core.listReasoningOptions('openai-codex', codexModel.id));

	const claudeSession = await core.createSession('claude-code', {
		title: 'Claude Demo',
		defaults: {
			modelId: claudeModel.id,
			reasoningEffort: claudeReasoning,
		},
		metadata: { cwd: process.cwd() },
	});
	const codexSession = await core.createSession('openai-codex', {
		title: 'Codex Demo',
		defaults: {
			modelId: codexModel.id,
			reasoningEffort: codexReasoning,
		},
		metadata: { cwd: process.cwd() },
	});

	console.log('Claude defaults:', await core.getSessionDefaults(claudeSession.id));
	console.log('Codex defaults:', await core.getSessionDefaults(codexSession.id));

	const claudeRun = await core.sendMessage(
		claudeSession.id,
		'Explain the package layout you see in this repository in a concise way.',
		{ reasoningEffort: claudeReasoning },
	);
	await logRun('[claude]', claudeRun.stream);
	console.log('Claude summary:', await claudeRun.result);

	const codexRun = await core.sendMessage(
		codexSession.id,
		'Reply in two short sentences introducing yourself as Codex and mention the model you are using if available. Do not run shell commands.',
		{ modelId: codexModel.id, reasoningEffort: codexReasoning },
	);
	await logRun('[codex]', codexRun.stream);
	console.log('Codex summary:', await codexRun.result);
}

await main();
