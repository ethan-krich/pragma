#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const replacements = [
	['Microsoft VS Code', 'Pragma'],
	['Visual Studio Code', 'Pragma'],
	['Code - OSS', 'Pragma'],
	['Code OSS', 'Pragma'],
	['CodeOSS', 'Pragma'],
	['VS Code', 'Pragma'],
	['Microsoft Corporation', 'Ethan Krich'],
	['Microsoft', 'Ethan Krich'],
];

const output = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' });
const files = output.split('\0').filter(Boolean);

let changedFiles = 0;
let replacementCount = 0;
let skippedFiles = 0;

for (const file of files) {
	const original = readFileSync(file);

	if (original.includes(0)) {
		continue;
	}

	let text = original.toString('utf8');
	let nextText = text;
	let fileReplacementCount = 0;

	for (const [from, to] of replacements) {
		const matches = nextText.match(new RegExp(escapeRegExp(from), 'g'));
		if (!matches) {
			continue;
		}

		fileReplacementCount += matches.length;
		nextText = nextText.replaceAll(from, to);
	}

	if (nextText === text) {
		continue;
	}

	try {
		writeFileSync(file, nextText, 'utf8');
		changedFiles += 1;
		replacementCount += fileReplacementCount;
		console.log(`${file}: ${fileReplacementCount} replacements`);
	} catch (error) {
		skippedFiles += 1;
		console.warn(`${file}: skipped (${error.code ?? 'write error'})`);
	}
}

console.log(`Updated ${changedFiles} files with ${replacementCount} replacements. Skipped ${skippedFiles} files.`);

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
