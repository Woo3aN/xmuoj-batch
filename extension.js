const vscode = require("vscode");
const http = require("http");
const https = require("https");
const path = require("path");
const fs = require("fs/promises");

// ---- 配置 ----
const BASE_URL = "http://xmuoj.com";
const SESSION_KEY = "xmuoj-batch.session";
const SUBMIT_INTERVAL = 200; // ms

// ---- HTTP 工具 ----
function httpRequest(method, urlPath, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(BASE_URL + urlPath);
    const transport = u.protocol === "https:" ? https : http;
    const headers = {
      "Content-Type": "application/json",
      "User-Agent": "Mozilla/5.0 (compatible; XMUOJ-Batch/1.0)",
      Connection: "close",
      ...opts.headers,
    };
    if (opts.cookie) headers.Cookie = opts.cookie;
    if (opts.csrf) headers["X-CSRFToken"] = opts.csrf;

    const req = transport.request(
      { hostname: u.hostname, port: u.port || (u.protocol === "https:" ? 443 : 80), path: u.pathname + u.search, method, headers },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          let data = null;
          try { data = JSON.parse(body); } catch (_) { /* not json */ }
          // set-cookie 可能是 string / string[] / undefined
          let rawCookies = res.headers["set-cookie"];
          if (!rawCookies) rawCookies = [];
          if (typeof rawCookies === "string") rawCookies = [rawCookies];
          resolve({
            status: res.statusCode,
            body,
            data,
            cookies: parseSetCookie(rawCookies),
          });
        });
      }
    );
    req.on("error", (e) => reject(new Error(`网络错误: ${e.message}`)));
    req.setTimeout(30000, () => { req.destroy(); reject(new Error("请求超时")); });
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function parseSetCookie(entries) {
  const jar = {};
  if (!Array.isArray(entries)) return jar;
  for (const entry of entries) {
    if (!entry) continue;
    const pair = entry.split(";")[0].trim();
    const eqIdx = pair.indexOf("=");
    if (eqIdx > 0) jar[pair.slice(0, eqIdx).trim()] = pair.slice(eqIdx + 1).trim();
  }
  return jar;
}

