const vscode = require("vscode");
const path = require("path");
const fs = require("fs/promises");
const child_process = require("child_process");

// ---- 题目扫描 ----
async function scanProblems() {
  const rootPath = vscode.workspace.getConfiguration("xmuoj").get("localWorkspaceRoot") || "";
  if (!rootPath) {
    vscode.window.showWarningMessage("请先在 XMUOJ 设置中配置 localWorkspaceRoot");
    return [];
  }

  const problems = [];
  const root = path.resolve(rootPath);

  let contestDirs = [];
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && (e.name.startsWith("contest-") || e.name === "problemsets")) {
        contestDirs.push(path.join(root, e.name));
      }
    }
  } catch { return []; }

  for (const contestDir of contestDirs) {
    let subDirs;
    try {
      subDirs = await fs.readdir(contestDir, { withFileTypes: true });
    } catch { continue; }

    for (const e of subDirs) {
      if (!e.isDirectory()) continue;
      const metaPath = path.join(contestDir, e.name, ".xmuoj.json");
      try {
        const metaRaw = await fs.readFile(metaPath, "utf8");
        const meta = JSON.parse(metaRaw);
        const sourceFile = path.join(contestDir, e.name, meta.sourceFile || "main.cpp");
        let code = "";
        let hasCode = false;
        try {
          code = await fs.readFile(sourceFile, "utf8");
          hasCode = code.trim().length > 0;
        } catch { /* file missing */ }
        problems.push({
          dir: path.join(contestDir, e.name),
          meta,
          sourceFile,
          hasCode,
          code,
        });
      } catch { /* skip */ }
    }
  }

  return problems;
}

// ---- 检查 samples 是否存在 ----
async function checkMissingSamples(problemDir) {
  try {
    const samplesDir = path.join(problemDir, "samples");
    const files = await fs.readdir(samplesDir);
    const hasIn = files.some((f) => f.endsWith(".in"));
    const hasOut = files.some((f) => f.endsWith(".out"));
    return !hasIn || !hasOut;
  } catch {
    return true;
  }
}

// ---- 从 XMUOJ 下载缺失的样本数据 ----
async function downloadSamples(problem, onMsg) {
  // 先尝试 xmuoj.openProblem（需要已打开实验）
  const prob = { id: problem.meta.problemId, display_id: problem.meta.displayId, title: problem.meta.title };
  try {
    onMsg("下载样本...");
    await vscode.commands.executeCommand("xmuoj.openProblem", prob);
    // 检查是否真的写入了
    const missing = await checkMissingSamples(problem.dir);
    if (!missing) return true;
  } catch (err) {
    // openProblem 失败了，用 Python 直接调 API
  }

  // 回退方案：用 Python 从 SQLite 读 cookie 调 API
  onMsg("回退API下载...");
  return new Promise((resolve) => {
    const dbPath = "C:/Users/Administrator/AppData/Roaming/Code/User/globalStorage/state.vscdb";
    const pid = problem.meta.problemId;
    const cid = problem.meta.contestId || 362;
    const sdir = path.join(problem.dir, "samples").replace(/\\/g, "/");
    const script = [
      "import sqlite3,json,urllib.request,os",
      `db=sqlite3.connect(r"${dbPath}")`,
      'row=db.execute("SELECT value FROM ItemTable WHERE key=\'xmuoj.xmuoj-vscode\'").fetchone()',
      "data=json.loads(row[0])",
      'cookies=data.get("xmuoj.sessionCookies","")',
      "if not cookies:",
      '    cookies=data.get("xmuoj.token","")',
      "db.close()",
      `url="http://xmuoj.com/api/plugin/problem_workspace?problem_id=${pid}&contest_id=${cid}"`,
      'req=urllib.request.Request(url,headers={"Cookie":cookies,"User-Agent":"Mozilla/5.0","Authorization":"Token "+cookies if cookies and not "=" in cookies else ""})',
      "try:",
      "    resp=urllib.request.urlopen(req,timeout=15)",
      "    body=json.loads(resp.read())",
      '    samples=body.get("data",{}).get("samples",[])',
      '    if not samples: samples=body.get("samples",[])',
      `    os.makedirs(r"${sdir}",exist_ok=True)`,
      "    for i,s in enumerate(samples):",
      "        ni=i+1",
      '        inp=s.get("input","") or ""',
      '        out=s.get("output","") or ""',
      `        open(r"${sdir}/"+str(ni)+".in","w",encoding="utf-8").write(inp)`,
      `        open(r"${sdir}/"+str(ni)+".out","w",encoding="utf-8").write(out)`,
      "    print(f'OK:{len(samples)}')",
      "except Exception as e:",
      "    print(f'ERR:{e}')",
    ].join("\n");
    const proc = child_process.spawn("python", ["-c", script], { windowsHide: true });
    const timer = setTimeout(() => { proc.kill(); resolve(false); }, 15000);
    let out = "";
    proc.stdout.on("data", (d) => out += d.toString());
    proc.on("close", () => { clearTimeout(timer); resolve(out.trim().startsWith("OK:")); });
    proc.on("error", () => { clearTimeout(timer); resolve(false); });
  });
}

