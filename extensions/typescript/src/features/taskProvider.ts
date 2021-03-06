/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

'use strict';

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

import * as Proto from '../protocol';
import TypeScriptServiceClient from '../typescriptServiceClient';
import TsConfigProvider from "../utils/tsconfigProvider";


const exists = (file: string): Promise<boolean> =>
	new Promise<boolean>((resolve, _reject) => {
		fs.exists(file, (value: boolean) => {
			resolve(value);
		});
	});

/**
 * Provides tasks for building `tsconfig.json` files in a project.
 */
class TscTaskProvider implements vscode.TaskProvider {
	private readonly tsconfigProvider: TsConfigProvider;

	public constructor(
		private readonly lazyClient: () => TypeScriptServiceClient
	) {
		this.tsconfigProvider = new TsConfigProvider();
	}

	dispose() {
		this.tsconfigProvider.dispose();
	}

	public async provideTasks(token: vscode.CancellationToken): Promise<vscode.Task[]> {
		const rootPath = vscode.workspace.rootPath;
		if (!rootPath) {
			return [];
		}

		const command = await this.getCommand();
		const projects = await this.getAllTsConfigs(token);

		return projects.map(configFile => {
			const configFileName = path.relative(rootPath, configFile);
			const buildTask = new vscode.ShellTask(`build ${configFileName}`, `${command} -p "${configFile}"`, '$tsc');
			buildTask.source = 'tsc';
			buildTask.group = vscode.TaskGroup.Build;
			return buildTask;
		});
	}

	private async getAllTsConfigs(token: vscode.CancellationToken): Promise<string[]> {
		const out = new Set<string>();
		const configs = (await this.getTsConfigForActiveFile(token)).concat(await this.getTsConfigsInWorkspace());
		for (const config of configs) {
			if (await exists(config)) {
				out.add(config);
			}
		}
		return Array.from(out);
	}

	private async getTsConfigForActiveFile(token: vscode.CancellationToken): Promise<string[]> {
		const editor = vscode.window.activeTextEditor;
		if (editor) {
			if (path.basename(editor.document.fileName).match(/^tsconfig\.(.\.)?json$/)) {
				return [editor.document.fileName];
			}
		}

		const file = this.getActiveTypeScriptFile();
		if (!file) {
			return [];
		}

		const res: Proto.ProjectInfoResponse = await this.lazyClient().execute(
			'projectInfo',
			{ file, needFileNameList: false } as protocol.ProjectInfoRequestArgs,
			token);

		if (!res || !res.body) {
			return [];
		}

		const { configFileName } = res.body;
		if (configFileName && configFileName.indexOf('/dev/null/') !== 0) {
			return [configFileName];
		}
		return [];
	}

	private async getTsConfigsInWorkspace(): Promise<string[]> {
		return Array.from(await this.tsconfigProvider.getConfigsForWorkspace());
	}

	private async getCommand(): Promise<string> {
		const platform = process.platform;
		if (platform === 'win32' && await exists(path.join(vscode.workspace.rootPath!, 'node_modules', '.bin', 'tsc.cmd'))) {
			return path.join('.', 'node_modules', '.bin', 'tsc.cmd');
		} else if ((platform === 'linux' || platform === 'darwin') && await exists(path.join(vscode.workspace.rootPath!, 'node_modules', '.bin', 'tsc'))) {
			return path.join('.', 'node_modules', '.bin', 'tsc');
		} else {
			return 'tsc';
		}
	}

	private getActiveTypeScriptFile(): string | null {
		const editor = vscode.window.activeTextEditor;
		if (editor) {
			const document = editor.document;
			if (document && (document.languageId === 'typescript' || document.languageId === 'typescriptreact')) {
				return this.lazyClient().normalizePath(document.uri);
			}
		}
		return null;
	}
}

type AutoDetect = 'on' | 'off';

/**
 * Manages registrations of TypeScript task provides with VScode.
 */
export default class TypeScriptTaskProviderManager {
	private taskProviderSub: vscode.Disposable | undefined = undefined;
	private readonly disposables: vscode.Disposable[] = [];

	constructor(
		private readonly lazyClient: () => TypeScriptServiceClient
	) {
		vscode.workspace.onDidChangeConfiguration(this.onConfigurationChanged, this, this.disposables);
		this.onConfigurationChanged();
	}

	dispose() {
		if (this.taskProviderSub) {
			this.taskProviderSub.dispose();
			this.taskProviderSub = undefined;
		}
		this.disposables.forEach(x => x.dispose());
	}

	private onConfigurationChanged() {
		let autoDetect = vscode.workspace.getConfiguration('typescript.tsc').get<AutoDetect>('autoDetect');
		if (this.taskProviderSub && autoDetect === 'off') {
			this.taskProviderSub.dispose();
			this.taskProviderSub = undefined;
		} else if (!this.taskProviderSub && autoDetect === 'on') {
			this.taskProviderSub = vscode.workspace.registerTaskProvider(new TscTaskProvider(this.lazyClient));
		}
	}
}