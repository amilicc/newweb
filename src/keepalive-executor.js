const {
  getKeepaliveTaskForExecution,
  updateKeepaliveTaskStatus
} = require("./database");
const { createKeepalivePage, backupKeepaliveBrowserState, closeKeepaliveContext } = require("./browser");
const { addLog } = require("./logger");

const activeTasks = new Map();
const startingTasks = new Map();

function safeMessage(value) {
  return String(value || "未知错误")
    .replace(/https?:\/\/[^\s"'<>]+/gi, "[目标地址]")
    .replace(/\b(password|passwd|pwd|token|secret)\s*=\s*[^\s&"'<>]+/gi, "$1=[已隐藏]")
    .split("\nCall log:")[0]
    .slice(0, 240);
}

async function firstVisible(page, selector) {
  if (!selector) return null;
  try {
    const locator = page.locator(selector).first();
    if (await locator.count() && await locator.isVisible()) return locator;
  } catch {}
  return null;
}

async function findVisible(page, customSelector, defaults) {
  if (customSelector) return firstVisible(page, customSelector);
  for (const selector of defaults) {
    const locator = await firstVisible(page, selector);
    if (locator) return locator;
  }
  return null;
}

// SPA 登录页可能在 domcontentloaded 之后才渲染表单。先给页面一个短暂稳定窗口，
// 避免因密码框暂时不存在而把尚未登录的页面误判为已有登录态。
async function waitForPasswordField(page, selector, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const field = await firstVisible(page, selector || 'input[type="password"]');
    if (field) return field;
    await page.waitForTimeout(250);
  }
  return firstVisible(page, selector || 'input[type="password"]');
}

function looksLikeLoginLocation(url, title) {
  let path = "";
  try { path = new URL(url).pathname; } catch {}
  return /(?:^|\/)(?:login|log-in|signin|sign-in|auth|authenticate|session)(?:\/|$)/i.test(path)
    || /\b(login|sign[ -]?in|log[ -]?in|authentication)\b/i.test(String(title || ""));
}

async function visibleLoginErrorText(page) {
  const selectors = [
    '[role="alert"]',
    '[aria-live="assertive"]',
    '[aria-live="polite"]',
    '[class*="error" i]',
    '[class*="invalid" i]'
  ];
  for (const selector of selectors) {
    try {
      const nodes = page.locator(selector);
      const count = Math.min(await nodes.count(), 5);
      for (let i = 0; i < count; i++) {
        const node = nodes.nth(i);
        if (!(await node.isVisible().catch(() => false))) continue;
        const value = (await node.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
        if (value) return value.slice(0, 180);
      }
    } catch {}
  }
  return "未发现常见错误提示元素";
}

// Wait for client-side rendering/session restoration after navigation. On many sites,
// the login form is visible in the initial HTML while JavaScript is still validating the
// existing session. If both markers are configured, give the success marker priority for
// a short grace period before accepting the logged-out marker as final.
async function waitForConfiguredAuthMarker(task, page, timeoutMs = 10000) {
  if (!task.success_selector && !task.logged_out_selector) return;
  const startedAt = Date.now();
  const graceMs = task.success_selector && task.logged_out_selector ? 5000 : 0;
  while (Date.now() - startedAt < timeoutMs) {
    const successMarker = task.success_selector
      ? await firstVisible(page, task.success_selector)
      : null;
    if (successMarker) return;

    const elapsed = Date.now() - startedAt;
    const loggedOutMarker = task.logged_out_selector
      ? await firstVisible(page, task.logged_out_selector)
      : null;
    // A logged-out marker can be present in the initial HTML before session restoration.
    // Do not treat it as authoritative until the grace period has elapsed.
    if (loggedOutMarker && elapsed >= graceMs) return;
    await page.waitForTimeout(250);
  }
}

async function loginIfRequired(task, page) {
  // Wait for either configured marker before deciding to submit credentials. This avoids
  // mistaking a temporarily hidden success marker during SPA initialization for logout.
  await waitForConfiguredAuthMarker(task, page);
  if (task.auth_mode === "none") {
    return { success: true, attempted: false, message: "页面已打开，保活运行中" };
  }

  // 优先使用每个网站单独配置的标记，避免每次刷新都重复提交密码。
  const loggedOutMarker = task.logged_out_selector
    ? await firstVisible(page, task.logged_out_selector)
    : null;
  const successMarker = task.success_selector
    ? await firstVisible(page, task.success_selector)
    : null;

  // A visible success marker is the strongest positive signal. It wins over a stale
  // login-page marker that may remain visible briefly during client-side page switching.
  if (successMarker) {
    return { success: true, attempted: false, message: "检测到登录成功标记，当前登录有效" };
  }

  // 当同时配置了登录成功和登录失效标记时，必须命中其中一个才能决定下一步。
  // 如果两个标记都没有出现，即使页面上存在密码框，也不能据此认定已掉线并重复提交凭据。
  if (task.success_selector && task.logged_out_selector && !successMarker && !loggedOutMarker) {
    return {
      success: false,
      attempted: false,
      message: "未检测到登录成功或登录失效标记，已暂停自动提交密码；请检查选择器是否匹配当前页面"
    };
  }

  // 即使未配置网站专属标记，也先等待动态登录表单渲染，不能仅凭“暂时没有密码框”就认定已登录。
  const passwordField = await waitForPasswordField(
    page,
    task.password_selector || 'input[type="password"]',
    5000
  );

  // 配置成功标记但未命中时，若也没有明确的登录表单/失效标记，不盲目提交密码。
  if (!loggedOutMarker && !passwordField) {
    if (task.success_selector) {
      return { success: false, attempted: false, message: "未检测到登录成功标记或登录表单，登录状态不明确；请检查成功/失效选择器" };
    }
    let currentTitle = "";
    try { currentTitle = await page.title(); } catch {}
    if (looksLikeLoginLocation(page.url(), currentTitle)) {
      return {
        success: false,
        attempted: false,
        message: "页面仍处于疑似登录路径或登录页面标题，但未找到可见密码框；无法确认登录状态，已避免误报为登录成功。请检查页面加载、密码选择器或网站登录流程"
      };
    }
    return {
      success: true,
      attempted: false,
      message: task.logged_out_selector
        ? "未检测到登录失效标记，按当前登录态继续保活"
        : "等待页面渲染后未发现登录表单，按已有登录态处理"
    };
  }

  if (!passwordField) {
    return { success: false, attempted: false, message: "检测到登录失效，但未找到可见的密码输入框；请检查密码选择器或登录页面" };
  }
  if (!task.password) {
    return { success: false, attempted: false, message: "缺少登录密码" };
  }

  let usernameField = null;
  if (task.auth_mode === "username_password") {
    usernameField = await findVisible(
      page,
      task.username_selector,
      [
        'input[autocomplete="username"]',
        'input[type="email"]',
        'input[name*="user" i]',
        'input[name*="email" i]',
        'input[type="text"]'
      ]
    );
    if (!usernameField || !task.username) {
      return { success: false, attempted: false, message: "未找到用户名输入框或未填写用户名；可在高级选项中设置用户名选择器" };
    }
    await usernameField.fill(task.username);
  }

  await passwordField.fill(task.password);
  const submit = await findVisible(page, task.submit_selector, [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Sign in")',
    'button:has-text("Log in")',
    'button:has-text("Login")',
    'button:has-text("Continue")'
  ]);

  // 仅记录按钮文本和是否填入字段，不记录用户名或密码本身。
  let submitDescription = "按 Enter 提交";
  let usernameFilled = task.auth_mode !== "username_password";
  let passwordFilled = false;
  try { usernameFilled = task.auth_mode !== "username_password" || Boolean((await usernameField.inputValue()).trim()); } catch {}
  try { passwordFilled = Boolean(await passwordField.inputValue()); } catch {}
  if (submit) {
    try {
      const buttonText = ((await submit.innerText().catch(() => "")) || (await submit.getAttribute("aria-label").catch(() => "")) || (await submit.getAttribute("type").catch(() => "submit"))).replace(/\s+/g, " ").trim().slice(0, 60);
      submitDescription = `点击按钮「${buttonText || "未命名"}」`;
    } catch { submitDescription = "点击匹配到的提交按钮"; }
    await submit.click({ timeout: 10000 });
  } else {
    await passwordField.press("Enter");
  }

  // 登录后各网站的跳转和前端状态更新速度不同。通用地轮询最多 30 秒，
  // 不将任何特定网站的 URL 写死；优先采用用户配置的成功标记，否则观察登录表单是否消失。
  const loginWaitStartedAt = Date.now();
  const loginWaitTimeoutMs = 30000;
  let successDetected = false;
  while (Date.now() - loginWaitStartedAt < loginWaitTimeoutMs) {
    if (task.success_selector) {
      const success = await firstVisible(page, task.success_selector);
      if (success) {
        successDetected = true;
        break;
      }
    } else {
      const stillLoggedOut = task.logged_out_selector
        ? await firstVisible(page, task.logged_out_selector)
        : null;
      const stillHasPassword = await firstVisible(page, task.password_selector || 'input[type="password"]');
      if (!stillLoggedOut && !stillHasPassword) {
        successDetected = true;
        break;
      }
    }
    await page.waitForTimeout(1000);
  }

  if (!successDetected) {
    let currentPath = "未知";
    let pageTitle = "未知";
    try { currentPath = new URL(page.url()).pathname || "/"; } catch {}
    try { pageTitle = (await page.title()).slice(0, 100) || "空"; } catch {}
    const stillLoggedOut = task.logged_out_selector
      ? await firstVisible(page, task.logged_out_selector)
      : null;
    const stillHasPassword = await firstVisible(page, task.password_selector || 'input[type="password"]');
    const stillHasUsername = task.auth_mode === "username_password"
      ? await firstVisible(page, task.username_selector || 'input[type="email"]')
      : null;
    const status = task.success_selector
      ? "未检测到配置的登录成功标记"
      : "登录表单或失效标记在等待结束时仍可见";
    const errorText = await visibleLoginErrorText(page);
    return {
      success: false,
      attempted: true,
      message: `${status}；等待 30 秒后诊断：路径=${currentPath}，标题=${pageTitle}，用户名框可见=${!!stillHasUsername}，密码框可见=${!!stillHasPassword}，用户名已填=${usernameFilled}，密码已填=${passwordFilled}，提交方式=${submitDescription}，失效标记可见=${!!stillLoggedOut}，页面提示=${errorText}。请检查凭据、选择器或网站登录流程`
    };
  }

  return { success: true, attempted: true, message: task.success_selector ? "检测到登录成功标记" : "等待后登录表单已消失，按登录成功处理" };
}

async function saveLoginState(record, force = false) {
  if (record.task.auth_mode === "none") return true;
  // 每次成功刷新都检查备份时机；实际上传频率由 browser.js 统一限制为每小时一次。
  // 因此刷新可以是 30 秒、60 秒等频率，但不会每次都执行 rclone 上传。
  record.stateBackupAttempted = true;
  record.stateSaved = await backupKeepaliveBrowserState(record.task.id, force);
  return record.stateSaved;
}

function scheduleRefresh(id, record) {
  if (record.stopRequested || record.needsAttention || activeTasks.get(id) !== record) return;
  record.timer = setTimeout(() => {
    refreshTask(id, record).catch(error => {
      if (!record.stopRequested) {
        const reason = safeMessage(error.message);
        updateKeepaliveTaskStatus(id, "error", `刷新失败：${reason}`, new Date().toISOString());
        addLog(`登录保活任务 #${id} 刷新失败：${reason}`, "error");
      }
      scheduleRefresh(id, record);
    });
  }, Math.max(10, Number(record.task.refresh_interval_seconds) || 60) * 1000);
  if (record.timer && typeof record.timer.unref === "function") record.timer.unref();
}

async function refreshTask(id, record) {
  if (record.stopRequested || activeTasks.get(id) !== record || record.refreshing) return;
  record.refreshing = true;
  try {
    if (record.page.isClosed()) throw new Error("保活页面已关闭");
    await record.page.reload({ waitUntil: "domcontentloaded", timeout: 60000 });
    const auth = await loginIfRequired(record.task, record.page);
    const now = new Date().toISOString();

    if (!auth.success) {
      record.needsAttention = true;
      updateKeepaliveTaskStatus(id, "needs_attention", auth.message, now);
      addLog(`登录保活任务 #${id} 需要处理：${auth.message}`, "error");
    } else {
      record.needsAttention = false;
      if (auth.attempted) {
        record.stateSaved = false;
        record.stateBackupAttempted = false;
      }
      const backedUp = await saveLoginState(record, auth.attempted);
      const message = !record.stateSaved && !backedUp
        ? `${auth.message}；云端登录态备份失败，请检查 rclone 配置`
        : auth.message;
      updateKeepaliveTaskStatus(id, "running", message, now);
      if (auth.attempted) {
        addLog(`登录保活任务 #${id} 已执行登录提交并完成本轮检查`);
      } else if (record.task.auth_mode !== "none" && auth.success) {
        addLog(`登录保活任务 #${id} 已检测到登录状态，跳过重复登录`);
      }
    }
  } catch (error) {
    if (!record.stopRequested) {
      const reason = safeMessage(error.message);
      updateKeepaliveTaskStatus(id, "error", `刷新失败：${reason}`, new Date().toISOString());
      addLog(`登录保活任务 #${id} 刷新失败：${reason}`, "error");
    }
  } finally {
    record.refreshing = false;
    scheduleRefresh(id, record);
  }
}

async function startKeepaliveTask(id) {
  const taskId = Number(id);
  if (activeTasks.has(taskId)) return activeTasks.get(taskId).task;
  if (startingTasks.has(taskId)) return startingTasks.get(taskId);

  const starting = (async () => {
    const task = getKeepaliveTaskForExecution(taskId);
    if (!task) throw new Error("登录保活任务不存在");

    updateKeepaliveTaskStatus(taskId, "starting", "正在打开保活页面");
    let page = null;
    let record = null;

    try {
      page = await createKeepalivePage(taskId);
      record = {
        task,
        page,
        timer: null,
        refreshing: false,
        stopRequested: false,
        needsAttention: false,
        stateSaved: false,
        stateBackupAttempted: false
      };
      activeTasks.set(taskId, record);

      await page.goto(task.url, { waitUntil: "domcontentloaded", timeout: 60000 });
      if (record.stopRequested || activeTasks.get(taskId) !== record) {
        throw new Error("任务已停止");
      }

      const auth = await loginIfRequired(task, page);
      const now = new Date().toISOString();

      if (!auth.success) {
        record.needsAttention = true;
        updateKeepaliveTaskStatus(taskId, "needs_attention", auth.message, now);
        addLog(`登录保活任务 #${taskId} 需要处理：${auth.message}`, "error");
      } else {
        const backedUp = await saveLoginState(record, auth.attempted);
        const message = task.auth_mode !== "none" && !backedUp
          ? `${auth.message}；云端登录态备份失败，请检查 rclone 配置`
          : auth.message;
        updateKeepaliveTaskStatus(taskId, "running", message, now);
        addLog(`登录保活任务 #${taskId} 已启动`);
      }

      scheduleRefresh(taskId, record);
      return task;
    } catch (error) {
      if (record) {
        activeTasks.delete(taskId);
        if (record.timer) clearTimeout(record.timer);
      }
      try { await closeKeepaliveContext(taskId, false); } catch {}
      if (page) {
        try { if (!page.isClosed()) await page.close(); } catch {}
      }
      const reason = safeMessage(error.message);
      if (!record || !record.stopRequested) {
        updateKeepaliveTaskStatus(taskId, "error", `启动失败：${reason}`, new Date().toISOString());
        addLog(`登录保活任务 #${taskId} 启动失败：${reason}`, "error");
      }
      throw new Error(reason);
    }
  })();

  startingTasks.set(taskId, starting);
  try {
    return await starting;
  } finally {
    startingTasks.delete(taskId);
  }
}

async function stopKeepaliveTask(id) {
  const taskId = Number(id);
  let record = activeTasks.get(taskId);
  if (!record) {
    const pending = startingTasks.get(taskId);
    if (pending) {
      try { await pending; } catch {}
      record = activeTasks.get(taskId);
    }
  }
  if (!record) {
    updateKeepaliveTaskStatus(taskId, "stopped", "已停止");
    return false;
  }

  record.stopRequested = true;
  if (record.timer) clearTimeout(record.timer);
  activeTasks.delete(taskId);
  try { await closeKeepaliveContext(taskId, record.task.auth_mode !== "none" && !record.needsAttention); } catch {}
  try { if (!record.page.isClosed()) await record.page.close(); } catch {}
  updateKeepaliveTaskStatus(taskId, "stopped", "已停止");
  addLog(`登录保活任务 #${taskId} 已停止`);
  return true;
}

async function stopAllKeepaliveTasks() {
  const pending = [...startingTasks.values()];
  if (pending.length) await Promise.all(pending.map(task => task.catch(() => null)));
  const ids = [...activeTasks.keys()];
  await Promise.all(ids.map(id => stopKeepaliveTask(id)));
}

module.exports = {
  startKeepaliveTask,
  stopKeepaliveTask,
  stopAllKeepaliveTasks
};
