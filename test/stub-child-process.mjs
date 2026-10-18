/**
 * ESM loader stub：把 `node:child_process` 换成记录型假实现。
 *
 * 用途：`test/fail-route.test.mjs` 要断言 **lib/index.js 运行时到底给 ps1 传了什么参数**
 * （例如 error 回合是否真的传 `-Kind fail`）。若真去 spawn PowerShell：
 * ① 会弹 Toast / 出声，污染用户桌面；② 需要真实 SystemRoot，与同目录其他测试的
 * 隔离手法冲突（见踩坑 #424）。故在加载 lib 之前把这个模块注册为 loader，
 * 让 `spawn()` 只把参数记进 `globalThis.__SPAWN_CALLS`，不起任何进程。
 *
 * 为什么不用 monkey-patch：lib 用的是 ESM 具名导入
 * （`import { spawn } from 'node:child_process'`），导入绑定只读、不可重新赋值；
 * 只有 loader 层能在模块解析阶段替换它。
 *
 * 该文件**不是测试文件**（不以 .test. 命名），不会被 `node --test` 当用例执行。
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'node:child_process') {
    return { url: 'stub:child_process', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url === 'stub:child_process') {
    const source = `
      // 记录每一次 spawn 的 (file, args) 供断言；返回一个不会真的启动进程的假句柄。
      export function spawn(file, args, options) {
        globalThis.__SPAWN_CALLS = globalThis.__SPAWN_CALLS || [];
        globalThis.__SPAWN_CALLS.push({ file, args: Array.isArray(args) ? args.slice() : args, options });
        return {
          pid: 424242,
          once() { return this; },
          on() { return this; },
          kill() { return true; },
          unref() { return this; },
        };
      }
      export default { spawn };
    `;
    return { format: 'module', shortCircuit: true, source };
  }
  return nextLoad(url, context);
}
