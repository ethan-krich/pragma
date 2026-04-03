/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ethan Krich. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';

const Logger = vscode.window.createOutputChannel(vscode.l10n.t('Ethan Krich Authentication'), { log: true });
export default Logger;
