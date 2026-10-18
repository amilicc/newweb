const { chromium } = require("playwright");
const { spawn, execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { encryptText, decryptText } = require("./keepalive-crypto");

const { addLog } = require("./logger");

let browser = null;
let context = null;
// 登录保活任务使用独立 BrowserContext，但共用同一个 Chromium 进程。
const keepaliveContexts = new Map();
const keepaliveStateBackupAt = new Map();
const keepaliveStateHashes = new Map();
let browserStartupPromise = null;
let browserStateBackupRunning = false;
const BROWSER_STATE_BACKUP_INTERVAL = 60 * 60 * 1000;
let lastBrowserStateBackupAt = 0;
let lastBrowserStateHash = null;

const dataDir = process.env.DATA_DIR || "/tmp/remain-data";
const browserStateEncryptedPath = path.join(dataDir, "browser-state.enc");
const legacyPlainBrowserStatePath = path.join(dataDir, "browser-state.json");
let restoredBrowserState = null;
const browserStateRestoreDir = path.join(dataDir, "browser-state-restore");
const rcloneConfigPath = path.join(dataDir, "rclone.conf");
const remoteFolder = (process.env.REMOTE_FOLDER || "").replace(/\/+$/, "");
const configuredRemoteBrowserFolder = (process.env.KEEPALIVE_REMOTE_FOLDER || "").replace(/\/+$/, "");
// 浏览器登录态必须使用独立路径，避免与 app-backup.sqlite 的远程目录混用。
const remoteBrowserFolder = configuredRemoteBrowserFolder && configuredRemoteBrowserFolder !== remoteFolder
  ? configuredRemoteBrowserFolder
  : `${remoteFolder}-browser-state`;
const rcloneConf = process.env.RCLONE_CONF || "";

let xvfb = null;
let fluxbox = null;

let display = ":99";


/*
 * ============================
 * 启动 Xvfb
 * ============================
 */

async function startXvfb() {

  console.log(
    `[Browser] 正在启动 Xvfb：${display}`
  );

  xvfb = spawn(
    "Xvfb",
    [
      display,
      "-screen",
      "0",
      "1920x1080x24",
      "-ac",
      "-nolisten",
      "tcp"
    ],
    {
      detached: false,
      stdio: [
        "ignore",
        "ignore",
        "pipe"
      ]
    }
  );

  if (xvfb.stderr) {

    xvfb.stderr.on(
      "data",
      chunk => {

        console.error(
          "[Xvfb]",
          chunk.toString().trim()
        );

      }
    );

  }

  await new Promise(
    (resolve, reject) => {

      let finished = false;

      const timer =
        setTimeout(
          () => {

            if (finished) {
              return;
            }

            finished = true;

            resolve();

          },
          1000
        );

      xvfb.once(
        "error",
        error => {

          if (finished) {
            return;
          }

          finished = true;

          clearTimeout(timer);

          reject(error);

        }
      );

      xvfb.once(
        "exit",
        code => {

          if (finished) {
            return;
          }

          if (
            code !== null &&
            code !== 0
          ) {

            finished = true;

            clearTimeout(timer);

            reject(
              new Error(
                `Xvfb 启动失败，退出码 ${code}`
              )
            );

          }

        }
      );

    }
  );

  process.env.DISPLAY = display;

  console.log(
    `[Browser] Xvfb 启动完成：${display}`
  );

}


/*
 * ============================
 * 启动 Fluxbox
 * ============================
 */

async function startFluxbox() {

  try {

    fluxbox = spawn(
      "fluxbox",
      [],
      {
        detached: false,
        stdio: "ignore"
      }
    );

    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          500
        )
    );

    console.log(
      "[Browser] Fluxbox 启动完成"
    );

  } catch (error) {

    console.log(
      "[Browser] Fluxbox 启动失败，继续运行"
    );

  }

}


/*
 * ============================
 * 启动浏览器
 * ============================
 */

