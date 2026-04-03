/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ethan Krich. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { commonOptions, extensionManagementOptions, troubleshootingOptions, globalTunnelOptions, codeTunnelSubcommands, extTunnelSubcommand, codeTunnelOptions } from './code';
import codeTunnelCompletionSpec from './code-tunnel';

const codeTunnelInsidersCompletionSpec: Fig.Spec = {
	...codeTunnelCompletionSpec,
	name: 'pragma-tunnel-insiders',
	description: 'Pragma Insiders',
	subcommands: [...codeTunnelSubcommands, extTunnelSubcommand],
	options: [
		...commonOptions,
		...extensionManagementOptions('pragma-tunnel-insiders'),
		...troubleshootingOptions('pragma-tunnel-insiders'),
		...globalTunnelOptions,
		...codeTunnelOptions,
	]
};

export default codeTunnelInsidersCompletionSpec;
