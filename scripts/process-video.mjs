// 视频处理流水线：
// mp4 → ffmpeg 提取音轨 → Cloudflare Worker (Whisper) 转写 → DeepSeek 生成英文标题 + 中文采访稿
// → 更新 assets/video/videos.json → 重写 index.html 标记区间
//
// 用法：
//   npm run video -- assets/video/interviews/interview-3.mp4   （完整处理一条视频）
//   npm run video -- --regenerate                              （仅从 videos.json 重建 index.html）
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';
import ffmpegPath from 'ffmpeg-static';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VIDEOS_JSON = path.join(ROOT, 'assets', 'video', 'videos.json');
const INDEX_HTML = path.join(ROOT, 'index.html');
const INTERVIEWS_DIR = path.join(ROOT, 'assets', 'video', 'interviews');
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

const LABEL_COLORS = { red: 'text-red-600', blue: 'text-blue-600', gray: 'text-gray-500', dark: 'text-gray-800' };
const MARKERS = {
    cards: ['<!-- VIDEO-CARDS:START -->', '<!-- VIDEO-CARDS:END -->'],
    data: ['<!-- VIDEO-DATA:START -->', '<!-- VIDEO-DATA:END -->']
};

let tmpDir = null;

class UserError extends Error {}

function info(msg) {
    console.log(msg);
}

function cleanup() {
    if (tmpDir) {
        try { rmSync(tmpDir, { recursive: true, force: true }); } catch {}
        tmpDir = null;
    }
}

