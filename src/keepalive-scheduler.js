const { getKeepaliveTasks } = require("./database");
const { startKeepaliveTask } = require("./keepalive-executor");

let started = false;

async function startKeepaliveScheduler() {
  if (started) return;
  started = true;

  const tasks = getKeepaliveTasks().filter(task => Number(task.enabled) === 1);
  console.log(`[KeepaliveScheduler] 正在恢复 ${tasks.length} 个已启用的登录保活任务`);

  for (const task of tasks) {
    let startedTask = false;
    let lastError = null;
    // 启动阶段可能遇到 Xvfb / Chromium 资源短暂竞争，最多重试 2 次。
    // 逐个启动任务，避免并发争用显示服务；失败后短暂等待再重试。
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await startKeepaliveTask(task.id);
        startedTask = true;
        break;
      } catch (error) {
        lastError = error;
        console.error(`[KeepaliveScheduler] 任务 #${task.id} 第 ${attempt}/3 次启动失败：${String(error.message || "未知错误").slice(0, 200)}`);
        if (attempt < 3) {
          await new Promise(resolve => setTimeout(resolve, 1500 * attempt));
        }
      }
    }
    if (!startedTask) {
      console.error(`[KeepaliveScheduler] 任务 #${task.id} 重试后仍未启动：${String(lastError && lastError.message || "未知错误").slice(0, 200)}`);
    }
  }

  console.log("[KeepaliveScheduler] 登录保活调度已启动");
}

async function stopKeepaliveScheduler() {
  started = false;
  const { stopAllKeepaliveTasks } = require("./keepalive-executor");
  await stopAllKeepaliveTasks();
  console.log("[KeepaliveScheduler] 登录保活调度已停止");
}

module.exports = { startKeepaliveScheduler, stopKeepaliveScheduler };
