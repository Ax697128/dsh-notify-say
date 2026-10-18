/**
 * 注册 `stub-child-process.mjs` loader，并置位 `globalThis.__STUB_CHILD_PROCESS__`
 *（供 `fail-route.test.mjs` 自检"stub 是否真的生效"）。
 *
 * 用法（只能用 --import，不能用 --loader，后者在新版 Node 已废弃）：
 *   node --import ./test/route-loader-register.mjs --test test/fail-route.test.mjs
 * 或直接 `npm run test:route`。
 *
 * ⚠️ 两点实测注意：
 * ① register() 必须在**测试文件加载之前**执行 —— --import 保证这一点。
 * ② 该文件与 stub 都**不是**测试文件（不以 .test. 命名），默认 `node --test` 不会执行它们。
 */
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

globalThis.__STUB_CHILD_PROCESS__ = true;
process.env.DSH_ROUTE_LOADER = '1';

const HERE = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(HERE, 'stub-child-process.mjs')));