function fmtMB(bytes) {
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

// ---------- videos.json ----------

function readVideosJson() {
    if (!existsSync(VIDEOS_JSON)) {
        throw new UserError(`找不到 ${VIDEOS_JSON}`);
    }
    try {
        const data = JSON.parse(readFileSync(VIDEOS_JSON, 'utf8'));
        if (!Array.isArray(data.videos)) throw new Error('缺少 videos 数组');
        return data.videos;
    } catch (error) {
        throw new UserError(`videos.json 格式错误: ${error.message}`);
    }
}

function writeVideosJson(videos) {
    writeFileSync(VIDEOS_JSON, JSON.stringify({ version: 1, videos }, null, 2) + '\n', 'utf8');
}

// ---------- index.html 重写 ----------

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// 标签优先从文件名推导：去掉 .mp4 和末尾的 " interview-N"，剩余部分即标签
// 例："Arsenal interview-1.mp4" → Arsenal；"Arsenal interview 3.mp4" → Arsenal；"Azzurri.mp4" → Azzurri
function deriveLabel(video) {
    const base = video.key.replace(/\.mp4$/i, '').replace(/\s+interview[- ]?\d+$/i, '').trim();
    return base || video.label;
}

function buildCardsHtml(videos) {
    return videos.map((video, index) => {
        const colorClass = LABEL_COLORS[video.labelColor] || LABEL_COLORS.gray;
        const posterAttr = video.poster ? ` poster="${escapeHtml(video.poster)}"` : '';
        const label = deriveLabel(video);
        return `<!-- Video Item ${index + 1} -->
<div class="min-w-[280px] w-[280px] md:min-w-[340px] md:w-[340px] snap-center cursor-pointer group/video flex-shrink-0" onclick="openVideoModal('${escapeHtml(video.key)}')">
    <div class="relative overflow-hidden mb-4 rounded-sm shadow-sm">
        <video src="assets/video/interviews/${escapeHtml(video.key)}"${posterAttr} muted playsinline preload="metadata" aria-label="${escapeHtml(video.title)}" class="w-full h-48 md:h-56 object-cover transform group-hover/video:scale-105 transition duration-700"></video>
        <div class="absolute inset-0 bg-black/10 flex items-center justify-center group-hover/video:bg-black/30 transition duration-300">
            <i class="fas fa-play text-white text-3xl opacity-90 drop-shadow-lg"></i>
        </div>
    </div>
    <p class="text-[10px] font-bold tracking-[0.15em] uppercase ${colorClass} mb-2">${escapeHtml(label)}</p>
    <h4 class="font-serif text-lg leading-snug group-hover/video:text-gray-500 transition duration-300">${escapeHtml(video.title)}</h4>
</div>`;
    }).join('\n\n');
}

function buildDataScript(videos) {
    const data = {};
    for (const video of videos) data[video.key] = video;
    // 防止文稿中的 </script> 破坏页面；2028/2029 是 JSON 合法字符但旧 JS 解析器可能出错
    const json = JSON.stringify(data, null, 2)
        .replace(/</g, '\\u003c')
        .replace(/2028/g, '\\u2028')
        .replace(/2029/g, '\\u2029');
    JSON.parse(json); // 自检：确保写进页面的一定是可解析的 JSON
    return `<script>\nwindow.VIDEO_DATA = ${json};\n</script>`;
}

function replaceMarkedRegion(html, [startMarker, endMarker], newContent) {
    const start = html.indexOf(startMarker);
    if (start === -1 || html.indexOf(startMarker, start + startMarker.length) !== -1) {
        throw new UserError(`index.html 中的标记缺失或重复: ${startMarker}`);
    }
    const end = html.indexOf(endMarker, start);
    if (end === -1 || html.indexOf(endMarker, end + endMarker.length) !== -1) {
        throw new UserError(`index.html 中的标记缺失或重复: ${endMarker}`);
    }
    if (end < start) throw new UserError(`index.html 中 ${startMarker} 与 ${endMarker} 顺序颠倒`);
    return html.slice(0, start + startMarker.length) + '\n' + newContent + html.slice(end);
}

function regenerateIndexHtml(videos) {
    let html = readFileSync(INDEX_HTML, 'utf8');
    html = replaceMarkedRegion(html, MARKERS.cards, buildCardsHtml(videos));
    html = replaceMarkedRegion(html, MARKERS.data, buildDataScript(videos));
    writeFileSync(INDEX_HTML, html, 'utf8');
}

// ---------- DeepSeek ----------

const DEEPSEEK_SYSTEM_PROMPT = `你是卡拉菲奥里（Riccardo Calafiori）粉丝网站的编辑助理。我会给你一段采访录音的转写文本（可能是意大利语或英语，请自动识别语言），你需要输出一个严格的 JSON 对象（不要输出任何其他文字，确保可以被 JSON.parse 直接解析），包含以下三个字段：

1. "title"：英文杂志风标题，全大写，戏剧化、有冲击力，符合 Vogue 风格。示例风格："FIRST WORDS AS A GUNNER"、"THE ART OF DEFENDING"、"FAREWELL TO BOLOGNA: AN EMOTIONAL GOODBYE"。长度控制在 6 到 12 个英文单词，不要加引号或句号。标题必须准确概括这段视频的核心内容，不要泛泛而谈。
2. "translation"：整理并翻译成自然流畅的中文采访稿。注意：语音转写往往没有标点、不区分说话人，且充满口误、重复和闲聊碎句。你的任务是把转写整理成一篇通顺可读的访谈记录，而不是逐字直译。要求：
   - 说话人标注：转写文本完全没有说话人信息，你必须根据内容判断每一段话是谁说的，并在每一段前面标注说话人（如「主持人：」「加布里埃尔：」「里卡多：」）。判断依据：主持人是节目的组织者（介绍规则、引导流程、提问）；加布里埃尔是巴西球员（科林蒂安球迷，谈论巴西、弗拉门戈、科林蒂安）；里卡多·卡拉菲奥里是意大利球员（罗马球迷，谈论意大利、罗马、巴塞尔）。一问一答的对话必须按说话人拆开，不要连成一段。确实无法判断时合并为一段。
   - 合并同一说话人的零散短句，删除无意义的重复和语气填充（例如连续说两次"下雨了"合并为一次），修复明显的转写错误（如明显的人名、球队名听写错误），但不要改变原意。
   - 保持对话的幽默感和语气，玩笑要译得自然、中文读者能看懂，不要翻译得生硬刻板。
   - 不同段落之间用空行分隔。
3. "originalTranscript"：清理后的原始转写文本（修复明显错词、去除重复语气词，保留原语言，意大利语或英语均可），可以为空字符串。

如果转写文本质量很差或明显是同一句话的重复，请在 translation 中如实地给出可读的整理版本，而不是照抄错误。`;

function parseDeepSeekJson(content) {
    try { return JSON.parse(content); } catch {}
    const fenced = content.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced) {
        try { return JSON.parse(fenced[1]); } catch {}
    }
    const start = content.indexOf('{');
    const end = content.lastIndexOf('}');
    if (start !== -1 && end > start) {
        try { return JSON.parse(content.slice(start, end + 1)); } catch {}
    }
    throw new Error('无法解析 DeepSeek 返回的 JSON');
}