async function ensureBrowser() {
  if (browser && context) return;
  if (browserStartupPromise) return browserStartupPromise;

  browserStartupPromise = (async () => {
    await startXvfb();
    await startFluxbox();

    fs.mkdirSync(dataDir, { recursive: true });

    console.log(`[Browser] 当前 DISPLAY：${process.env.DISPLAY}`);
    console.log("[Browser] 启动 Chromium");

    const launchOptions = {
      headless: false,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--disable-software-rasterizer",
        "--disable-blink-features=AutomationControlled"
      ]
    };

    // 以单个 Chromium 进程承载多个隔离上下文。主 Remain 功能仍使用自己的主上下文。
    browser = await chromium.launch(launchOptions);
    const contextOptions = {
      viewport: { width: 1920, height: 1080 }
    };
    if (restoredBrowserState) {
      contextOptions.storageState = restoredBrowserState;
      console.log("[Browser] 将加载已恢复的主浏览器登录态");
    }
    context = await browser.newContext(contextOptions);
    restoredBrowserState = null;
    console.log("[Browser] Chromium 启动成功（主上下文已创建）");
  })();

  try {
    await browserStartupPromise;
  } catch (error) {
    if (context) { try { await context.close(); } catch {} context = null; }
    if (browser) { try { await browser.close(); } catch {} browser = null; }
    if (xvfb) { try { xvfb.kill(); } catch {} xvfb = null; }
    if (fluxbox) { try { fluxbox.kill(); } catch {} fluxbox = null; }
    throw error;
  } finally {
    browserStartupPromise = null;
  }
}

function prepareBrowserRcloneConfig() {
  if (!rcloneConf.trim()) return false;
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(rcloneConfigPath, rcloneConf, { encoding: "utf8", mode: 0o600 });
  return true;
}

function validateStorageState(state) {
  return Boolean(
    state &&
    typeof state === "object" &&
    Array.isArray(state.cookies) &&
    Array.isArray(state.origins)
  );
}

function keepaliveStatePaths(taskId) {
  const taskDir = path.join(dataDir, "browser-states", `task-${Number(taskId)}`);
  return {
    taskDir,
    localPath: path.join(taskDir, "browser-state.enc"),
    restoreDir: path.join(dataDir, "browser-state-restore", `task-${Number(taskId)}`),
    remoteDir: `${remoteBrowserFolder}/tasks/task-${Number(taskId)}`
  };
}

