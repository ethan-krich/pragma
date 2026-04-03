/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ethan Krich. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { InstantiationType, registerSingleton } from '../../instantiation/common/extensions.js';
import { ISSHRemoteAgentHostService } from '../common/sshRemoteAgentHost.js';
import { SSHRemoteAgentHostService } from './sshRemoteAgentHostServiceImpl.js';

registerSingleton(ISSHRemoteAgentHostService, SSHRemoteAgentHostService, InstantiationType.Delayed);
