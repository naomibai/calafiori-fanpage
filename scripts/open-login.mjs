// 打开独立档案浏览器窗口，供用户登录 Instagram / X 后手动关闭
// 用法：node scripts/open-login.mjs（登录完成后直接关闭窗口即可，登录态自动保存）
import os from 'node:os';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';

const PROFILE_DIR = path.join(os.homedir(), '.calafiori-social-profile');
const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    executablePath: existsSync(EDGE_PATH) ? EDGE_PATH : undefined,
    headless: false,
    viewport: { width: 1280, height: 900 },
    locale: 'en-US',
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check'],
    ignoreDefaultArgs: ['--enable-automation']
});
await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
});

console.log('已打开登录窗口。请在窗口里登录 Instagram（和 X），完成后直接关闭窗口。');
console.log('（登录完成后也可以直接双击 fetch-social.bat 开始采集）');

// 一直等到用户关闭浏览器窗口
await new Promise(resolve => {
    context.on('close', resolve);
    setTimeout(resolve, 15 * 60 * 1000); // 最多等 15 分钟
});
console.log('窗口已关闭，登录态已保存。');
process.exit(0);
