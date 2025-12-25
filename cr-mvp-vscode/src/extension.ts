import * as vscode from 'vscode';
import * as path from 'path';
import * as ts from 'typescript';

type ChecklistItem = {
  id?: string;
  title?: string;
  description?: string;
  pattern?: string;
  type?: string; // pattern | ast_rule | file_rule | line_rule
  rule?: string;
  severity?: 'info' | 'warning' | 'error' | 'major' | 'blocking';
  languages?: string[];
  maxLines?: number;     // ✅ ADD
  maxLength?: number;    // ✅ ADD
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
  language?: string;
  match?: string;
};


// --- Tree Nodes ---
class FindingNode extends vscode.TreeItem {
  constructor(public readonly finding: Finding) {
    super(
  `${path.basename(finding.file)}:${finding.line} — ${finding.description}`,
  vscode.TreeItemCollapsibleState.None
);
  this.tooltip =
   `Rule: ${finding.ruleId}\n` +
   `Severity: ${finding.severity}\n` +
   `${finding.file}:${finding.line}\n\n` +
   finding.snippet;

    this.description = finding.severity.toUpperCase();
    this.iconPath =
      finding.severity === 'error'
      ? new vscode.ThemeIcon('error')
      : finding.severity === 'warning'
      ? new vscode.ThemeIcon('warning')
      : new vscode.ThemeIcon('info');
    this.contextValue = finding.autoFixable ? 'finding.autofix' : 'finding';
      this.command = {
      command: 'coderev.openFinding',
      title: 'Open Finding',
      arguments: [finding]
    };

  }
}

