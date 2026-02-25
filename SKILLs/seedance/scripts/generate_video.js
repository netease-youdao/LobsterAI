#!/usr/bin/env node

/**
 * Seedance 视频生成脚本
 * 支持文本生成视频（T2V）、图片生成视频（I2V）、音画同步视频生成
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// ==================== 配置 ====================

const API_KEY = process.env.ARK_API_KEY;
const BASE_URL = 'https://ark.cn-beijing.volces.com/api/v3';

// 默认参数
const DEFAULT_MODEL = 'doubao-seedance-1-5-pro-251215';
const DEFAULT_DURATION = 5;
const DEFAULT_RATIO = 'adaptive';
const DEFAULT_POLL_INTERVAL = 5;
const DEFAULT_TIMEOUT = 300;

// ==================== 工具函数 ====================

function printError(message) {
  console.error(`错误: ${message}`);
}

function printInfo(message, noNewline = false) {
  if (noNewline) {
    process.stderr.write(message);
  } else {
    console.error(message);
  }
}

function validateConfig() {
  if (!API_KEY) {
    printError('未设置环境变量 ARK_API_KEY');
    printInfo('');
    printInfo('请通过环境变量配置 API Key：');
    printInfo('');
    printInfo('macOS/Linux:');
    printInfo('  export ARK_API_KEY="你的API密钥"');
    printInfo('  # 或添加到 ~/.zshrc 或 ~/.bashrc 以永久生效');
    printInfo('  echo \'export ARK_API_KEY="你的API密钥"\' >> ~/.zshrc');
    printInfo('  source ~/.zshrc');
    printInfo('');
    printInfo('Windows PowerShell:');
    printInfo('  $env:ARK_API_KEY="你的API密钥"');
    printInfo('  # 或设置系统环境变量以永久生效');
    printInfo('');
    printInfo('获取 API Key：');
    printInfo('  访问 https://console.volcengine.com/ark/region:ark+cn-beijing/apikey');
    return false;
  }
  return true;
}

function validateDuration(duration, model) {
  if (model.includes('1-5-pro')) {
    if (duration < 4 || duration > 12) {
      printError(`模型 ${model} 的 duration 必须在 4-12 秒之间`);
      return false;
    }
  } else {
    if (duration < 2 || duration > 12) {
      printError(`模型 ${model} 的 duration 必须在 2-12 秒之间`);
      return false;
    }
  }
  return true;
}

// ==================== API 调用函数 ====================

function getMimeType(ext) {
  const extToMime = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.bmp': 'image/bmp',
    '.tiff': 'image/tiff',
    '.tif': 'image/tiff',
    '.heic': 'image/heic'
  };
  return extToMime[ext.toLowerCase()] || 'image/jpeg';
}

async function processImagePath(imagePath) {
  // 如果是HTTP/HTTPS URL，直接返回
  if (imagePath.startsWith('http://') || imagePath.startsWith('https://')) {
    return imagePath;
  }

  // 如果已经是data URL，直接返回
  if (imagePath.startsWith('data:')) {
    return imagePath;
  }

  // 处理file://协议
  let filePath = imagePath;
  if (filePath.startsWith('file://')) {
    filePath = filePath.substring(7);
  }

  // 否则当作本地文件处理
  const absPath = path.resolve(filePath);

  // 检查文件是否存在
  if (!fs.existsSync(absPath)) {
    throw new Error(`图片文件不存在: ${absPath}`);
  }

  const stat = fs.statSync(absPath);
  if (!stat.isFile()) {
    throw new Error(`路径不是文件: ${absPath}`);
  }

  // 检查文件扩展名
  const ext = path.extname(absPath);
  const mimeType = getMimeType(ext);

  // 读取文件并转换为Base64
  const imageData = fs.readFileSync(absPath);
  const base64Data = imageData.toString('base64');

  return `data:${mimeType};base64,${base64Data}`;
}

async function makeRequest(method, urlStr, headers, body = null) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlStr);
    const isHttps = urlObj.protocol === 'https:';
    const client = isHttps ? https : http;

    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: method,
      headers: {
        'User-Agent': 'SeedanceVideoGenerator/1.0',
        ...headers
      },
      timeout: 30000
    };

    const req = client.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve({
            status: res.statusCode,
            data: result,
            headers: res.headers
          });
        } catch (e) {
          resolve({
            status: res.statusCode,
            data: data,
            headers: res.headers
          });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('请求超时'));
    });

    if (body) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

async function downloadFile(urlStr, outputPath) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlStr);
    const isHttps = urlObj.protocol === 'https:';
    const client = isHttps ? https : http;

    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': 'SeedanceVideoGenerator/1.0'
      },
      timeout: 120000
    };

    const req = client.request(options, (res) => {
      if (res.statusCode !== 200) {
        reject(new Error(`下载失败 (HTTP ${res.statusCode})`));
        return;
      }

      const totalSize = parseInt(res.headers['content-length'] || '0', 10);
      let downloaded = 0;

      const dir = path.dirname(outputPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const file = fs.createWriteStream(outputPath);

      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (totalSize > 0) {
          const percent = Math.floor((downloaded * 100) / totalSize);
          const mbDownloaded = (downloaded / (1024 * 1024)).toFixed(1);
          const mbTotal = (totalSize / (1024 * 1024)).toFixed(1);
          printInfo(`\r下载进度: ${percent}% (${mbDownloaded}/${mbTotal} MB)`, true);
        }
      });

      res.pipe(file);

      file.on('finish', () => {
        file.close();
        printInfo('');
        resolve();
      });

      file.on('error', (err) => {
        fs.unlink(outputPath, () => {});
        reject(err);
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('下载超时'));
    });

    req.end();
  });
}

async function createVideoTask(prompt, imagePaths = null, options = {}) {
  const {
    model = DEFAULT_MODEL,
    duration = DEFAULT_DURATION,
    ratio = DEFAULT_RATIO,
    generateAudio = false,
    watermark = true
  } = options;

  // 构建content数组
  const content = [{ type: 'text', text: prompt }];

  // 添加图片
  if (imagePaths && imagePaths.length > 0) {
    for (const imgPath of imagePaths) {
      try {
        const processedUrl = await processImagePath(imgPath);
        content.push({
          type: 'image_url',
          image_url: { url: processedUrl }
        });
      } catch (e) {
        throw new Error(`图片处理失败: ${e.message}`);
      }
    }
  }

  // 构建请求payload
  const payload = {
    model,
    content,
    duration,
    ratio,
    generate_audio: generateAudio,
    watermark
  };

  printInfo('正在提交任务...');
  printInfo(`  模型: ${model}`);
  printInfo(`  时长: ${duration}秒`);
  printInfo(`  ���高比: ${ratio}`);
  if (imagePaths && imagePaths.length > 0) {
    printInfo(`  参考图片: ${imagePaths.length}张`);
    imagePaths.forEach((img, i) => {
      if (img.startsWith('file://')) {
        printInfo(`    [${i + 1}] 本地文件: ${img.substring(7)}`);
      } else {
        printInfo(`    [${i + 1}] ${img}`);
      }
    });
  }
  if (generateAudio) {
    printInfo('  音频: 启用');
  }

  try {
    const response = await makeRequest(
      'POST',
      `${BASE_URL}/contents/generations/tasks`,
      {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${API_KEY}`
      },
      payload
    );

    if (response.status !== 200) {
      let errorMsg = `HTTP ${response.status}`;
      if (typeof response.data === 'object' && response.data.error) {
        const errorDetail = response.data.error;
        errorMsg = typeof errorDetail === 'object'
          ? errorDetail.message || errorMsg
          : String(errorDetail);
      }

      if (response.status === 401) {
        throw new Error('认证失败：API Key 无效或已过期\n请检查 ARK_API_KEY 配置');
      } else if (response.status === 403) {
        throw new Error('权限不足：请确认 API Key 有视频生成权限');
      } else if (response.status === 429) {
        throw new Error('请求过于频繁：已超过限流配额\n请等待1分钟后重试');
      } else if (response.status === 400) {
        throw new Error(`参数错误：${errorMsg}\n请检查提示词和参数设置`);
      } else {
        throw new Error(`任务创建失败：${errorMsg}`);
      }
    }

    const taskId = response.data.id;
    if (!taskId) {
      throw new Error('API 返回格式错误：缺少任务ID');
    }

    return taskId;
  } catch (e) {
    if (e.message.includes('任务创建失败') || e.message.includes('认证失败')) {
      throw e;
    }
    throw new Error(`任务创建失败：${e.message}`);
  }
}

async function pollTaskStatus(taskId, pollInterval = DEFAULT_POLL_INTERVAL, timeout = DEFAULT_TIMEOUT) {
  const startTime = Date.now();
  let retryCount = 0;
  const maxRetries = 3;

  printInfo('');
  printInfo('等待视频生成完成...');
  printInfo(`任务ID: ${taskId}`);
  printInfo('(通常需要 30-120 秒，请耐心等待)');

  while (true) {
    const elapsed = Math.floor((Date.now() - startTime) / 1000);

    // 检查超时
    if (elapsed > timeout) {
      throw new Error(
        `任务超时（${timeout}秒）\n任务ID: ${taskId}\n你可以稍后通过控制台查看任务结果`
      );
    }

    try {
      const response = await makeRequest(
        'GET',
        `${BASE_URL}/contents/generations/tasks/${taskId}`,
        {
          'Authorization': `Bearer ${API_KEY}`
        }
      );

      if (response.status !== 200) {
        retryCount++;
        if (retryCount >= maxRetries) {
          throw new Error(`状态查询失败 (HTTP ${response.status})`);
        }
        printInfo(`[${elapsed}s] 查询失败，重试中...`);
        await new Promise(r => setTimeout(r, 2000));
        continue;
      }

      retryCount = 0;
      const result = response.data;
      const status = result.status;

      const statusZh = {
        'queued': '排队中',
        'running': '生成中',
        'succeeded': '完成',
        'failed': '失败'
      }[status] || status;

      printInfo(`\r[${elapsed}s] 状态: ${statusZh}...`, true);

      if (status === 'succeeded') {
        printInfo('');
        return result;
      } else if (status === 'failed') {
        let errorMsg = '未知错误';
        if (result.error) {
          const errorDetail = result.error;
          errorMsg = typeof errorDetail === 'object'
            ? errorDetail.message || errorMsg
            : String(errorDetail);
        }
        throw new Error(`任务失败：${errorMsg}`);
      }

      await new Promise(r => setTimeout(r, pollInterval * 1000));
    } catch (e) {
      if (e.message.includes('任务失败')) {
        throw e;
      }
      if (retryCount >= maxRetries) {
        throw e;
      }
      retryCount++;
      printInfo(`[${elapsed}s] 错误: ${e.message}，重试中...`);
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

// ==================== 主函数 ====================

async function main() {
  const args = process.argv.slice(2);
  const options = {
    prompt: null,
    image: [],
    model: DEFAULT_MODEL,
    duration: DEFAULT_DURATION,
    ratio: DEFAULT_RATIO,
    audio: false,
    'no-watermark': false,
    output: 'generated_video.mp4',
    'poll-interval': DEFAULT_POLL_INTERVAL,
    timeout: DEFAULT_TIMEOUT
  };

  // 解析命令行参数
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.substring(2);
      if (key === 'audio' || key === 'no-watermark') {
        options[key] = true;
      } else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        const value = args[++i];
        if (key === 'image') {
          options.image.push(value);
        } else if (key === 'duration' || key === 'poll-interval' || key === 'timeout') {
          options[key] = parseInt(value, 10);
        } else {
          options[key] = value;
        }
      }
    }
  }

  // 验证必需参数
  if (!options.prompt) {
    printError('缺少必需参数: --prompt');
    process.exit(1);
  }

  // 验证配置
  if (!validateConfig()) {
    process.exit(1);
  }

  // 验证参数
  if (!validateDuration(options.duration, options.model)) {
    process.exit(1);
  }

  if (options['poll-interval'] < 1 || options['poll-interval'] > 10) {
    printError('poll-interval 必须在 1-10 秒之间');
    process.exit(1);
  }

  if (options.timeout < 60 || options.timeout > 600) {
    printError('timeout 必须在 60-600 秒之间');
    process.exit(1);
  }

  // 执行生成流程
  try {
    printInfo('='.repeat(50));
    printInfo('Seedance 视频生成');
    printInfo('='.repeat(50));

    // Step 1: 创建任务
    const taskId = await createVideoTask(options.prompt, options.image.length > 0 ? options.image : null, {
      model: options.model,
      duration: options.duration,
      ratio: options.ratio,
      generateAudio: options.audio,
      watermark: !options['no-watermark']
    });

    printInfo(`任务已创建: ${taskId}`);

    // Step 2: 轮询状态
    const result = await pollTaskStatus(taskId, options['poll-interval'], options.timeout);

    // Step 3: 下载视频
    const videoUrl = result.content?.video_url;
    if (!videoUrl) {
      throw new Error('API 返回格式错误：缺少 video_url');
    }

    printInfo('');
    printInfo('正在下载视频...');
    await downloadFile(videoUrl, options.output);

    // 输出成功信息到 stdout（供 Claude 读取）
    printInfo('');
    printInfo('='.repeat(50));
    printInfo('生成成功！');
    printInfo('='.repeat(50));

    console.log('视频生成成功！');
    console.log(`任务ID: ${taskId}`);
    console.log(`文件路径: ${path.resolve(options.output)}`);
    console.log(`分辨率: ${result.resolution || 'N/A'}`);
    console.log(`宽高比: ${result.ratio || 'N/A'}`);
    console.log(`时长: ${result.duration || 'N/A'}秒`);
    console.log(`帧率: ${result.framespersecond || 'N/A'} fps`);

    if (result.content?.has_audio) {
      console.log('音频: 已包含');
    }
  } catch (e) {
    printInfo('');
    printInfo('='.repeat(50));
    printError(e.message);
    printInfo('='.repeat(50));
    process.exit(1);
  }
}

// 捕获未处理的 Promise 拒绝
process.on('unhandledRejection', (err) => {
  printError(`未处理的错误: ${err.message}`);
  process.exit(1);
});

main();