async function restoreKeepaliveState(taskId) {
  const paths = keepaliveStatePaths(taskId);
  fs.mkdirSync(paths.taskDir, { recursive: true });
  let cloudPath = null;

  if (remoteFolder && remoteBrowserFolder && rcloneConf.trim()) {
    try {
      prepareBrowserRcloneConfig();
      fs.rmSync(paths.restoreDir, { recursive: true, force: true });
      fs.mkdirSync(paths.restoreDir, { recursive: true });
      execFileSync("rclone", [
        "--config", rcloneConfigPath,
        "copy", paths.remoteDir, paths.restoreDir
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
      const candidate = path.join(paths.restoreDir, "browser-state.enc");
      if (fs.existsSync(candidate)) cloudPath = candidate;
    } catch {
      // 新任务还没有云端快照是正常情况，继续尝试本地加密快照。
    }
  }

  const candidates = [];
  if (cloudPath) candidates.push({ source: "云端", path: cloudPath });
  if (fs.existsSync(paths.localPath)) candidates.push({ source: "本地", path: paths.localPath });

  try {
    for (const candidate of candidates) {
      try {
        const state = JSON.parse(decryptText(fs.readFileSync(candidate.path, "utf8")));
        if (!validateStorageState(state)) throw new Error("登录态备份内容无效");
        if (candidate.source === "云端") {
          fs.copyFileSync(candidate.path, paths.localPath);
          try { fs.chmodSync(paths.localPath, 0o600); } catch {}
        }
        const hash = crypto.createHash("sha256").update(JSON.stringify(state)).digest("hex");
        keepaliveStateHashes.set(Number(taskId), hash);
        keepaliveStateBackupAt.set(Number(taskId), Date.now());
        console.log(`[BrowserState] 保活任务 #${taskId} 已从${candidate.source}恢复独立登录态`);
        return state;
      } catch (error) {
        console.error(`[BrowserState] 保活任务 #${taskId} 的${candidate.source}登录态不可用：${String(error.message || "校验失败").slice(0, 160)}`);
      }
    }
  } finally {
    fs.rmSync(paths.restoreDir, { recursive: true, force: true });
  }

  console.log(`[BrowserState] 保活任务 #${taskId} 没有独立登录态快照，将创建全新隔离上下文`);
  return undefined;
}

async function createKeepalivePage(taskId) {
  await ensureBrowser();
  const id = Number(taskId);
  if (!Number.isInteger(id) || id < 1) throw new Error("无效的登录保活任务 ID");
  if (keepaliveContexts.has(id)) {
    try { await keepaliveContexts.get(id).close(); } catch {}
    keepaliveContexts.delete(id);
  }
  const storageState = await restoreKeepaliveState(id);
  const options = { viewport: { width: 1920, height: 1080 } };
  if (storageState) options.storageState = storageState;
  const taskContext = await browser.newContext(options);
  keepaliveContexts.set(id, taskContext);
  try {
    return await taskContext.newPage();
  } catch (error) {
    keepaliveContexts.delete(id);
    try { await taskContext.close(); } catch {}
    throw error;
  }
}

async function backupKeepaliveBrowserState(taskId, force = false) {
  const id = Number(taskId);
  const taskContext = keepaliveContexts.get(id);
  if (!taskContext) return false;
  const lastAt = keepaliveStateBackupAt.get(id) || 0;
  if (!force && lastAt && Date.now() - lastAt < BROWSER_STATE_BACKUP_INTERVAL) return true;

  const paths = keepaliveStatePaths(id);
  if (!remoteFolder || !remoteBrowserFolder || !rcloneConf.trim()) {
    console.error(`[BrowserState] 保活任务 #${id} 未配置 REMOTE_FOLDER / RCLONE_CONF，无法云端备份登录态`);
    return false;
  }

  try {
    prepareBrowserRcloneConfig();
    fs.mkdirSync(paths.taskDir, { recursive: true });
    const state = await taskContext.storageState({ indexedDB: true });
    if (!validateStorageState(state)) throw new Error("浏览器未生成有效登录态快照");
    const stateJson = JSON.stringify(state);
    const hash = crypto.createHash("sha256").update(stateJson).digest("hex");
    if (keepaliveStateHashes.get(id) === hash) {
      keepaliveStateBackupAt.set(id, Date.now());
      console.log(`[BrowserState] 保活任务 #${id} 登录态未变化，跳过上传`);
      return true;
    }

    fs.writeFileSync(paths.localPath, encryptText(stateJson), { encoding: "utf8", mode: 0o600 });
    execFileSync("rclone", [
      "--config", rcloneConfigPath,
      "copy", paths.localPath, paths.remoteDir
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
    keepaliveStateHashes.set(id, hash);
    keepaliveStateBackupAt.set(id, Date.now());
    console.log(`[BrowserState] 保活任务 #${id} 的独立登录态已加密备份到云端`);
    return true;
  } catch (error) {
    const reason = String(error.message || "未知错误").split("\nCall log:")[0].slice(0, 200);
    console.error(`[BrowserState] 保活任务 #${id} 独立登录态备份失败：${reason}`);
    return false;
  }
}

async function closeKeepaliveContext(taskId, saveState = true) {
  const id = Number(taskId);
  const taskContext = keepaliveContexts.get(id);
  if (!taskContext) return;
  if (saveState) await backupKeepaliveBrowserState(id, true);
  keepaliveContexts.delete(id);
  try { await taskContext.close(); } catch {}
}

/*
 * 在服务监听和任何任务调度器启动前调用。
 * 数据库模块在 server.js 加载时已经同步完成数据库恢复，因此此处自然排在数据库恢复之后。
 */
async function restoreBrowserState() {
  if (!remoteBrowserFolder || !remoteFolder || !rcloneConf.trim()) {
    console.log("[BrowserState] 未配置 rclone 远程目录或 RCLONE_CONF，跳过云端登录态恢复");
    return false;
  }

  try {
    prepareBrowserRcloneConfig();
    fs.rmSync(browserStateRestoreDir, { recursive: true, force: true });
    fs.mkdirSync(browserStateRestoreDir, { recursive: true });

    try {
      execFileSync("rclone", [
        "--config", rcloneConfigPath,
        "copy", `${remoteBrowserFolder}/browser-state.enc`, browserStateRestoreDir
      ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });
    } catch (error) {
      // 第一次启动时云端目录尚不存在属于正常情况；继续检查本地加密副本。
      console.log("[BrowserState] 云端登录态备份暂不可用，将检查本地加密备份");
    }

    const cloudPath = path.join(browserStateRestoreDir, "browser-state.enc");
    const candidates = [];
    if (fs.existsSync(cloudPath)) {
      candidates.push({ source: "云端", path: cloudPath });
    }
    if (fs.existsSync(browserStateEncryptedPath)) {
      candidates.push({ source: "本地", path: browserStateEncryptedPath });
    }

    for (const candidate of candidates) {
      try {
        const encrypted = fs.readFileSync(candidate.path, "utf8");
        const state = JSON.parse(decryptText(encrypted));
        if (!validateStorageState(state)) throw new Error("登录态备份内容无效");

        // 只有云端快照解密且校验成功后才更新本地副本，避免损坏文件覆盖可用备份。
        if (candidate.source === "云端") {
          fs.copyFileSync(candidate.path, browserStateEncryptedPath);
          try { fs.chmodSync(browserStateEncryptedPath, 0o600); } catch {}
        }
        restoredBrowserState = state;
        console.log(`[BrowserState] 已从${candidate.source}恢复浏览器登录态到内存，等待 Chromium 启动`);
        return true;
      } catch (error) {
        console.error(`[BrowserState] ${candidate.source}登录态备份不可用：${String(error.message || "校验失败").slice(0, 180)}`);
      }
    }

    console.log("[BrowserState] 未找到可用登录态备份，按首次启动处理");
    restoredBrowserState = null;
    return false;
  } catch (error) {
    restoredBrowserState = null;
    console.error(`[BrowserState] 登录态恢复未完成：${String(error.message || "未知错误").slice(0, 240)}`);
    return false;
  } finally {
    fs.rmSync(browserStateRestoreDir, { recursive: true, force: true });
    // 清理旧版本可能遗留的明文登录态文件。
    try { fs.rmSync(legacyPlainBrowserStatePath, { force: true }); } catch {}
  }
}

async function backupBrowserState() {
  // 登录保活刷新可以频繁执行，但成功备份后 1 小时内不重复上传。
  // 首次调用立即备份；后续由正常刷新触发检查，达到间隔后才再次上传。
  if (lastBrowserStateBackupAt && Date.now() - lastBrowserStateBackupAt < BROWSER_STATE_BACKUP_INTERVAL) {
    return true;
  }
  if (browserStateBackupRunning) {
    console.log("[BrowserState] 上一次登录态备份尚未结束，跳过本次");
    return false;
  }
  if (!remoteFolder || !remoteBrowserFolder || !rcloneConf.trim()) {
    console.error("[BrowserState] 未配置 REMOTE_FOLDER / RCLONE_CONF，无法云端备份登录态");
    return false;
  }

  browserStateBackupRunning = true;
  try {
    await ensureBrowser();
    prepareBrowserRcloneConfig();
    fs.mkdirSync(dataDir, { recursive: true });

    // Playwright 生成一致的 Cookie / Local Storage / IndexedDB 快照，避免复制活动中的 Chromium profile。
    const state = await context.storageState({ indexedDB: true });
    if (!validateStorageState(state)) throw new Error("浏览器未生成有效登录态快照");

    const stateJson = JSON.stringify(state);
    const stateHash = crypto.createHash("sha256").update(stateJson).digest("hex");
    if (lastBrowserStateHash && stateHash === lastBrowserStateHash) {
      lastBrowserStateBackupAt = Date.now();
      console.log("[BrowserState] 登录态内容未变化，跳过 rclone 上传（下次最早 1 小时后检查）");
      return true;
    }

    const encrypted = encryptText(stateJson);
    fs.writeFileSync(browserStateEncryptedPath, encrypted, { encoding: "utf8", mode: 0o600 });

    execFileSync("rclone", [
      "--config", rcloneConfigPath,
      "copy", browserStateEncryptedPath, remoteBrowserFolder
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 });

    lastBrowserStateBackupAt = Date.now();
    lastBrowserStateHash = stateHash;
    console.log("[BrowserState] 登录态已加密备份到云端（下次最早 1 小时后）");
    return true;
  } catch (error) {
    const reason = String(error.message || "未知错误").split("\nCall log:")[0].slice(0, 240);
    console.error(`[BrowserState] 登录态云端备份失败：${reason}`);
    return false;
  } finally {
    browserStateBackupRunning = false;
  }
}

async function createPage() {
  await ensureBrowser();
  return context.newPage();
}


/*
 * ============================
 * 清理错误信息
 *
 * 注意：
 * 网页日志绝对不能暴露
 * URL、密码、Token 等敏感信息。
 * ============================
 */

function sanitizeErrorMessage(error) {

  let message = "";

  if (
    error &&
    typeof error.message === "string"
  ) {

    message = error.message;

  } else if (
    typeof error === "string"
  ) {

    message = error;

  } else {

    message = "未知错误";

  }


  /*
   * 隐藏 URL
   */

  message =
    message.replace(
      /https?:\/\/[^\s"'<>]+/gi,
      "[目标地址]"
    );


  /*
   * 隐藏常见密码 / Token 参数
   */

  message =
    message.replace(
      /([?&](?:password|passwd|pwd|token|access_token|refresh_token|api_key|apikey|secret|authorization|auth)=)[^&\s"'<>]*/gi,
      "$1[已隐藏]"
    );


  /*
   * 隐藏 password=xxx
   */

  message =
    message.replace(
      /\b(password|passwd|pwd|token|access_token|refresh_token|api_key|apikey|secret|authorization|auth)\s*=\s*[^\s&"'<>]+/gi,
      "$1=[已隐藏]"
    );


  /*
   * 隐藏 Bearer Token
   */

  message =
    message.replace(
      /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
      "Bearer [已隐藏]"
    );


  /*
   * Playwright Call log
   *
   * Call log 里面可能再次出现完整 URL，
   * 所以直接截断。
   */

  const callLogIndex =
    message.indexOf(
      "\nCall log:"
    );

  if (
    callLogIndex !== -1
  ) {

    message =
      message.slice(
        0,
        callLogIndex
      );

  }


  /*
   * 防止错误信息过长
   */

  if (
    message.length > 500
  ) {

    message =
      message.slice(
        0,
        500
      ) +
      "...";

  }

  return (
    message.trim() ||
    "未知错误"
  );

}


/*
 * ============================
 * 访问网页
 * ============================
 */

async function visit(
  url,
  staySeconds = 10
) {

  /*
   * 确保浏览器已经启动
   */

  await ensureBrowser();


  /*
   * 网页日志：
   * 只显示安全的执行步骤。
   *
   * 绝对不把 url 写入 addLog()
   */

  addLog(
    "打开浏览器"
  );


  let page = null;

  try {

    page =
      await context.newPage();


    /*
     * Render 后台日志
     *
     * 不输出 URL
     */

    console.log(
      "[Browser] 开始执行网页访问"
    );


    /*
     * 网页日志
     */

    addLog(
      "正在访问目标网站"
    );


    /*
     * 实际访问
     *
     * URL 只传给 Playwright，
     * 不写入日志。
     */

    await page.goto(
      url,
      {
        waitUntil:
          "domcontentloaded",

        timeout:
          60000
      }
    );


    /*
     * Render 后台日志
     */

    console.log(
      "[Browser] 页面加载完成"
    );


    /*
     * 网页日志
     */

    addLog(
      "页面加载完成"
    );


    /*
     * 停留时间
     */

    addLog(
      `停留 ${staySeconds} 秒`
    );


    if (
      staySeconds > 0
    ) {

      await page.waitForTimeout(
        staySeconds * 1000
      );

    }


    /*
     * Render 后台日志
     */

    console.log(
      "[Browser] 停留完成"
    );


    return {
      success: true
    };

  } catch (error) {

    /*
     * 只保留安全的错误信息
     */

    const reason =
      sanitizeErrorMessage(
        error
      );


    /*
     * 网页日志
     *
     * 不包含 URL
     */

    addLog(
      `访问失败：${reason}`,
      "error"
    );


    /*
     * Render 后台日志
     *
     * 同样不输出 URL。
     */

    console.error(
      `[Browser] 访问失败：${reason}`
    );


    return {
      success: false,
      error: reason
    };

  } finally {

    /*
     * 每次任务完成后关闭当前页面
     */

    if (page) {

      try {

        await page.close();

      } catch (error) {

        console.error(
          "[Browser] 页面关闭失败"
        );

      }

    }

  }

}


/*
 * ============================
 * 关闭浏览器
 * ============================
 */

async function closeBrowser() {
  console.log("[Browser] 正在关闭浏览器...");
  for (const id of [...keepaliveContexts.keys()]) {
    await closeKeepaliveContext(id, true);
  }
  if (context) {
    try { await context.close(); }
    catch { console.error("[Browser] 关闭主浏览器上下文失败"); }
    context = null;
  }
  if (browser) {
    try { await browser.close(); }
    catch { console.error("[Browser] 关闭 Chromium 失败"); }
    browser = null;
  }
  if (fluxbox) { try { fluxbox.kill(); } catch {} fluxbox = null; }
  if (xvfb) { try { xvfb.kill(); } catch {} xvfb = null; }
  console.log("[Browser] 浏览器已关闭");
}

/*
 * ============================
 * 导出
 * ============================
 */

module.exports = {
  visit,
  closeBrowser,
  ensureBrowser,
  createPage,
  createKeepalivePage,
  backupKeepaliveBrowserState,
  closeKeepaliveContext,
  restoreBrowserState,
  backupBrowserState
};