// ---- 检查题目 AC 状态（最多重试 3 次，每次等 500ms） ----
async function checkProblemAC(problemId) {
  for (let retry = 0; retry < 3; retry++) {
    const result = await new Promise((resolve) => {
      const dbPath = "C:/Users/Administrator/AppData/Roaming/Code/User/globalStorage/state.vscdb";
      const script = `import sqlite3,json\ndb=sqlite3.connect(r"${dbPath}")\nrow=db.execute("SELECT value FROM ItemTable WHERE key='xmuoj.xmuoj-vscode'").fetchone()\ndata=json.loads(row[0])\nfor k,v in data.get("xmuoj.problemProgress",{}).items():\n if str(${problemId}) in k and "vscode c++" in k:\n  print("AC" if v.get("accepted") else "NOT")\n  break\nelse:\n print("NOT")\ndb.close()`;
      const proc = child_process.spawn("python", ["-c", script], { windowsHide: true });
      const timer = setTimeout(() => { proc.kill(); resolve(false); }, 3000);
      let out = "";
      proc.stdout.on("data", (d) => out += d.toString());
      proc.on("close", () => { clearTimeout(timer); resolve(out.trim() === "AC"); });
      proc.on("error", () => { clearTimeout(timer); resolve(false); });
    });
    if (result) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ---- 检查本地测试结果（最多重试 3 次） ----
async function checkProblemLocalPassed(problemId) {
  for (let retry = 0; retry < 3; retry++) {
    const result = await new Promise((resolve) => {
      const dbPath = "C:/Users/Administrator/AppData/Roaming/Code/User/globalStorage/state.vscdb";
      const script = `import sqlite3,json\ndb=sqlite3.connect(r"${dbPath}")\nrow=db.execute("SELECT value FROM ItemTable WHERE key='xmuoj.xmuoj-vscode'").fetchone()\ndata=json.loads(row[0])\nfor k,v in data.get("xmuoj.problemProgress",{}).items():\n if str(${problemId}) in k and "vscode c++" in k:\n  lp=v.get("lastLocalPassed",0) or 0\n  lt=v.get("lastLocalTotal",0) or 0\n  print("PASS" if lp>=lt>0 else "FAIL")\n  break\nelse:\n print("FAIL")\ndb.close()`;
      const proc = child_process.spawn("python", ["-c", script], { windowsHide: true });
      const timer = setTimeout(() => { proc.kill(); resolve(false); }, 3000);
      let out = "";
      proc.stdout.on("data", (d) => out += d.toString());
      proc.on("close", () => { clearTimeout(timer); resolve(out.trim() === "PASS"); });
      proc.on("error", () => { clearTimeout(timer); resolve(false); });
    });
    if (result) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

// ---- 激活扩展 ----
function activate(context) {
  // 批量提交（模拟手动：打开文件 → 调用 XMUOJ 命令提交）
  context.subscriptions.push(
    vscode.commands.registerCommand("xmuoj-batch.submitAll", async () => {
      try {
        // 1. 扫描题目
        const allProblems = await scanProblems();
        if (allProblems.length === 0) {
          vscode.window.showWarningMessage(
            "没有找到 XMUOJ 题目。请先用 XMUOJ 插件打开实验。"
          );
          return;
        }

        // 2. 只保留已开题且有代码内容的
        const readyProblems = allProblems.filter((p) => p.hasCode);
        const skipped = allProblems.length - readyProblems.length;

        if (readyProblems.length === 0) {
          vscode.window.showWarningMessage(
            `找到 ${allProblems.length} 道题，但都没有代码内容。`
          );
          return;
        }

        // 3. 多选列表（默认全选）
        const items = readyProblems.map((p) => {
          const lines = p.code.trim().split("\n").length;
          return {
            label: `$(code) ${p.meta.displayId || "?"}`,
            description: p.meta.title || "",
            detail: `$(file-code) ${path.basename(p.sourceFile)} · ${lines} 行 · ${path.basename(path.dirname(p.dir))}`,
            picked: true,
            problem: p,
          };
        });

        const selected = await vscode.window.showQuickPick(items, {
          title: `XMUOJ 批量提交 — ${readyProblems.length} 道可提交${skipped ? `（${skipped} 道无代码已跳过）` : ""}`,
          canPickMany: true,
          placeHolder: "选择要提交的题目（默认全选，空格切换）",
          matchOnDescription: true,
          matchOnDetail: true,
        });

        if (!selected || selected.length === 0) return;

        // 4. 开始提交（模拟手动：打开文件 → 调用 XMUOJ 命令提交）
        const total = selected.length;
        const results = [];

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `XMUOJ 批量提交 (0/${total})`,
            cancellable: true,
          },
          async (progress, token) => {
            for (let i = 0; i < total; i++) {
              if (token.isCancellationRequested) break;

              const p = selected[i].problem;
              const displayId = p.meta.displayId;
              progress.report({
                message: `[${i + 1}/${total}] ${displayId} ${p.meta.title}`,
                increment: 100 / total,
              });

              let doc;
              try {
                // 打开源文件（聚焦编辑器，模拟手动打开）
                doc = await vscode.workspace.openTextDocument(p.sourceFile);
                await vscode.window.showTextDocument(doc, { preview: false });
                // 等编辑器就绪
                await new Promise((r) => setTimeout(r, 300));

                // 调用 XMUOJ 插件的提交流程（模拟手动）
                await vscode.commands.executeCommand("xmuoj.submitCurrentFile");

                // 等 XMUOJ 写入结果到数据库
                await new Promise((r) => setTimeout(r, 500));

                // 查数据库判断是否 AC
                const isAC = await checkProblemAC(p.meta.problemId);
                if (isAC) {
                  // AC → 切回源文件再关 tab
                  await vscode.window.showTextDocument(doc);
                  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
                  results.push({ displayId, title: p.meta.title, ok: true, result: "Accepted" });
                } else {
                  // 非 AC → 保留 tab 供查看
                  results.push({ displayId, title: p.meta.title, ok: true, result: "非AC（保留窗口）" });
                }
              } catch (err) {
                // 出错关掉 tab
                try { if (doc) { await vscode.window.showTextDocument(doc); await vscode.commands.executeCommand("workbench.action.closeActiveEditor"); } } catch {}
                const msg = String(err.message || err);
                // 如果是限流错误，等待后重试
                const waitMatch = msg.match(/wait\s+(\d+)\s*seconds?/i);
                if (waitMatch) {
                  const waitSec = parseInt(waitMatch[1], 10) + 1;
                  progress.report({ message: `[${i + 1}/${total}] ⏳ 限流等待 ${waitSec - 1}s...` });
                  await new Promise((r) => setTimeout(r, waitSec * 1000));
                  // 重试一次
                  try {
                    await vscode.commands.executeCommand("xmuoj.submitCurrentFile");
                    results.push({ displayId, title: p.meta.title, ok: true, result: "已提交(重试)" });
                  } catch (err2) {
                    results.push({ displayId, title: p.meta.title, ok: false, error: String(err2.message || err2) });
                  }
                } else {
                  results.push({ displayId, title: p.meta.title, ok: false, error: msg });
                }
              }

              // 短暂间隔避免太快
              await new Promise((r) => setTimeout(r, 500));
            }
          }
        );

        // 5. 输出结果
        const okCount = results.filter((r) => r.ok).length;
        const failCount = results.filter((r) => !r.ok).length;
        const lines = [];
        lines.push(`批量提交结果 — ${new Date().toLocaleString("zh-CN")}`);
        lines.push("=".repeat(55));
        for (const r of results) {
          const icon = r.ok ? "✅" : "❌";
          lines.push(`${icon} [${r.displayId}] ${r.title} — ${r.result || r.error}`);
        }
        lines.push("=".repeat(55));
        lines.push(`总计: ${results.length} 题 | 成功: ${okCount} | 失败: ${failCount}`);

        const output = vscode.window.createOutputChannel("XMUOJ Batch");
        output.clear();
        output.appendLine(lines.join("\n"));
        output.show();

        vscode.window.showInformationMessage(
          `✅ 批量提交完成: ${okCount} 成功 / ${failCount} 失败（共 ${total} 题）`
        );
      } catch (err) {
        vscode.window.showErrorMessage(`批量提交出错: ${err.message}`);
      }
    })
  );

  // === 批量下载样本 ===
  context.subscriptions.push(
    vscode.commands.registerCommand("xmuoj-batch.downloadSamples", async () => {
      const allProblems = await scanProblems();
      if (allProblems.length === 0) {
        vscode.window.showWarningMessage("没有找到题目");
        return;
      }
      const missingList = [];
      for (const p of allProblems) {
        if (await checkMissingSamples(p.dir)) missingList.push(p);
      }
      if (missingList.length === 0) {
        vscode.window.showInformationMessage("所有题目样本数据已完整");
        return;
      }

      const items = missingList.map((p) => ({
        label: `$(cloud-download) ${p.meta.displayId || "?"}`,
        description: p.meta.title || "",
        picked: true,
        problem: p,
      }));

      const selected = await vscode.window.showQuickPick(items, {
        title: `下载样本 — ${missingList.length} 道缺失`,
        canPickMany: true,
        placeHolder: "选择要下载样本的题目（默认全选）",
      });
      if (!selected || selected.length === 0) return;

      let ok = 0;
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `下载样本 (0/${selected.length})`, cancellable: true },
        async (progress, token) => {
          for (let i = 0; i < selected.length; i++) {
            if (token.isCancellationRequested) break;
            progress.report({ message: `[${i + 1}/${selected.length}] ${selected[i].problem.meta.displayId}`, increment: 100 / selected.length });
            const result = await downloadSamples(selected[i].problem, () => {});
            if (result) ok++;
          }
        }
      );
      vscode.window.showInformationMessage(`✅ 样本下载完成: ${ok}/${selected.length}`);
    })
  );

  // === 批量本地测试 ===
  context.subscriptions.push(
    vscode.commands.registerCommand("xmuoj-batch.runLocalTests", async () => {
      try {
        const allProblems = await scanProblems();
        const readyProblems = allProblems.filter((p) => p.hasCode);
        if (readyProblems.length === 0) {
          vscode.window.showWarningMessage("没有找到含代码的题目");
          return;
        }

        const items = readyProblems.map((p) => ({
          label: `$(beaker) ${p.meta.displayId || "?"}`,
          description: p.meta.title || "",
          detail: `$(file-code) ${path.basename(p.sourceFile)} · ${path.basename(path.dirname(p.dir))}`,
          picked: true,
          problem: p,
        }));

        const selected = await vscode.window.showQuickPick(items, {
          title: `XMUOJ 批量本地测试 — ${readyProblems.length} 道`,
          canPickMany: true,
          placeHolder: "选择要测试的题目（默认全选）",
        });
        if (!selected || selected.length === 0) return;

        const total = selected.length;
        const results = [];

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `批量本地测试 (0/${total})`, cancellable: true },
          async (progress, token) => {
            for (let i = 0; i < total; i++) {
              if (token.isCancellationRequested) break;
              const p = selected[i].problem;
              progress.report({ message: `[${i + 1}/${total}] ${p.meta.displayId} ${p.meta.title}`, increment: 100 / total });

              let doc;
              try {
                // 检查样本是否存在，缺失则自动下载
                const missing = await checkMissingSamples(p.dir);
                if (missing) {
                  progress.report({ message: `[${i + 1}/${total}] ${p.meta.displayId} 下载样本...` });
                  await downloadSamples(p, (msg) => progress.report({ message: `[${i + 1}/${total}] ${p.meta.displayId} ${msg}` }));
                }

                doc = await vscode.workspace.openTextDocument(p.sourceFile);
                await vscode.window.showTextDocument(doc, { preview: false });
                await new Promise((r) => setTimeout(r, 300));

                await vscode.commands.executeCommand("xmuoj.runLocalTests");

                // 等 XMUOJ 写入结果到数据库
                await new Promise((r) => setTimeout(r, 500));

                // 检查是否全部通过
                const passed = await checkProblemLocalPassed(p.meta.problemId);
                if (passed) {
                  // 切回源文件再关 tab（runLocalTests 后焦点可能在 OUTPUT）
                  await vscode.window.showTextDocument(doc);
                  await vscode.commands.executeCommand("workbench.action.closeActiveEditor");
                  results.push({ displayId: p.meta.displayId, title: p.meta.title, ok: true, result: "全部通过" });
                } else {
                  results.push({ displayId: p.meta.displayId, title: p.meta.title, ok: true, result: "有失败（保留窗口）" });
                }
              } catch (err) {
                try { if (doc) await vscode.window.showTextDocument(doc); await vscode.commands.executeCommand("workbench.action.closeActiveEditor"); } catch {}
                results.push({ displayId: p.meta.displayId, title: p.meta.title, ok: false, error: String(err.message || err) });
              }
              await new Promise((r) => setTimeout(r, 500));
            }
          }
        );

        // 输出结果
        const lines = [`批量本地测试 — ${new Date().toLocaleString("zh-CN")}`, "=".repeat(55)];
        for (const r of results) {
          const icon = r.result === "全部通过" ? "✅" : r.ok ? "⚠️" : "❌";
          lines.push(`${icon} [${r.displayId}] ${r.title} — ${r.result || r.error}`);
        }
        lines.push("=".repeat(55));
        const passCount = results.filter((r) => r.result === "全部通过").length;
        lines.push(`总计: ${results.length} 题 | 全部通过: ${passCount} | 有失败: ${results.length - passCount}`);

        const output = vscode.window.createOutputChannel("XMUOJ Batch");
        output.clear();
        output.appendLine(lines.join("\n"));
        output.show();
      } catch (err) {
        vscode.window.showErrorMessage(`批量本地测试出错: ${err.message}`);
      }
    })
  );

  // === Git 命令 ===

  // Git: 一键初始化仓库
  context.subscriptions.push(
    vscode.commands.registerCommand("xmuoj-batch.gitSetup", async () => {
      const rootPath = vscode.workspace.getConfiguration("xmuoj").get("localWorkspaceRoot") || "";
      if (!rootPath) {
        vscode.window.showWarningMessage("请先配置 xmuoj.localWorkspaceRoot");
        return;
      }
      const cwd = path.resolve(rootPath);

      // 检查是否已是 git 仓库
      try {
        await execGitCapture(cwd, ["rev-parse", "--git-dir"]);
        const remotes = await execGitCapture(cwd, ["remote", "-v"]);
        vscode.window.showInformationMessage(
          `已是 Git 仓库。\n远程地址:\n${remotes.trim() || "(未配置)"}`
        );
        return;
      } catch {
        // 不是 git 仓库，继续初始化
      }

      const repoUrl = await vscode.window.showInputBox({
        title: "Git 仓库地址",
        prompt: "输入你的 GitHub 仓库地址（如 https://github.com/用户名/仓库名.git）",
        placeHolder: "https://github.com/你的用户名/xmuoj-code.git",
        ignoreFocusOut: true,
      });
      if (!repoUrl) return;

      const output = vscode.window.createOutputChannel("XMUOJ Git");
      output.clear();
      output.appendLine("初始化 Git 仓库...");
      output.appendLine("=".repeat(40));

      try {
        await execGit(cwd, ["init"], output);
        // 创建 .gitignore
        const giPath = path.join(cwd, ".gitignore");
        try { await fs.access(giPath); } catch {
          await fs.writeFile(giPath, "# 编译产物\n*.exe\n*.o\n*.obj\n\n# XMUOJ 构建目录\n.xmuoj-build/\n\n# IDE\n.vscode/\n.idea/\n");
        }
        await execGit(cwd, ["add", "."], output);
        await execGit(cwd, ["commit", "-m", "初始提交"], output);
        await execGit(cwd, ["branch", "-M", "main"], output);
        await execGit(cwd, ["remote", "add", "origin", repoUrl], output);
        await execGit(cwd, ["push", "-u", "origin", "main"], output);

        output.appendLine("✅ Git 初始化完成！");
        output.show();
        vscode.window.showInformationMessage("✅ Git 仓库已初始化并推送到远程");
      } catch (err) {
        output.appendLine(`❌ 失败: ${err.message}`);
        output.show();
        vscode.window.showErrorMessage(`Git 初始化失败: ${err.message}`);
      }
    })
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("xmuoj-batch.gitPull", async () => {
      const rootPath = vscode.workspace.getConfiguration("xmuoj").get("localWorkspaceRoot") || "";
      if (!rootPath) {
        vscode.window.showWarningMessage("请先配置 xmuoj.localWorkspaceRoot");
        return;
      }
      const cwd = path.resolve(rootPath);
      try {
        const output = vscode.window.createOutputChannel("XMUOJ Git");
        output.clear();
        output.appendLine(`git pull (${cwd})`);
        output.appendLine("=".repeat(40));

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "git pull..." },
          async () => {
            await execGit(cwd, ["pull"], output);
          }
        );

        output.appendLine("✅ 拉取完成");
        output.show();
        vscode.window.showInformationMessage("✅ git pull 完成");
      } catch (err) {
        vscode.window.showErrorMessage(`git pull 失败: ${err.message}`);
      }
    })
  );

  // Git: 一键提交并推送
  context.subscriptions.push(
    vscode.commands.registerCommand("xmuoj-batch.gitPush", async () => {
      const rootPath = vscode.workspace.getConfiguration("xmuoj").get("localWorkspaceRoot") || "";
      if (!rootPath) {
        vscode.window.showWarningMessage("请先配置 xmuoj.localWorkspaceRoot");
        return;
      }
      const cwd = path.resolve(rootPath);

      // 先检查有没有改动
      try {
        const status = await execGitCapture(cwd, ["status", "--porcelain"]);
        if (!status.trim()) {
          vscode.window.showInformationMessage("没有需要提交的改动");
          return;
        }
        // 显示改动列表
        const changes = status.trim().split("\n").slice(0, 20).join("\n");
        const ans = await vscode.window.showInformationMessage(
          `改动文件:\n${changes}${status.trim().split("\n").length > 20 ? "\n..." : ""}`,
          { modal: true },
          "提交并推送"
        );
        if (ans !== "提交并推送") return;
      } catch (err) {
        vscode.window.showErrorMessage("不是 Git 仓库，请先运行「初始化 Git 仓库」");
        return;
      }

      const msg = await vscode.window.showInputBox({
        title: "Git Commit 信息",
        prompt: "输入提交信息",
        value: `更新代码 - ${new Date().toLocaleString("zh-CN")}`,
        ignoreFocusOut: true,
      });
      if (!msg) return;

      const output = vscode.window.createOutputChannel("XMUOJ Git");
      output.clear();
      output.appendLine(`git add & commit & push (${cwd})`);
      output.appendLine("=".repeat(40));

      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "git add..." },
          async () => {
            await execGit(cwd, ["add", "."], output);
          }
        );
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "git commit..." },
          async () => {
            await execGit(cwd, ["commit", "-m", msg], output);
          }
        );
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: "git push..." },
          async () => {
            await execGit(cwd, ["push"], output);
          }
        );

        output.appendLine("✅ 推送完成");
        output.show();
        vscode.window.showInformationMessage("✅ git push 完成");
      } catch (err) {
        output.appendLine(`❌ 失败: ${err.message}`);
        output.show();
        vscode.window.showErrorMessage(`git 操作失败: ${err.message}`);
      }
    })
  );
}

function execGit(cwd, args, output) {
  return new Promise((resolve, reject) => {
    const proc = child_process.spawn("git", args, { cwd, windowsHide: true });
    proc.stdout.on("data", (d) => output.appendLine(d.toString().trimEnd()));
    proc.stderr.on("data", (d) => output.appendLine(d.toString().trimEnd()));
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args[0]} 返回 ${code}`));
    });
    proc.on("error", reject);
  });
}

function execGitCapture(cwd, args) {
  return new Promise((resolve, reject) => {
    const proc = child_process.spawn("git", args, { cwd, windowsHide: true });
    let out = "";
    proc.stdout.on("data", (d) => (out += d.toString()));
    proc.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`git ${args[0]} 返回 ${code}`));
    });
    proc.on("error", reject);
  });
}

function deactivate() {}

module.exports = { activate, deactivate };
