import * as vscode from 'vscode';
import path from 'node:path';
import { FileGroup, CONFIG_FILE, isHdl, resolveProject } from '../project/config';

export class ProjectNode extends vscode.TreeItem {
  constructor(label: string, readonly root: string, readonly kind: 'project' | 'group' | 'file' | 'error', readonly group?: FileGroup, readonly file?: string) {
    super(label, kind === 'project' || kind === 'group' ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
    this.contextValue = kind === 'file' ? (isHdl(file!) ? 'hdl' : /\.(xci|bd)$/i.test(file!) ? 'ip' : 'file') : kind;
    if (file) {
      this.resourceUri = vscode.Uri.file(file);
      this.command = { command: 'vscode.open', title: 'Open', arguments: [this.resourceUri] };
      this.tooltip = file;
      this.iconPath = vscode.ThemeIcon.File;
      if (this.contextValue === 'ip') this.description = 'Vivado GUI';
    } else this.iconPath = new vscode.ThemeIcon(kind === 'project' ? 'circuit-board' : kind === 'error' ? 'error' : 'folder');
  }
}

export class ProjectTree implements vscode.TreeDataProvider<ProjectNode>, vscode.Disposable {
  constructor(private readonly roots: () => string[]) {}
  private emitter = new vscode.EventEmitter<ProjectNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  refresh(): void { this.emitter.fire(undefined); }
  getTreeItem(node: ProjectNode): vscode.TreeItem { return node; }

  async getChildren(node?: ProjectNode): Promise<ProjectNode[]> {
    if (!node) {
      const projects: ProjectNode[] = [];
      for (const root of this.roots()) {
        try {
          const project = await resolveProject(root);
          const item = new ProjectNode(project.config.name, root, 'project');
          item.description = `${project.config.part} / ${project.config.top}`;
          projects.push(item);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') projects.push(new ProjectNode(String(error), root, 'error', undefined, path.join(root, CONFIG_FILE)));
        }
      }
      return projects;
    }
    if (node.kind === 'project') return [new ProjectNode('Design Sources', node.root, 'group', 'sources'), new ProjectNode('Constraints', node.root, 'group', 'constraints'), new ProjectNode('Simulation Sources', node.root, 'group', 'simulation')];
    if (node.kind !== 'group') return [];
    try {
      const project = await resolveProject(node.root);
      return project.files[node.group!].map(file => new ProjectNode(path.basename(file), node.root, 'file', node.group, file));
    } catch { return []; }
  }

  dispose(): void { this.emitter.dispose(); }
}
