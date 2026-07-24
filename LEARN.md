# XMUOJ Batch 插件实现详解 — 看懂它，改它

> 目标：你有 C/C++ 基础，这份文档帮你读懂这个 VS Code 插件的每一行代码，能自己改 bug、加功能。

---

## 第一件事：这个插件到底干了什么

一句话：**自动操作 VS Code，帮你批量做原本要手动一遍遍做的事**。

```
你要做的事                          插件帮你做
─────────                          ─────────
1. 打开题目文件                     自动扫描目录，找到所有题目
2. 点"提交"按钮                     自动打开文件 → 调用 XMUOJ 提交命令
3. 看结果，AC 就关标签页             自动查数据库 → AC 就关 tab → 继续下一题
4. WA 就留着调试                    WA 就保留窗口给你看
5. 全部做完，人工数几个 AC           自动输出汇总：45题，AC 42，WA 1...
```

---

## 先看整体结构（10 分钟搞懂）

打开 `extension.js`，740 行代码，分三层：

```
┌─────────────────────────────────────────────┐
│  顶层：6 个命令（用户从 VS Code 命令面板调用）   │
│  submitAll  gitPull  gitPush  gitSetup       │
│  runLocalTests  downloadSamples              │
├─────────────────────────────────────────────┤
│  中层：8 个工具函数（命令调用它们干活）          │
│  scanProblems()   扫描所有题目                │
│  checkProblemAC() 查某题是否已 AC             │
│  checkProblemLocalPassed() 查本地测试是否全过  │
│  checkMissingSamples() 检查样本是否缺失       │
│  downloadSamples() 从 xmuoj 下载样本         │
│  submissionCount() 查提交次数                 │
│  closeTab()       关闭标签页                  │
│  spawnPython()    执行 Python 脚本            │
├─────────────────────────────────────────────┤
│  底层：3 个能力（Node.js 提供的）              │
│  child_process.spawn()  执行外部程序 (git/python) │
│  fs.readFile/readdir    读写文件和目录         │
│  vscode.* API           操控 VS Code 界面     │
└─────────────────────────────────────────────┘
```

**你只需要看懂中层 8 个函数，再加一个顶层命令做例子，就全通了。**

---

## 开工前要懂的 JavaScript 语法（最少必要知识）

你学过 C++，下面这些就够了，5 分钟看完：

```javascript
// ===== 1. 变量：没有类型，用 let/const =====
// C++:  int x = 5;        string s = "hello";
let x = 5;                  // 可变
const PI = 3.14;            // 常量，不能重新赋值

// ===== 2. 函数：function 或 => =====
function add(a, b) { return a + b; }        // 普通写法
const add = (a, b) => a + b;                 // 箭头函数（等同上面）
const add = async (a, b) => { return a + b; } // async 函数（后面讲）

// ===== 3. 对象 = C++ 的 struct =====
const problem = {
    displayId: "LinK01",   // 属性
    title: "A+B",
    hasCode: true,
};
console.log(problem.title); // 访问 → "A+B"

// ===== 4. 数组 = C++ 的 vector =====
let nums = [1, 2, 3, 4];
nums.filter(n => n > 2);   // 过滤 → [3, 4]
nums.map(n => n * 2);       // 映射 → [2, 4, 6, 8]
nums.some(f => f.endsWith(".in")); // 有任何一个满足条件? → bool

// ===== 5. 字符串：用反引号可以嵌入变量 =====
let name = "LinK01";
console.log(`题目: ${name}`); // 输出：题目: LinK01
//               ^        ^
//               └─ 反引号（键盘左上角 ~ 那个键）
//                  里面的 ${} 会被替换成变量的值
```

---

## 核心技能 1：async/await —"等结果"怎么写

**这是插件里最重要的概念。** C++ 里函数 return 了你才能用结果，但 JavaScript 有些操作需要等（读文件、网络请求、等 VS Code 执行完），你不能让整个程序卡住。

```javascript
// ❌ 错误理解：这不是"暂停整个程序"
// ✅ 正确理解：这是"我在这里等，但别的活可以先干"

async function example() {
    // "等我读完这个文件，再继续往下"
    const content = await fs.readFile("main.cpp", "utf8");
    // ↑ await = 停在这一行，等 readFile 完成，拿到结果，然后继续

    console.log(content); // 文件读完了，这行才执行

    // "等 500 毫秒"
    await new Promise(r => setTimeout(r, 500));
    // ↑ 不需要理解这行为什么这样写，就当"暂停 500ms"

    console.log("500ms 后");
}
```

