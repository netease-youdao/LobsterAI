#!/usr/bin/env node

/**
 * Seedream 图片生成脚本
 * 支持文本生成图片（T2I）、图片编辑（I2I）、多图融合、组图生成
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
const DEFAULT_MODEL = 'doubao-seedream-4-5-251128';
const DEFAULT_SIZE = '2K';

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
    printInfo('='.repeat(70));
    printInfo('快速设置 API Key：');
    printInfo('='.repeat(70));
    printInfo('');
    printInfo('【macOS / Linux】');
    printInfo('  # 当前终端临时生效');
    printInfo('  export ARK_API_KEY="你的API密钥"');
    printInfo('');
    printInfo('  # 永久生效（推荐）');
    printInfo("  echo 'export ARK_API_KEY=\"你的API密钥\"' >> ~/.zshrc");
    printInfo('  source ~/.zshrc');
    printInfo('');
    printInfo('【Windows PowerShell】');
    printInfo('  # 当前会话临时生效');
    printInfo('  $env:ARK_API_KEY="你的API密钥"');
    printInfo('');
    printInfo('  # 永久生效（推荐）');
    printInfo("  [System.Environment]::SetEnvironmentVariable('ARK_API_KEY', '你的API密钥', 'User')");
    printInfo('');
    printInfo('【验证设置】');
    printInfo('  # macOS/Linux');
    printInfo('  echo $ARK_API_KEY');
    printInfo('');
    printInfo('  # Windows PowerShell');
    printInfo('  echo $env:ARK_API_KEY');
    printInfo('');
    printInfo('='.repeat(70));
    printInfo('获取 API Key：');
    printInfo('  https://console.volcengine.com/ark/region:ark+cn-beijing/apikey');
    printInfo('='.repeat(70));
    return false;
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
        'User-Agent': 'SeedreamImageGenerator/1.0',
        ...headers
      },
      timeout: 120000
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
        'User-Agent': 'SeedreamImageGenerator/1.0'
      },
      timeout: 60000
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
          printInfo(`\r  进度: ${percent}% (${mbDownloaded}/${mbTotal} MB)`, true);
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

async function generateImage(prompt, imagePaths = null, options = {}) {
  const {
    model = DEFAULT_MODEL,
    size = DEFAULT_SIZE,
    watermark = true,
    sequential = false,
    maxImages = 4,
    enableSearch = false
  } = options;

  // 构建请求payload
  const payload = {
    model,
    prompt,
    size,
    response_format: 'url',
    watermark
  };

  // 添加图片
  if (imagePaths && imagePaths.length > 0) {
    if (imagePaths.length === 1) {
      try {
        const processedUrl = await processImagePath(imagePaths[0]);
        payload.image = processedUrl;
      } catch (e) {
        throw new Error(`图片处理失败: ${e.message}`);
      }
    } else {
      try {
        const processedUrls = [];
        for (const img of imagePaths) {
          processedUrls.push(await processImagePath(img));
        }
        payload.image = processedUrls;
        payload.sequential_image_generation = 'disabled';
      } catch (e) {
        throw new Error(`图片处理失败: ${e.message}`);
      }
    }
  }

  // 组图生成
  if (sequential) {
    payload.sequential_image_generation = 'auto';
    payload.sequential_image_generation_options = { max_images: maxImages };
  }

  // 联网搜索
  if (enableSearch) {
    payload.enable_online_search = true;
    payload.model = 'doubao-seedream-5-0-260128';
  }

  printInfo('正在生成图片...');
  printInfo(`  模型: ${payload.model}`);
  printInfo(`  尺寸: ${size}`);
  if (imagePaths && imagePaths.length > 0) {
    printInfo(`  参考图片: ${imagePaths.length}张`);
    imagePaths.forEach((img, i) => {
      if (img.startsWith('file://')) {
        printInfo(`    [${i + 1}] 本地文件: ${img.substring(7)}`);
      } else if (!img.startsWith(('http://', 'https://', 'data:'))) {
        printInfo(`    [${i + 1}] 本地文件: ${img}`);
      } else {
        const displayUrl = img.length > 80 ? img.substring(0, 80) + '...' : img;
        printInfo(`    [${i + 1}] ${displayUrl}`);
      }
    });
  }
  if (sequential) {
    printInfo(`  组图数量: ${maxImages}张`);
  }
  if (enableSearch) {
    printInfo('  联网搜索: 启用');
  }
  printInfo('  (通常需要 30-60 秒，请稍候...)');
  printInfo('');

  try {
    const response = await makeRequest(
      'POST',
      `${BASE_URL}/images/generations`,
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
        throw new Error('权限不足：请确认 API Key 有图片生成权限');
      } else if (response.status === 429) {
        throw new Error('请求过于频繁：已超过限流配额\n请等待1分钟后重试');
      } else if (response.status === 400) {
        throw new Error(`参数错误：${errorMsg}\n请检查提示词和参数设置`);
      } else {
        throw new Error(`生成失败：${errorMsg}`);
      }
    }

    return response.data;
  } catch (e) {
    if (e.message.includes('生成失败') || e.message.includes('认证失败')) {
      throw e;
    }
    throw new Error(`生成失败：${e.message}`);
  }
}

// ==================== 主函数 ====================

async function main() {
  const args = process.argv.slice(2);
  const options = {
    prompt: null,
    image: [],
    model: DEFAULT_MODEL,
    size: DEFAULT_SIZE,
    'no-watermark': false,
    sequential: false,
    'max-images': 4,
    search: false,
    output: 'generated_image.png'
  };

  // 解析命令行参数
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.substring(2);
      if (key === 'no-watermark' || key === 'sequential' || key === 'search') {
        options[key] = true;
      } else if (i + 1 < args.length && !args[i + 1].startsWith('--')) {
        const value = args[++i];
        if (key === 'image') {
          options.image.push(value);
        } else if (key === 'max-images') {
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
  if (options.sequential && options['max-images'] < 1) {
    printError('max-images 必须大于 0');
    process.exit(1);
  }

  // 执行生成流程
  try {
    printInfo('='.repeat(50));
    printInfo('Seedream 图片生成');
    printInfo('='.repeat(50));
    printInfo('');

    // 生成图片
    const result = await generateImage(
      options.prompt,
      options.image.length > 0 ? options.image : null,
      {
        model: options.model,
        size: options.size,
        watermark: !options['no-watermark'],
        sequential: options.sequential,
        maxImages: options['max-images'],
        enableSearch: options.search
      }
    );

    // 下载图片
    const data = result.data || [];

    if (!data || data.length === 0) {
      throw new Error('API 返回格式错误：缺少 data');
    }

    printInfo('');

    // 处理单图或组图
    if (data.length === 1) {
      // 单张图片
      const imageUrl = data[0].url;
      if (!imageUrl) {
        throw new Error('API 返回格式错误：缺少 url');
      }

      printInfo('正在下载图片...');
      await downloadFile(imageUrl, options.output);

      // 输出成功信息到 stdout（供 Claude 读取）
      printInfo('');
      printInfo('='.repeat(50));
      printInfo('✓ 生成成功！');
      printInfo('='.repeat(50));

      console.log('图片生成成功！');
      console.log(`文件路径: ${path.resolve(options.output)}`);
      console.log(`尺寸: ${data[0].size || 'N/A'}`);
      if (result.usage) {
        console.log(`生成图片数: ${result.usage.generated_images || 1}`);
        console.log(`Token消耗: ${result.usage.total_tokens || 'N/A'}`);
      }
    } else {
      // 多张图片（组图）
      const outputBase = path.parse(options.output);
      const stem = outputBase.name;
      const suffix = outputBase.ext;
      const parent = path.dirname(options.output);

      for (let i = 0; i < data.length; i++) {
        const imageUrl = data[i].url;
        if (!imageUrl) {
          printError(`图片 ${i + 1} 缺少 URL，跳过`);
          continue;
        }

        // 生成文件名：image_1.png, image_2.png, ...
        const outputPath = path.join(parent, `${stem}_${i + 1}${suffix}`);
        printInfo(`正在下载图片 ${i + 1}/${data.length}...`);
        await downloadFile(imageUrl, outputPath);
      }

      // 输出成功信息到 stdout
      printInfo('');
      printInfo('='.repeat(50));
      printInfo('✓ 生成成功！');
      printInfo('='.repeat(50));

      console.log(`组图生成成功！共 ${data.length} 张`);
      console.log(`输出目录: ${path.resolve(parent)}`);
      console.log(`文件命名: ${stem}_1${suffix} ~ ${stem}_${data.length}${suffix}`);
      if (result.usage) {
        console.log(`Token消耗: ${result.usage.total_tokens || 'N/A'}`);
      }
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
