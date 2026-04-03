/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ethan Krich. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import code, { commonOptions, extensionManagementOptions, troubleshootingOptions } from './code';

const codeInsidersCompletionSpec: Fig.Spec = {
	...code,
	name: 'code-insiders',
	description: 'Pragma Insiders',
	options: [
		...commonOptions,
		...extensionManagementOptions('code-insiders'),
		...troubleshootingOptions('code-insiders'),
	],
};

export default codeInsidersCompletionSpec;
