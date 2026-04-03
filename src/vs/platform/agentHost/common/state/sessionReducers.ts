/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ethan Krich. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Re-exports the protocol reducers and adds Pragma-specific helpers.
// The actual reducer logic lives in the auto-generated protocol layer.

import type { IToolCallState, ICompletedToolCall } from './sessionState.js';

// Re-export reducers from the protocol layer
export { rootReducer, sessionReducer, softAssertNever, isClientDispatchable } from './protocol/reducers.js';

// ---- Tool call metadata helpers (Pragma extensions via _meta) --------------

/**
 * Extracts the Pragma-specific `toolKind` rendering hint from a tool call's `_meta`.
 */
export function getToolKind(tc: IToolCallState | ICompletedToolCall): 'terminal' | undefined {
	return tc._meta?.toolKind as 'terminal' | undefined;
}

/**
 * Extracts the Pragma-specific `language` hint from a tool call's `_meta`.
 */
export function getToolLanguage(tc: IToolCallState | ICompletedToolCall): string | undefined {
	return tc._meta?.language as string | undefined;
}