class RuleNode extends vscode.TreeItem {
  constructor(public readonly rule: ChecklistItem) {
    super(`${rule.id ?? rule.description}`, vscode.TreeItemCollapsibleState.Collapsed);
    this.tooltip = `${rule.description}`;
    this.description = rule.severity?.toUpperCase() ?? '';
    if (rule.severity === 'error') {
    this.iconPath = new vscode.ThemeIcon('error');
    } else if (rule.severity === 'warning') {
    this.iconPath = new vscode.ThemeIcon('warning');
    } else {
    this.iconPath = new vscode.ThemeIcon('info');
    }
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
  console.log('READ CHECKLIST CALLED');

  const wf = vscode.workspace.workspaceFolders?.[0];
  if (!wf) {
    console.error('NO WORKSPACE FOLDER');
    return { items: [] };
  }

  console.log('Workspace folder:', wf.uri.fsPath);

  const checklistPath = vscode.Uri.joinPath(wf.uri, 'checklist.json');
  console.log('Looking for checklist at:', checklistPath.fsPath);

  try {
    const raw = await vscode.workspace.fs.readFile(checklistPath);
    const text = Buffer.from(raw).toString();
    console.log('Checklist file content:', text);

    const parsed = JSON.parse(text);
    console.log('Parsed checklist items:', parsed.items?.length);

    return parsed;
  } catch (err) {
    console.error('FAILED TO READ CHECKLIST:', err);
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
function getLanguageFromFile(filePath: string): string {
  if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) return 'typescript';
  if (filePath.endsWith('.js') || filePath.endsWith('.jsx')) return 'javascript';
  if (filePath.endsWith('.py')) return 'python';
  if (filePath.endsWith('.java')) return 'java';
  if (filePath.endsWith('.cs')) return 'csharp';
  return 'unknown';
}

// --- Scan workspace ---
async function scanWorkspaceForRules(
  rules: ChecklistItem[],
  files: vscode.Uri[]
): Promise<Finding[]> {

  const findings: Finding[] = [];

  for (const f of files) {
    try {
      const raw = await vscode.workspace.fs.readFile(f);
      const text = Buffer.from(raw).toString('utf8');
      const language = getLanguageFromFile(f.fsPath);
      const lines = text.split(/\r\n|\r|\n/);

      for (const rule of rules) {

        // ===============================
        // FILE-LEVEL RULE (max lines)
        // ===============================
        if (rule.type === 'file_rule' && rule.maxLines) {
          if (
            !rule.languages ||
            rule.languages.includes(language)
          ) {
            if (lines.length > rule.maxLines) {
              findings.push({
                ruleId: rule.id ?? 'file_rule',
                description: rule.description ?? 'File exceeds maximum line count',
                severity: rule.severity ?? 'info',
                autoFixable: false,
                file: f.fsPath,
                line: 1,
                snippet: `File has ${lines.length} lines`,
                language
              });
            }
          }
          continue;
        }

        // ===============================
        // LINE-LEVEL RULE (max length)
        // ===============================
        if (rule.type === 'line_rule' && rule.maxLength) {
          if (
            !rule.languages ||
            rule.languages.includes(language)
          ) {
            lines.forEach((lineText, index) => {
              if (lineText.length > rule.maxLength!) {
                findings.push({
                  ruleId: rule.id ?? 'line_rule',
                  description: rule.description ?? 'Line too long',
                  severity: rule.severity ?? 'warning',
                  autoFixable: false,
                  file: f.fsPath,
                  line: index + 1,
                  snippet: lineText.trim(),
                  language
                });
              }
            });
          }
          continue;
        }

        // ===============================
        // AST RULE (TypeScript only)
        // ===============================
        if (
          rule.type === 'ast_rule' &&
          rule.rule === 'ensure_null_check' &&
          language === 'typescript'
        ) {
          findings.push(...scanAstForNullChecks(text, f.fsPath));
          continue;
        }

        // ===============================
        // PATTERN RULE (all languages)
        // ===============================
        if (
          rule.pattern &&
          (!rule.languages || rule.languages.includes(language))
        ) {

          let re: RegExp;
          try {
            re = new RegExp(rule.pattern, 'g');
          } catch {
            continue;
          }

          let m: RegExpExecArray | null;
          while ((m = re.exec(text)) !== null) {
            const idx = m.index;
            const matched = m[0];
            const { line, snippet } = getLineAt(text, idx);

            findings.push({
              ruleId: rule.id ?? 'pattern_rule',
              description: rule.description ?? rule.pattern ?? '',
              severity: rule.severity ?? 'warning',
              autoFixable: !!rule.autoFixable,
              file: f.fsPath,
              line,
              snippet,
              match: matched,
              language
            });

            if (m.index === re.lastIndex) re.lastIndex++;
          }
        }
      }
    } catch (err) {
      console.error(err);
    }
  }

  return findings;
}


// --- Activate ---
export function activate(context: vscode.ExtensionContext) {
    const openFinding = vscode.commands.registerCommand(
    'coderev.openFinding',
    async (finding: Finding) => {
      const uri = vscode.Uri.file(finding.file);
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc);

      const line = Math.max(finding.line - 1, 0);
      const lineText = doc.lineAt(line);
const range = lineText.range;

editor.selection = new vscode.Selection(range.start, range.end);

      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
    }
  );

  context.subscriptions.push(openFinding);

  const provider = new ChecklistProvider();
  vscode.window.registerTreeDataProvider('checklistView', provider);


  // Show Checklist Panel
  const showChecklistPanel = vscode.commands.registerCommand('cr-mvp-vscode.showChecklistPanel', async () => {
    vscode.window.showInformationMessage('SHOW CHECKLIST PANEL COMMAND TRIGGERED');

    const wf = vscode.workspace.workspaceFolders?.[0];
    if (!wf) return vscode.window.showErrorMessage('Open a workspace folder first');

    const checklist = await readChecklist();
    const rules = checklist.items ?? [];
    console.log('RULE COUNT:', rules.length);


    if (!rules.length) {
      vscode.window.showWarningMessage('No checklist items found in checklist.json');
      console.log('Loaded checklist object:', JSON.stringify(checklist, null, 2));
    }

    provider.refresh(rules, []);
    vscode.window.showInformationMessage('Checklist Panel Loaded');
  });
  context.subscriptions.push(showChecklistPanel);

  // ==============================
// Run Review Command (FINAL FIXED)
// ==============================
const runReview = vscode.commands.registerCommand(
  'cr-mvp-vscode.runReview',
  async () => {

    // Ask user: Single file OR whole workspace
    const scopePick = await vscode.window.showQuickPick(
      ['Single File', 'Entire Workspace'],
      { placeHolder: "Select review scope", canPickMany: false }
    );

    // convert `string` → union → avoid TS error
    const scope = scopePick as "Single File" | "Entire Workspace" | undefined;
    if (!scope) return;

    // Collect files
    let files: vscode.Uri[] = [];

    if (scope === "Single File") {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showErrorMessage("No active file open.");
        return;
      }
      files = [editor.document.uri];
    } else {
      files = await vscode.workspace.findFiles(
        "**/*.{ts,tsx,js,jsx,py,java,cs}",
        "{**/node_modules/**,**/out/**,**/test/**}"
      );
    }

    if (!files.length) {
      vscode.window.showWarningMessage("No files found to review.");
      return;
    }

    // Load checklist
    const checklist = await readChecklist();
    const rules = checklist.items ?? [];

    // Run scanner
    const findings = await scanWorkspaceForRules(rules, files);

    // Update left panel
    provider.refresh(rules, findings);

    // Write artifact
    const wf = vscode.workspace.workspaceFolders?.[0];
    if (wf) {
      const artifactUri = vscode.Uri.joinPath(wf.uri, "review-artifact.json");
      await vscode.workspace.fs.writeFile(
        artifactUri,
        Buffer.from(
          JSON.stringify(
            {
              generatedAt: new Date().toISOString(),
              scope,
              findings,
            },
            null,
            2
          ),
          "utf8"
        )
      );
      vscode.window.showTextDocument(await vscode.workspace.openTextDocument(artifactUri));
    }

    vscode.window.showInformationMessage(
      `Review complete (${scope}) — ${findings.length} issue(s).`
    );
  }
);
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
