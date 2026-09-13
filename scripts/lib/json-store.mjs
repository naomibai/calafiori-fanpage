// 数据采集脚本的共享工具：安全读写 JSON、日志、错误类型
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

export class UserError extends Error {}

export function info(msg) {
    console.log(msg);
}

export function warn(msg) {
    console.warn('⚠ ' + msg);
}

// 读取 JSON 文件，不存在或解析失败时返回 fallback
export function readJsonOr(path, fallback) {
    if (!existsSync(path)) return fallback;
    try {
        return JSON.parse(readFileSync(path, 'utf8'));
    } catch (error) {
        warn(`读取 ${path} 失败（${error.message}），使用默认值`);
        return fallback;
    }
}

// 内容有变化才写入，返回是否写入了
export function writeJsonIfChanged(path, value) {
    const next = JSON.stringify(value, null, 2) + '\n';
    if (existsSync(path) && readFileSync(path, 'utf8') === next) {
        info(`${path} 无变化，跳过写入`);
        return false;
    }
    writeFileSync(path, next, 'utf8');
    info(`${path} 已更新`);
    return true;
}
