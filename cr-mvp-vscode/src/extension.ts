import * as vscode from 'vscode';
import * as path from 'path';
import * as ts from 'typescript';

type ChecklistItem = {
  id?: string;
  title?: string;
  description?: string;
  pattern?: string;
  type?: string; // "ast_rule" or "pattern"
  rule?: string;
  severity?: 'info' | 'warning' | 'error' | 'major' | 'blocking';
  autoFixable?: boolean;
  autoFix?: {
    replaceTemplate?: string;
  };
};

type ChecklistJson = { items?: ChecklistItem[] };

type Finding = {
  ruleId: string;
  description: string;
  severity: string;
  autoFixable: boolean;
  file: string;
  line: number;
  snippet: string;
  match?: string;
};

// --- Tree Nodes ---
class FindingNode extends vscode.TreeItem {
  constructor(public readonly finding: Finding) {
    super(`${path.basename(finding.file)}:${finding.line} — ${finding.ruleId}`, vscode.TreeItemCollapsibleState.None);
    this.tooltip = `${finding.file}:${finding.line}\n${finding.snippet}`;
    this.description = finding.severity;
    this.contextValue = finding.autoFixable ? 'finding.autofix' : 'finding';
  }
}

class RuleNode extends vscode.TreeItem {
  constructor(public readonly rule: ChecklistItem) {
    super(`${rule.id ?? rule.description}`, vscode.TreeItemCollapsibleState.Collapsed);
    this.tooltip = `${rule.description}`;
    this.description = rule.severity ?? '';
    this.contextValue = rule.autoFixable ? 'rule.autofix' : 'rule';
  }
}

class ChecklistProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private rules: ChecklistItem[] = [];
  private findings: Finding[] = [];

  refresh(rules?: ChecklistItem[], findings?: Finding[]) {
    if (rules) this.rules = rules;
    if (findings) this.findings = findings;
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!element) {
      return (this.rules || []).map(r => new RuleNode(r));
    }
    if (element instanceof RuleNode) {
      const id = element.rule.id ?? element.rule.description ?? '';
      const matches = (this.findings || []).filter(f => f.ruleId === id);
      return matches.map(f => new FindingNode(f));
    }
    return [];
  }
}

// --- Read checklist.json ---
async function readChecklist(): Promise<ChecklistJson> {
  const wf = vscode.workspace.workspaceFolders?.[0];
  if (!wf) {
    console.warn('No workspace folder open.');
    return { items: [] };
  }

  const uri = vscode.Uri.joinPath(wf.uri, 'checklist.json');
  console.log('Trying to read checklist.json at:', uri.fsPath);

  try {
    const raw = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(raw).toString('utf8');
    console.log('Checklist.json content:', text);
    return JSON.parse(text) as ChecklistJson;
  } catch (err) {
    console.error('Failed to read checklist.json:', err);
    return { items: [] };
  }
}

// --- Helpers ---
function getLineAt(text: string, index: number): { line: number; snippet: string } {
  const before = text.slice(0, index);
  const line = before.split(/\r\n|\r|\n/).length;
  const lines = text.split(/\r\n|\r|\n/);
  const snippet = (lines[line - 1] || '').trim();
  return { line, snippet };
}