async function callDeepSeek(apiKey, transcript, extraUserNote = '') {
    const resp = await fetch(DEEPSEEK_URL, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            model: 'deepseek-chat',
            temperature: 0.3,
            max_tokens: 8192,
            response_format: { type: 'json_object' },
            messages: [
                { role: 'system', content: DEEPSEEK_SYSTEM_PROMPT },
                { role: 'user', content: '以下是采访转写文本：\n\n' + transcript + extraUserNote }
            ]
        }),
        signal: AbortSignal.timeout(120_000)
    });
    if (!resp.ok) {
        throw new Error(`DeepSeek HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
    }
    const payload = await resp.json();
    if (!payload.choices || !payload.choices[0] || !payload.choices[0].message) {
        throw new Error('DeepSeek 响应缺少 choices');
    }
    return {
        content: payload.choices[0].message.content,
        finishReason: payload.choices[0].finish_reason
    };
}

// 请求 DeepSeek 并解析 JSON，带一次纠正重试
async function requestAndParse(apiKey, transcript, extraUserNote = '') {
    let result;
    try {
        result = await callDeepSeek(apiKey, transcript, extraUserNote);
    } catch (firstError) {
        info('  DeepSeek 请求失败，重试中…');
        await new Promise(resolve => setTimeout(resolve, 3000));
        result = await callDeepSeek(apiKey, transcript, extraUserNote);
    }

    try {
        return { parsed: parseDeepSeekJson(result.content), finishReason: result.finishReason };
    } catch (firstParseError) {
        info('  DeepSeek 返回格式异常，带纠正指令重试一次…');
        const retry = await callDeepSeek(apiKey, transcript, extraUserNote + '\n\n（上次输出无法解析，这次请只输出一个 JSON 对象，不要使用代码块）');
        try {
            return { parsed: parseDeepSeekJson(retry.content), finishReason: retry.finishReason };
        } catch (secondParseError) {
            const dumpPath = path.join(tmpDir, 'deepseek-raw.txt');
            writeFileSync(dumpPath, retry.content, 'utf8');
            throw new UserError(
                `DeepSeek 连续两次返回无法解析的内容，原始输出已保存到 ${dumpPath}。\n` +
                '可以手动修改 videos.json 后运行 npm run video -- --regenerate 重建页面。'
            );
        }
    }
}

function normalizeGenerated(parsed, finishReason) {
    const title = String(parsed.title || '')
        .trim()
        .replace(/^['"]+|['"]+$/g, '')
        .replace(/\s+/g, ' ')
        .toUpperCase()
        .slice(0, 60);
    const translation = String(parsed.translation || '').trim().replace(/\r\n/g, '\n');
    const originalTranscript = String(parsed.originalTranscript || '').trim().replace(/\r\n/g, '\n');

    if (!title) throw new UserError('DeepSeek 未生成标题');
    if (!translation && !originalTranscript) throw new UserError('DeepSeek 未生成文稿');
    if (!translation) info('  ⚠ 警告: 中文翻译为空，暂用原文代替');

    return { title, translation: translation || originalTranscript, originalTranscript, finishReason };
}

// 按句子边界把长文稿切成约 4500 字符的片段
const LONG_TRANSCRIPT_THRESHOLD = 6000;
const CHUNK_TARGET = 4500;

function splitTranscript(text) {
    const sentences = text.match(/[^.!?。！？…\n]+[.!?。！？…]*[\n\s]*/g) || [text];
    const chunks = [];
    let current = '';
    for (const sentence of sentences) {
        if (current && current.length + sentence.length > CHUNK_TARGET) {
            chunks.push(current);
            current = '';
        }
        current += sentence;
    }
    if (current.trim()) chunks.push(current);
    return chunks;
}

async function generateContent(apiKey, transcript) {
    const chunks = transcript.length > LONG_TRANSCRIPT_THRESHOLD ? splitTranscript(transcript) : [transcript];

    if (chunks.length === 1) {
        const { parsed, finishReason } = await requestAndParse(apiKey, transcript);
        return normalizeGenerated(parsed, finishReason);
    }

    // 长文稿分段翻译，避免超出 DeepSeek 单次输出上限
    info(`  文稿较长（${transcript.length} 字符），分 ${chunks.length} 段翻译…`);
    const translations = [];
    let title = '';
    let finishReason = null;
    for (let i = 0; i < chunks.length; i++) {
        const note = i === 0
            ? `\n\n（这是采访转写的第 1/${chunks.length} 部分，请翻译本部分内容，并在 "title" 中给出整篇的标题。）`
            : `\n\n（这是采访转写的第 ${i + 1}/${chunks.length} 部分，请翻译本部分内容，"title" 输出空字符串。）`;
        const { parsed, finishReason: fr } = await requestAndParse(apiKey, chunks[i], note);
        finishReason = fr;
        if (parsed.title && !title) title = parsed.title;
        if (parsed.translation) translations.push(parsed.translation);
        info(`  第 ${i + 1}/${chunks.length} 段完成`);
    }
    return normalizeGenerated({ title, translation: translations.join('\n\n'), originalTranscript: '' }, finishReason);
}

// ---------- 各处理步骤 ----------

async function transcribe(audioPath, token, workerUrl) {
    const audioBuffer = readFileSync(audioPath);
    const doRequest = () => fetch(`${workerUrl}/api/transcribe`, {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'audio/mpeg'
        },
        body: audioBuffer,
        signal: AbortSignal.timeout(300_000)
    });

    let resp;
    try {
        resp = await doRequest();
    } catch (firstError) {
        info('  网络请求失败，重试中…');
        await new Promise(resolve => setTimeout(resolve, 3000));
        try {
            resp = await doRequest();
        } catch (secondError) {
            throw new UserError('无法连接转写服务（可能网络问题或 workers.dev 被墙）。请检查 TRANSCRIBE_WORKER_URL 后重试。');
        }
    }

    const payload = await resp.json().catch(() => null);
    if (resp.status === 401) throw new UserError('Worker 拒绝了请求：TRANSCRIBE_TOKEN 不匹配');
    if (resp.status === 413) throw new UserError('音频超过 10 MB 上限');
    if (resp.status === 415) throw new UserError('Worker 拒绝了内容类型');
    if (resp.status === 422) throw new UserError('视频中没有检测到语音');
    if (!resp.ok) {
        throw new UserError(`转写失败: ${payload && payload.error ? payload.error + (payload.diagnostic ? ' - ' + payload.diagnostic : '') : 'HTTP ' + resp.status}`);
    }
    if (!payload || typeof payload.text !== 'string') throw new UserError('转写响应缺少 text 字段');
    if (payload.text.trim().length < 10) throw new UserError('转写文本过短（<10 字符），可能没有检测到语音');
    return { text: payload.text, durationMs: payload.durationMs || 0 };
}

function extractAudio(inputPath, key) {
    if (typeof ffmpegPath !== 'string' || !existsSync(ffmpegPath)) {
        throw new UserError('ffmpeg 未找到，请重新运行 npm install ffmpeg-static');
    }
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'calafiori-video-'));
    const outMp3 = path.join(tmpDir, key + '.mp3');
    try {
        execFileSync(ffmpegPath, ['-y', '-i', inputPath, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '32k', '-f', 'mp3', outMp3], {
            maxBuffer: 10 * 1024 * 1024,
            stdio: ['ignore', 'ignore', 'pipe']
        });
    } catch (error) {
        const stderrTail = error.stderr ? String(error.stderr).slice(-2000) : '';
        throw new UserError('音频提取失败:\n' + stderrTail.slice(-1500));
    }
    const audioBytes = statSync(outMp3).size;
    if (audioBytes > MAX_AUDIO_BYTES) throw new UserError(`提取出的音频过大（${fmtMB(audioBytes)}，上限 10 MB）`);
    return { outMp3, audioBytes };
}

function capturePoster(inputPath, key) {
    const posterPath = path.join(INTERVIEWS_DIR, key.replace(/\.mp4$/i, '') + '.jpg');
    try {
        execFileSync(ffmpegPath, ['-y', '-ss', '2', '-i', inputPath, '-frames:v', '1', '-q:v', '3', '-vf', 'scale=640:-2', posterPath], {
            maxBuffer: 10 * 1024 * 1024,
            stdio: ['ignore', 'ignore', 'pipe']
        });
        return 'assets/video/interviews/' + path.basename(posterPath);
    } catch (error) {
        info('  ⚠ 封面截取失败（不影响主体流程），继续使用原有封面');
        return null;
    }
}

// ---------- 主流程 ----------

async function processVideo(arg) {
    // [1/7] 参数校验
    if (!arg) {
        throw new UserError('用法: npm run video -- assets/video/interviews/interview-3.mp4');
    }
    const inputPath = path.resolve(arg);
    if (!existsSync(inputPath)) throw new UserError(`找不到文件: ${inputPath}`);
    if (path.extname(inputPath).toLowerCase() !== '.mp4') throw new UserError('仅支持 .mp4 文件');
    const key = path.basename(inputPath);
    info(`[1/7] 读取视频: ${inputPath}`);

    // [2/7] 配置
    const { DEEPSEEK_API_KEY, TRANSCRIBE_TOKEN, TRANSCRIBE_WORKER_URL } = process.env;
    const missing = [];
    if (!DEEPSEEK_API_KEY) missing.push('DEEPSEEK_API_KEY');
    if (!TRANSCRIBE_TOKEN) missing.push('TRANSCRIBE_TOKEN');
    if (!TRANSCRIBE_WORKER_URL) missing.push('TRANSCRIBE_WORKER_URL');
    if (missing.length) {
        throw new UserError(`请在 .env 中配置: ${missing.join(', ')}（参见 .env.example）`);
    }
    const workerUrl = TRANSCRIBE_WORKER_URL.replace(/\/+$/, '');
    info(`[2/7] 配置就绪 (Worker: ${workerUrl})`);

    // [3/7] 匹配 videos.json 槽位
    const videos = readVideosJson();
    const entry = videos.find(video => video.key === key);
    if (!entry) {
        throw new UserError(`videos.json 中没有键 "${key}"，请把文件名改为 ${videos.map(video => video.key).join(' ~ ')} 之一`);
    }
    info(`[3/7] 匹配到卡片槽位: ${entry.title || key}`);

    // [4/7] 提取音频
    info('[4/7] 提取音频 (ffmpeg)…');
    const { outMp3, audioBytes } = extractAudio(inputPath, key);
    info(`  音频 ${fmtMB(audioBytes)}`);

    // [5/7] 上传转写
    info('[5/7] 上传到 Cloudflare Worker 并等待 AI 转写 (约 1-2 分钟)…');
    const { text, durationMs } = await transcribe(outMp3, TRANSCRIBE_TOKEN, workerUrl);
    info(`  转写完成，${text.length} 字符 (Worker 耗时 ${(durationMs / 1000).toFixed(1)} 秒)`);

    // [6/7] 截取封面（非致命）
    info('[6/7] 截取视频封面…');
    const poster = capturePoster(inputPath, key);
    if (poster) info(`  封面已保存: ${poster}`);

    // [7/7] DeepSeek 生成标题与中文稿
    info('[7/7] DeepSeek 生成英文标题和中文采访稿…');
    const generated = await generateContent(DEEPSEEK_API_KEY, text);
    if (generated.finishReason === 'length') info('  ⚠ 警告: 翻译可能被截断，可在 videos.json 中手动补充');

    entry.title = generated.title;
    entry.transcript = generated.translation;
    if (generated.originalTranscript) {
        entry.originalTranscript = generated.originalTranscript;
    } else {
        entry.originalTranscript = text; // 长视频分段翻译时保留原始转写，供 --retranslate 使用
    }
    if (poster) entry.poster = poster;
    entry.meta = {
        processedAt: new Date().toISOString(),
        audioBytes,
        transcribeMs: durationMs
    };

    info('  更新 videos.json 和 index.html…');
    writeVideosJson(videos);
    regenerateIndexHtml(videos);

    console.log(`
✓ 完成！${key}
标题: ${generated.title}
中文稿: ${generated.translation.length} 字
下一步:
  1) 双击打开 index.html 本地预览
  2) git add . && git commit -m "update ${key}" && git push
     GitHub Pages 会自动发布。`);
}

async function regenerate() {
    const videos = readVideosJson();
    regenerateIndexHtml(videos);
    console.log(`✓ 已根据 videos.json 重建 index.html（共 ${videos.length} 张卡片）`);
}

// 用已保存的转写原文重新生成标题和中文稿（不重新转写）
async function retranslate(key) {
    const videos = readVideosJson();
    const entry = videos.find(video => video.key === key);
    if (!entry) {
        throw new UserError(`videos.json 中没有键 "${key}"`);
    }
    const { DEEPSEEK_API_KEY } = process.env;
    if (!DEEPSEEK_API_KEY) {
        throw new UserError('请在 .env 中配置: DEEPSEEK_API_KEY（参见 .env.example）');
    }
    const source = entry.originalTranscript || entry.transcript;
    if (!source || source.trim().length < 10) {
        throw new UserError('该视频没有可用的转写原文（originalTranscript 为空），请先运行完整处理流程');
    }

    info(`[重翻译] 使用已保存的转写原文（${source.length} 字符）重新生成标题和中文稿…`);
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'calafiori-video-'));
    const generated = await generateContent(DEEPSEEK_API_KEY, source);
    if (generated.finishReason === 'length') info('  ⚠ 警告: 翻译可能被截断，可在 videos.json 中手动补充');

    entry.title = generated.title;
    entry.transcript = generated.translation;
    if (generated.originalTranscript) entry.originalTranscript = generated.originalTranscript;

    writeVideosJson(videos);
    regenerateIndexHtml(videos);

    console.log(`
✓ 完成！${key}
标题: ${generated.title}
中文稿: ${generated.translation.length} 字
下一步:
  1) 双击打开 index.html 本地预览
  2) git add . && git commit -m "retranslate ${key}" && git push`);
}

async function main() {
    const arg = process.argv[2];
    try {
        if (arg === '--regenerate') {
            await regenerate();
            return;
        }
        if (arg === '--retranslate') {
            if (!process.argv[3]) {
                throw new UserError('用法: npm run video -- --retranslate interview-1.mp4');
            }
            await retranslate(path.basename(process.argv[3]));
            return;
        }
        await processVideo(arg);
    } catch (error) {
        if (error instanceof UserError) {
            console.error('✗ ' + error.message);
        } else {
            console.error('✗ 未预期的错误:', error);
        }
        process.exitCode = 1;
    } finally {
        cleanup();
    }
}

await main();
