/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ethan Krich. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';

export const projectCanvasInputTypeId = 'workbench.editors.projectCanvasInput';

export type ProjectCanvasInitiator = 'startup' | 'command';

export interface ProjectCanvasEditorOptions extends IEditorOptions {
	initiator?: ProjectCanvasInitiator;
}

export class ProjectCanvasInput extends EditorInput {

	static readonly ID = projectCanvasInputTypeId;
	static readonly RESOURCE = URI.from({ scheme: Schemas.walkThrough, authority: 'vscode_project_canvas' });

	private readonly initiatorValue: ProjectCanvasInitiator;

	override get typeId(): string {
		return ProjectCanvasInput.ID;
	}

	override get editorId(): string | undefined {
		return this.typeId;
	}

	get resource(): URI | undefined {
		return ProjectCanvasInput.RESOURCE;
	}

	constructor(options: ProjectCanvasEditorOptions = {}) {
		super();
		this.initiatorValue = options.initiator ?? 'command';
	}

	override getName(): string {
		return localize('projectCanvasInputName', "Projects");
	}

	get initiator(): ProjectCanvasInitiator {
		return this.initiatorValue;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}

		return other instanceof ProjectCanvasInput;
	}

	override toUntyped(): IUntypedEditorInput {
		return {
			resource: ProjectCanvasInput.RESOURCE,
			options: {
				override: ProjectCanvasInput.ID,
				pinned: false
			}
		};
	}
}