function mergeCookies(existing, newJar) {
  const jar = {};
  if (existing) {
    for (const part of existing.split(";")) {
      const eq = part.indexOf("=");
      if (eq > 0) jar[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
  }
  Object.assign(jar, newJar);
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
}

function extractCsrf(cookieStr) {
  const m = (cookieStr || "").match(/csrftoken=([^;]+)/);
  return m ? m[1] : "";
}

// ---- Cookie 管理 ----
let _cookieCache = null;

async function getCookie(secrets) {
  if (_cookieCache) return _cookieCache;
  _cookieCache = await secrets.get(SESSION_KEY);
  return _cookieCache;
}

async function saveCookie(secrets, cookieStr) {
  _cookieCache = cookieStr;
  await secrets.store(SESSION_KEY, cookieStr);
}

// ---- 登录 ----
async function doLogin(secrets) {
  const username = await vscode.window.showInputBox({
    title: "XMUOJ 登录", prompt: "用户名（学号）", ignoreFocusOut: true,
  });
  if (!username) return null;

  const password = await vscode.window.showInputBox({
    title: "XMUOJ 登录", prompt: "密码", password: true, ignoreFocusOut: true,
  });
  if (!password) return null;

  // 1. POST /api/login
  const res1 = await httpRequest("POST", "/api/login", {
    body: JSON.stringify({ username, password }),
  });
  if (res1.data && res1.data.error) {
    vscode.window.showErrorMessage(`登录失败: ${res1.data.data || res1.data.error}`);
    return null;
  }

  let cookieStr = mergeCookies("", res1.cookies);

  // 2. 验证 session
  const res2 = await httpRequest("GET", "/api/plugin/bootstrap", {
    cookie: cookieStr,
    csrf: extractCsrf(cookieStr),
  });
  if (res2.data && res2.data.error) {
    // 可能还需要插件登录
    const res3 = await httpRequest("POST", "/api/plugin/login", {
      body: JSON.stringify({ username, password }),
      cookie: cookieStr,
      csrf: extractCsrf(cookieStr),
    });
    if (res3.data && res3.data.error) {
      vscode.window.showErrorMessage(`登录验证失败: ${res3.data.data || res3.data.error}`);
      return null;
    }
    if (res3.cookies) cookieStr = mergeCookies(cookieStr, res3.cookies);
  }

  await saveCookie(secrets, cookieStr);
  vscode.window.showInformationMessage("✅ XMUOJ 登录成功");
  return cookieStr;
}

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

// ---- 提交 ----
async function submitOne(cookieStr, problem, contestPassword, onWait) {
  const { meta, code } = problem;
  const payload = {
    problem_id: meta.problemId,
    contest_id: meta.contestId || undefined,
    language: meta.language || "C++",
    code,
  };
  if (contestPassword) payload.contest_password = contestPassword;

  // 最多重试 5 次（处理 Please wait 限流）
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await httpRequest("POST", "/api/plugin/submission", {
      body: JSON.stringify(payload),
      cookie: cookieStr,
      csrf: extractCsrf(cookieStr),
    });

    // 处理响应
    if (!res.data) {
      return { ok: false, error: `HTTP ${res.status}: ${res.body.slice(0, 100)}` };
    }
    if (res.data.error) {
      const msg = res.data.data || res.data.error;
      // 限流错误 "Please wait X seconds"
      const waitMatch = String(msg).match(/wait\s+(\d+)\s*seconds?/i);
      if (waitMatch) {
        const waitSec = parseInt(waitMatch[1], 10);
        if (onWait) onWait(waitSec);
        await new Promise((r) => setTimeout(r, (waitSec + 1) * 1000));
        cookieStr = mergeCookies(cookieStr, res.cookies);
        continue;
      }
      return { ok: false, error: msg };
    }
    // 成功
    _cookieCache = mergeCookies(cookieStr, res.cookies);
    const sub = res.data.data || res.data;
    return { ok: true, submission_id: sub.submission_id || "?", cookies: res.cookies };
  }

  return { ok: false, error: "重试次数用尽" };
}

async function waitForResult(cookieStr, submissionId, maxWait = 30) {
  for (let i = 0; i < maxWait; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    try {
      const res = await httpRequest("GET", `/api/plugin/submission?submission_id=${submissionId}`, {
        cookie: cookieStr,
      });
      if (res.data && !res.data.error) {
        const result = res.data.data || res.data;
        const label = result.result_label || "";
        if (label && !["Pending", "Compiling", "Running", "Waiting"].includes(label)) {
          return result;
        }
      }
    } catch { /* retry */ }
  }
  return null;
}

const child_process = require("child_process");

// ---- 更新 XMUOJ 插件题目进度 ----
async function updateXmuojProgress(context, finalResults, failedSubmissions) {
  // 构建进度数据
  const workspaceRoot = (vscode.workspace.getConfiguration("xmuoj").get("localWorkspaceRoot") || "").replace(/\\/g, "\\\\");
  const progressEntries = {};

  for (const r of finalResults) {
    const key = `http://xmuoj.com::${r.contestId || 362}::${r.problemId}::${workspaceRoot}`;
    progressEntries[key] = {
      baseUrl: "http://xmuoj.com",
      problemId: r.problemId,
      displayId: r.displayId,
      title: r.title,
      contestId: r.contestId || 362,
      contestTitle: r.contestTitle || "",
      progressScope: workspaceRoot.replace(/\\\\/g, "\\"),
      updatedAt: new Date().toISOString(),
      workspaceCreated: true,
      language: r.language || "C++",
      sourceFile: "main.cpp",
      lastSubmissionId: r.submissionId || 0,
      lastSubmissionLabel: r.result || "Unknown",
      accepted: r.result === "Accepted",
    };
  }

  // 也处理提交失败的
  for (const f of failedSubmissions) {
    const key = `http://xmuoj.com::${f.contestId || 362}::${f.problemId}::${workspaceRoot}`;
    if (!progressEntries[key]) {
      progressEntries[key] = {
        baseUrl: "http://xmuoj.com",
        problemId: f.problemId,
        displayId: f.displayId,
        title: f.title,
        contestId: f.contestId || 362,
        contestTitle: f.contestTitle || "",
        progressScope: workspaceRoot.replace(/\\\\/g, "\\"),
        updatedAt: new Date().toISOString(),
        workspaceCreated: true,
        language: f.language || "C++",
        sourceFile: "main.cpp",
        lastSubmissionLabel: f.error || "Submit Failed",
        accepted: false,
      };
    }
  }

  if (Object.keys(progressEntries).length === 0) return;

  // 用 Python 更新 SQLite
  const dbPath = path.join(process.env.APPDATA || "", "Code", "User", "globalStorage", "state.vscdb");
  const pythonScript = `
import sqlite3, json, sys
db_path = ${JSON.stringify(dbPath)}
entries = ${JSON.stringify(progressEntries)}
try:
    db = sqlite3.connect(db_path)
    row = db.execute("SELECT value FROM ItemTable WHERE key = 'xmuoj.xmuoj-vscode'").fetchone()
    if not row:
        print("NO_ROW")
        sys.exit(1)
    data = json.loads(row[0])
    if 'xmuoj.problemProgress' not in data:
        data['xmuoj.problemProgress'] = {}
    existing = data['xmuoj.problemProgress']
    updated = 0
    for k, v in entries.items():
        old = existing.get(k, {})
        # 合并：保留已有的值，用新值覆盖
        existing[k] = {**old, **v}
        updated += 1
    data['xmuoj.problemProgress'] = existing
    db.execute("UPDATE ItemTable SET value = ? WHERE key = 'xmuoj.xmuoj-vscode'", (json.dumps(data, ensure_ascii=False),))
    db.commit()
    db.close()
    print(f"OK:{updated}")
except Exception as e:
    print(f"ERR:{e}")
    sys.exit(1)
`;

  return new Promise((resolve) => {
    const proc = child_process.spawn("python", ["-c", pythonScript], {
      windowsHide: true,
      timeout: 10000,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("close", (code) => {
      if (code === 0 && stdout.trim().startsWith("OK:")) {
        const updated = parseInt(stdout.trim().split(":")[1], 10);
        console.log(`[xmuoj-batch] Updated ${updated} problem progress entries`);
        resolve(updated);
      } else {
        console.error(`[xmuoj-batch] Failed to update progress: ${stdout} ${stderr}`);
        resolve(0);
      }
    });
    proc.on("error", (err) => {
      console.error(`[xmuoj-batch] Python error: ${err.message}`);
      resolve(0);
    });
  });
}
function activate(context) {
  // 登录命令
  context.subscriptions.push(
    vscode.commands.registerCommand("xmuoj-batch.login", async () => {
      await doLogin(context.secrets);
    })
  );

  // 批量提交
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

        // 4. 登录态
        let cookieStr = await getCookie(context.secrets);
        if (!cookieStr) {
          const ans = await vscode.window.showInformationMessage(
            "尚未登录 XMUOJ，是否现在登录？", "登录", "取消"
          );
          if (ans !== "登录") return;
          cookieStr = await doLogin(context.secrets);
          if (!cookieStr) return;
        }

        // 5. 实验密码
        const needPwd = await vscode.window.showQuickPick(
          ["不需要密码", "需要输入实验密码"],
          { title: "实验是否需要密码？", placeHolder: "选择..." }
        );
        let contestPassword;
        if (needPwd === "需要输入实验密码") {
          contestPassword = await vscode.window.showInputBox({
            prompt: "实验密码", password: true, ignoreFocusOut: true,
          });
          if (contestPassword === undefined) return;
        }

        // 6. 开始提交
        const total = selected.length;
        let succeeded = 0;
        let failed = 0;
        const submissions = [];

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
              progress.report({
                message: `[${i + 1}/${total}] ${p.meta.displayId} ${p.meta.title}`,
                increment: 100 / total,
              });

              const res = await submitOne(cookieStr, p, contestPassword, (waitSec) => {
                progress.report({ message: `[${i + 1}/${total}] ⏳ 限流等待 ${waitSec}s...` });
              });
              if (res.ok) {
                succeeded++;
                submissions.push({ ...p.meta, submissionId: res.submission_id, ok: true });
              } else {
                failed++;
                submissions.push({ ...p.meta, error: res.error, ok: false });
              }
              await new Promise((r) => setTimeout(r, SUBMIT_INTERVAL));
            }
          }
        );

        vscode.window.showInformationMessage(
          `✅ 提交完成: ${succeeded} OK / ${failed} 失败（共 ${total} 题）`
        );

        // 7. 询问是否等待判题
        const waitAns = await vscode.window.showInformationMessage(
          "是否等待判题结果？", "等待结果", "跳过"
        );
        if (waitAns !== "等待结果") return;

        const toCheck = submissions.filter((s) => s.ok);
        const finalResults = [];

        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `等待判题 (0/${toCheck.length})`,
            cancellable: true,
          },
          async (progress, token) => {
            for (let i = 0; i < toCheck.length; i++) {
              if (token.isCancellationRequested) break;
              const s = toCheck[i];
              progress.report({
                message: `[${i + 1}/${toCheck.length}] ${s.displayId} ${s.title}`,
                increment: 100 / toCheck.length,
              });
              const result = await waitForResult(cookieStr, s.submissionId);
              finalResults.push({
                ...s,
                result: result ? result.result_label : "超时",
              });
            }
          }
        );

        // 8. 输出结果
        const acCount = finalResults.filter((r) => r.result === "Accepted").length;
        const lines = [];
        lines.push(`批量提交结果 — ${new Date().toLocaleString("zh-CN")}`);
        lines.push("=".repeat(55));
        for (const r of finalResults) {
          const icon = r.result === "Accepted" ? "✅" : r.result === "超时" ? "⏳" : "❌";
          lines.push(`${icon} [${r.displayId}] ${r.title} — ${r.result}`);
        }
        const failedOnes = submissions.filter((s) => !s.ok);
        if (failedOnes.length) {
          lines.push("—".repeat(55));
          for (const f of failedOnes) {
            lines.push(`❌ [${f.displayId}] ${f.title} — 提交失败: ${f.error}`);
          }
        }
        lines.push("=".repeat(55));
        lines.push(`总计: ${finalResults.length} 题 | AC: ${acCount} | 非AC: ${finalResults.length - acCount} | 提交失败: ${failedOnes.length}`);

        const output = vscode.window.createOutputChannel("XMUOJ Batch");
        output.clear();
        output.appendLine(lines.join("\n"));
        output.show();

        // 9. 更新 XMUOJ 插件题目进度
        const updated = await updateXmuojProgress(context, finalResults, submissions.filter((s) => !s.ok));
        if (updated > 0) {
          const reload = await vscode.window.showInformationMessage(
            `已更新 ${updated} 道题状态。重载窗口后 XMUOJ 题目列表显示最新结果。`,
            "立即重载"
          );
          if (reload === "立即重载") {
            vscode.commands.executeCommand("workbench.action.reloadWindow");
          }
        }
      } catch (err) {
        vscode.window.showErrorMessage(`批量提交出错: ${err.message}`);
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
        await execGit(cwd, ["branch", "-M", "master"], output);
        await execGit(cwd, ["remote", "add", "origin", repoUrl], output);
        await execGit(cwd, ["push", "-u", "origin", "master"], output);

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
        // git status 失败，可能不是 git 仓库
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