**规则很简单：**
1. 函数前加 `async` → 这个函数可以 `await`
2. `await 某个操作` → 等它完成，拿到返回值
3. 只有返回 Promise 的东西才能 await（fs 函数、vscode API 都返回 Promise）

---

## 函数 1：spawnPython() — 怎么调用 Python

```javascript
// 第 34-36 行
function spawnPython(script, timeout) {
  return child_process.spawn(getPythonPath(), ["-c", script],
    { windowsHide: true, timeout });
}
```

**等效于你在终端里敲：**
```bash
"C:/Users/24431/.../python.exe" -c "print('hello')"
```

插件把一段 Python 代码当作字符串传给 `python -c`，等它执行完，读输出。

**为什么用 Python？** VS Code 的数据存在 SQLite 数据库里，Node.js 不方便读 SQLite，但 Python 自带 `sqlite3` 模块直接用。

**getPythonPath() 干了什么（第 12-31 行）：**
```javascript
// 挨个试这些路径，哪个存在就用哪个
C:/Users/24431/AppData/Local/Programs/Python/Python313/python.exe
C:/Users/24431/AppData/Local/Programs/Python/Python312/python.exe
...
// 都不存在就 fallback 到 PATH 里的 "python"
```

---

## 函数 2：scanProblems() — 怎么找到所有题目

```javascript
// 第 39-90 行
async function scanProblems() {
    const rootPath = "D:\\vscode c++";  // 从 VS Code 配置读

    // 第 1 步：找 contest-* 目录
    const entries = await fs.readdir(rootPath, { withFileTypes: true });
    // entries = ["contest-362", "problemsets", ...]

    for (const contestDir of contestDirs) {
        // 第 2 步：找每个题目目录
        const subDirs = await fs.readdir(contestDir);
        // subDirs = ["LinK01-a-b", "LinK02-problem", ...]

        for (const problemDir of subDirs) {
            // 第 3 步：读 .xmuoj.json
            const metaRaw = await fs.readFile(".xmuoj.json", "utf8");
            const meta = JSON.parse(metaRaw);
            // meta = { problemId: 7464, displayId: "LinK01", title: "A+B" }

            // 第 4 步：读源代码，检查是否有内容
            const code = await fs.readFile("main.cpp", "utf8");
            const hasCode = code.trim().length > 0;

            problems.push({ dir, meta, sourceFile, hasCode, code });
        }
    }
    return problems;
}
```

**和 C++ 的对比——你完全能理解：**
```cpp
// 这和你写过的遍历文件夹逻辑一模一样
// C++ 版伪代码：
vector<Problem> scanProblems(string rootPath) {
    vector<Problem> problems;
    for (auto& contestDir : fs::readdir(rootPath)) {
        for (auto& problemDir : fs::readdir(contestDir)) {
            auto meta = JSON::parse(fs::readFile(problemDir + "/.xmuoj.json"));
            auto code = fs::readFile(problemDir + "/main.cpp");
            problems.push_back({problemDir, meta, code});
        }
    }
    return problems;
}
```

---

## 函数 3：checkProblemLocalPassed() — 判断本地测试是否全过

```javascript
// 第 228-245 行
async function checkProblemLocalPassed(problemId) {
    // 重试 3 次（因为 XMUOJ 插件可能需要时间写数据库）
    for (let retry = 0; retry < 3; retry++) {
        const result = await new Promise((resolve) => {
            // 构造一段 Python 脚本
            const script = `
                import sqlite3, json
                db = sqlite3.connect(r"...\state.vscdb")
                row = db.execute("SELECT ...").fetchone()
                data = json.loads(row[0])
                for k, v in data["xmuoj.problemProgress"].items():
                    if "${problemId}" in k:
                        lp = v.get("lastLocalPassed", 0) or 0
                        lt = v.get("lastLocalTotal", 0) or 0
                        print("PASS" if lp >= lt > 0 else "FAIL")
                        break
                db.close()
            `;
            const proc = spawnPython(script);   // 执行 Python
            proc.stdout.on("data", (chunk) => out += chunk); // 收集输出
            proc.on("close", () => resolve(out.trim() === "PASS")); // 判断结果
        });
        if (result) return true;  // PASS！直接返回
        await new Promise(r => setTimeout(r, 500)); // FAIL，等 500ms 重试
    }
    return false; // 3 次都 FAIL
}
```