// --- AST null check ---
function scanAstForNullChecks(sourceText: string, fileName: string): Finding[] {
  const findings: Finding[] = [];
  const sourceFile = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true);

  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) {
      const fnBody = node.body;
      if (!fnBody) return;
      for (const param of node.parameters) {
        const paramName = (param.name as ts.Identifier).text;
        let hasNullCheck = false;

        function checkNode(n: ts.Node) {
          if (ts.isIfStatement(n) && n.expression) {
            const expText = n.expression.getText(sourceFile);
            if (expText.includes(`${paramName} != null`) || expText.includes(`${paramName} !== null`) ||
                expText.includes(`${paramName} !== undefined`) || expText.includes(`${paramName} != undefined`) ||
                expText.includes(`${paramName} == null`) || expText.includes(`${paramName} === undefined`)) {
              hasNullCheck = true;
            }
          }
          ts.forEachChild(n, checkNode);
        }

        ts.forEachChild(fnBody, checkNode);

        if (!hasNullCheck) {
          const { line, snippet } = getLineAt(sourceText, param.pos);
          findings.push({
            ruleId: 'C2',
            description: `Parameter '${paramName}' missing null/undefined check`,
            severity: 'warning',
            autoFixable: true,
            file: fileName,
            line,
            snippet,
            match: paramName
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return findings;
}

// --- Scan workspace ---
async function scanWorkspaceForRules(rules: ChecklistItem[]): Promise<Finding[]> {
  const wf = vscode.workspace.workspaceFolders?.[0];
  if (!wf) return [];
  const files = await vscode.workspace.findFiles('**/*.{ts,tsx}', '**/node_modules/**');
  const findings: Finding[] = [];

  for (const f of files) {
    try {
      const raw = await vscode.workspace.fs.readFile(f);
      const text = Buffer.from(raw).toString('utf8');

      for (const rule of rules) {
        if (rule.type === 'ast_rule' && rule.rule === 'ensure_null_check') {
          findings.push(...scanAstForNullChecks(text, f.fsPath));
        } else if (rule.pattern) {
          let re: RegExp;
          try { re = new RegExp(rule.pattern, 'g'); } catch { continue; }
          let m: RegExpExecArray | null;
          while ((m = re.exec(text)) !== null) {
            const idx = m.index;
            const matched = m[0];
            const { line, snippet } = getLineAt(text, idx);
            findings.push({
              ruleId: rule.id ?? 'rule',
              description: rule.description ?? rule.pattern ?? '',
              severity: rule.severity ?? 'warning',
              autoFixable: !!rule.autoFixable,
              file: f.fsPath,
              line,
              snippet,
              match: matched
            });
            if (m.index === re.lastIndex) re.lastIndex++;
          }
        }
      }
    } catch (err) { console.error(err); }
  }

  return findings;
}

// --- Activate ---
export function activate(context: vscode.ExtensionContext) {
  const provider = new ChecklistProvider();
  vscode.window.createTreeView('checklistView', { treeDataProvider: provider });

  // Show Checklist Panel
  const showChecklistPanel = vscode.commands.registerCommand('cr-mvp-vscode.showChecklistPanel', async () => {
    const wf = vscode.workspace.workspaceFolders?.[0];
    if (!wf) return vscode.window.showErrorMessage('Open a workspace folder first');

    const checklist = await readChecklist();
    const rules = checklist.items ?? [];

    if (!rules.length) {
      vscode.window.showWarningMessage('No checklist items found in checklist.json');
      console.log('Loaded checklist object:', JSON.stringify(checklist, null, 2));
    }

    provider.refresh(rules, []);
    vscode.window.showInformationMessage('Checklist Panel Loaded');
  });
  context.subscriptions.push(showChecklistPanel);

  // Run Review
  const runReview = vscode.commands.registerCommand('cr-mvp-vscode.runReview', async () => {
    const wf = vscode.workspace.workspaceFolders?.[0];
    if (!wf) return vscode.window.showErrorMessage('Open a workspace folder first');

    vscode.window.showInformationMessage('Running checklist review...');

    const checklist = await readChecklist();
    const rules = checklist.items ?? [];
    const findings = await scanWorkspaceForRules(rules);

    provider.refresh(rules, findings);

    const artifact = { generatedAt: new Date().toISOString(), workspace: wf.name, findings };
    const artifactUri = vscode.Uri.joinPath(wf.uri, 'review-artifact.json');
    await vscode.workspace.fs.writeFile(artifactUri, Buffer.from(JSON.stringify(artifact, null, 2), 'utf8'));
    const doc = await vscode.workspace.openTextDocument(artifactUri);
    vscode.window.showTextDocument(doc, { preview: false });
    vscode.window.showInformationMessage(`Review complete — ${findings.length} findings.`);
  });
  context.subscriptions.push(runReview);

  // Apply Auto-Fix
  const applyFix = vscode.commands.registerCommand('cr-mvp-vscode.applyFix', async (nodeOrFinding?: any) => {
    let targetFinding: Finding | undefined;
    if (nodeOrFinding instanceof FindingNode) targetFinding = nodeOrFinding.finding;
    else if (nodeOrFinding?.file) targetFinding = nodeOrFinding as Finding;
    else return vscode.window.showInformationMessage('Select a finding to apply fix.');

    const checklist = await readChecklist();
    const rule = (checklist.items ?? []).find(r => (r.id ?? r.description) === targetFinding!.ruleId);
    if (!rule?.autoFixable || !rule?.autoFix || !targetFinding) {
      return vscode.window.showErrorMessage('No auto-fix available.');
    }

    const doc = await vscode.workspace.openTextDocument(targetFinding.file);
    const editor = await vscode.window.showTextDocument(doc);
    const lines = doc.getText().split(/\r\n|\r|\n/);
    const lineIndex = targetFinding.line - 1;
    const lineText = lines[lineIndex];
    const template = rule.autoFix.replaceTemplate ?? '$MATCH';
    const replacement = template.replace(/\$MATCH/g, targetFinding.match ?? '');
    const newLine = lineText.replace(targetFinding.match ?? '', replacement);

    const edit = new vscode.WorkspaceEdit();
    edit.replace(doc.uri, new vscode.Range(lineIndex, 0, lineIndex, lineText.length), newLine);
    const ok = await vscode.workspace.applyEdit(edit);
    if (ok) await doc.save();
    vscode.window.showInformationMessage(`Applied auto-fix for ${targetFinding.ruleId}`);
  });
  context.subscriptions.push(applyFix);
}

export function deactivate() {}
