/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ethan Krich. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export class AgentCoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = new.target.name;
	}
}

export class AgentNotFoundError extends AgentCoreError { }
export class AgentValidationError extends AgentCoreError { }
export class AgentCapabilityError extends AgentCoreError { }
export class AgentCommandError extends AgentCoreError { }