**这函数的逻辑（看注释就够了）：**
1. 开一个 Python 进程
2. Python 连 VS Code 的数据库
3. 查 `problemProgress` 表里这个题目的 `lastLocalPassed`（通过了几组）和 `lastLocalTotal`（总共几组）
4. 如果 `通过数 >= 总数 > 0` → 打印 `PASS`
5. Node.js 收到 `PASS` → 返回 `true`；收到 `FAIL` → 重试（最多 3 次）

---

## 函数 4：checkProblemAC() — 判断平台评测是否 AC

和第 3 个几乎一样，只是 Python 查的字段不同：

```python
# checkProblemAC 查的是
v.get("accepted")     # → True/False

# checkProblemLocalPassed 查的是
v.get("lastLocalPassed")  # → 数字
v.get("lastLocalTotal")   # → 数字
```

**模式完全一样：构造 Python 脚本 → spawn → 读输出 → 判断。**

---

## 函数 5-8：辅助函数（快速过）

```javascript
// checkMissingSamples(dir) — 检查 samples/ 里有没有 .in 和 .out
// 原理：fs.readdir("samples/")，然后看文件列表里有没有 .in 和 .out

// downloadSamples(problem) — 从 XMUOJ 下载样本
// 原理：先试 xmuoj.openProblem 命令（让 XMUOJ 插件下）
//       失败则用 Python 读 cookie → 调 xmuoj API → 写文件

// closeTab(doc) — 关闭某个文件的标签页
// 原理：遍历 VS Code 所有标签组，找到匹配的文件路径，关掉

// submissionCount(problemId) — 查提交次数
// 原理：和上面一样，Python 查数据库，返回数字
```

---

## 完整走一遍：批量提交命令是怎么工作的

这是最复杂的命令，理解了它，其他 5 个都是简化版。

```javascript
// 第 251-405 行，command: xmuoj-batch.submitAll
async () => {
    // ═══ 阶段 1：准备 ═══
    const allProblems = await scanProblems();          // 扫出所有题目
    const readyProblems = allProblems.filter(p => p.hasCode); // 只要写了代码的

    // 弹出多选列表让用户勾选
    const selected = await vscode.window.showQuickPick(items, {
        canPickMany: true,  // 可以多选
        title: "选择要提交的题目",
    });

    // ═══ 阶段 2：逐个提交 ═══
    for (const p of selected) {
        // 2a. 已经 AC 的跳过（省时间）
        if (await checkProblemAC(p.meta.problemId)) {
            results.push({ result: "已 AC，跳过" });
            continue;
        }

        // 2b. 打开文件
        const doc = await vscode.workspace.openTextDocument(p.sourceFile);
        await vscode.window.showTextDocument(doc);
        await new Promise(r => setTimeout(r, 300));  // 等 VS Code 渲染

        // 2c. 调用 XMUOJ 插件的提交命令
        await vscode.commands.executeCommand("xmuoj.submitCurrentFile");

        // 2d. 等提交完成 + 判题结果返回
        await new Promise(r => setTimeout(r, 500));

        // 2e. 查数据库，看判题结果
        if (await checkProblemAC(p.meta.problemId)) {
            await closeTab(doc);         // AC → 关掉标签页
            results.push({ result: "Accepted" });
        } else {
            // WA → 不关标签页，让用户看到代码
            results.push({ result: "非 AC（保留窗口）" });
        }
    }

    // ═══ 阶段 3：输出汇总 ═══
    // 打印：✅ LinK01 A+B — Accepted
    //       ⚠️ LinK19 指数型枚举 — 非 AC（保留窗口）
    //       总计: 45 题 | 成功: 42 | 失败: 3
};
```

---

## 怎么改这个插件：3 个实操练习

### 练习 1（简单）：加一个"统计代码行数"的命令

在 `activate()` 函数里，照着其他命令的格式加一段：

```javascript
// 加在 activate() 函数里面，随便哪个 registerCommand 后面
context.subscriptions.push(
  vscode.commands.registerCommand("xmuoj-batch.countLines", async () => {
    const problems = await scanProblems();
    let total = 0;
    for (const p of problems) {
      total += p.code.trim().split("\n").length;
    }
    vscode.window.showInformationMessage(`总共 ${total} 行代码`);
  })
);
```

别忘了在 `package.json` 里也注册这个命令：
```json
{
  "command": "xmuoj-batch.countLines",
  "title": "XMUOJ: 统计代码行数"
}
```

### 练习 2（中等）：加个过滤器，跳过不需要测试的题

现在 `runLocalTests` 会测所有题。加上一个逻辑：如果题目目录名包含 "skip" 就跳过。

提示：改 `scanProblems()` 或者在 `runLocalTests` 的 filter 里加条件。

### 练习 3（进阶）：给 git push 加上 commit message 模板

现在 git push 弹的输入框默认值是"更新代码 - 日期"。改成根据实际改动内容自动生成 message（比如 "完成 LinK20, LinK21"）。

提示：用 `execGitCapture(cwd, ["diff", "--name-only"])` 获取改动了哪些文件。

---

## 数据库里到底存了什么（直接看）

在终端运行这个命令，你能看到所有题目的本地测试状态：

```bash
"C:/Users/24431/AppData/Local/Programs/Python/Python311/python.exe" -c "
import sqlite3, json
db = sqlite3.connect(r'C:\Users\24431\AppData\Roaming\Code\User\globalStorage\state.vscdb')
row = db.execute(\"SELECT value FROM ItemTable WHERE key='xmuoj.xmuoj-vscode'\").fetchone()
data = json.loads(row[0])
pp = data.get('xmuoj.problemProgress', {})
for k, v in pp.items():
    print(f'{k}  lastLocalPassed={v.get(\"lastLocalPassed\")}  accepted={v.get(\"accepted\")}')
db.close()
"
```

---

## 必知必会：VS Code API 速查表

插件里用到的 VS Code API 就这些，照着抄就行：

| API | 作用 | 在哪用 |
|-----|------|--------|
| `vscode.window.showInformationMessage(msg)` | 右下角弹出信息提示 | 到处 |
| `vscode.window.showWarningMessage(msg)` | 弹出警告 | 到处 |
| `vscode.window.showErrorMessage(msg)` | 弹出错误 | git 操作失败时 |
| `vscode.window.showInputBox({prompt, placeHolder})` | 弹出输入框 | git commit message |
| `vscode.window.showQuickPick(items, opts)` | 弹出多选列表 | 选题目时 |
| `vscode.window.withProgress(opts, callback)` | 显示进度条 | 逐个提交/测试时 |
| `vscode.window.createOutputChannel(name)` | 创建输出面板 | 打印结果汇总 |
| `vscode.workspace.openTextDocument(path)` | 打开文件（不显示） | 打开题目 |
| `vscode.window.showTextDocument(doc)` | 显示文件 | 打开题目 |
| `vscode.window.tabGroups.close(tab)` | 关闭标签页 | AC 后关 tab |
| `vscode.commands.executeCommand(cmd, args)` | 调用另一个插件的命令 | 调 XMUOJ 插件 |
| `vscode.workspace.getConfiguration("xmuoj").get("key")` | 读用户设置 | 读工作区路径 |

---

## 总结：你学到了什么

1. **VS Code 插件就是个 JavaScript 文件**，有一个 `activate()` 入口函数，在里面注册命令
2. **`package.json` 是菜单**，告诉 VS Code "我有哪些命令、叫什么名字"
3. **命令 = 事件处理函数**：用户点按钮 → 运行你的代码 → 操控 VS Code 界面
4. **`await` = 等结果**：等文件读完、等测试跑完、等 Python 返回
5. **`spawn("python", ...)` = 用 Python 当工具**：读取 VS Code 的 SQLite 数据库
6. **`vscode.commands.executeCommand()` = 调用别的插件**：让 XMUOJ 插件干活
7. **Git 操作 = spawn("git", ...)**：在指定目录执行 git 命令，把输出显示到面板
8. **可以改的地方**：加新命令、改判断逻辑、改输出格式、加过滤器——都是改一个函数的事

---

有问题随时问。你现在可以试试做练习 1，我在旁边帮你。
