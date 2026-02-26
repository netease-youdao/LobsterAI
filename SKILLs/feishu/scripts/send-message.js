// 尝试从项目目录加载 axios
let axios;
try {
  axios = require('axios');
} catch {
  axios = require('/Users/panyf/Java/code/LobsterAI/node_modules/axios');
}
const https = require('https');
const fs = require('fs');
const path = require('path');
// 尝试加载 form-data
let FormData;
try {
  FormData = require('form-data');
} catch {
  FormData = require('/Users/panyf/Java/code/LobsterAI/node_modules/form-data');
}

const httpsAgent = new https.Agent({
  rejectUnauthorized: false
});

function loadConfig() {
  const configPath = process.env.FEISHU_CONFIG || __dirname + '/config.json';
  if (fs.existsSync(configPath)) {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
  return {
    app_id: process.env.FEISHU_APP_ID || 'cli_a9141efc16b0dcb1',
    app_secret: process.env.FEISHU_APP_SECRET || 'KkZcwOYxjYJ1iCDCaIUgjc0vloDenAIm'
  };
}

async function getTenantAccessToken(config) {
  const response = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
    app_id: config.app_id,
    app_secret: config.app_secret
  }, { httpsAgent });
  return response.data.tenant_access_token;
}

async function getUserList(token) {
  const response = await axios.get('https://open.feishu.cn/open-apis/contact/v3/users?page_size=20', {
    headers: { 'Authorization': `Bearer ${token}` },
    httpsAgent
  });
  return response.data;
}

async function uploadFile(token, filePath) {
  const fileName = path.basename(filePath);
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath));
  form.append('file_type', 'stream');
  form.append('file_name', fileName);

  const response = await axios.post('https://open.feishu.cn/open-apis/im/v1/files', form, {
    headers: {
      'Authorization': `Bearer ${token}`,
      ...form.getHeaders()
    },
    httpsAgent
  });

  if (response.data.code !== 0) {
    throw new Error(response.data.msg || '文件上传失败');
  }

  return response.data.data.file_key;
}

async function sendMessageToUser(token, receiveId, content, fileKey = null) {
  let msgType = 'text';
  let msgContent = JSON.stringify({ text: content });

  if (fileKey) {
    msgType = 'file';
    msgContent = JSON.stringify({ file_key: fileKey });
  }

  const response = await axios.post('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
    receive_id: receiveId,
    msg_type: msgType,
    content: msgContent
  }, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    httpsAgent
  });
  return response.data;
}

async function sendMessageToChat(token, chatId, content, fileKey = null) {
  let msgType = 'text';
  let msgContent = JSON.stringify({ text: content });

  if (fileKey) {
    msgType = 'file';
    msgContent = JSON.stringify({ file_key: fileKey });
  }

  const response = await axios.post('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id', {
    receive_id: chatId,
    msg_type: msgType,
    content: msgContent
  }, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    httpsAgent
  });
  return response.data;
}

async function main() {
  const config = loadConfig();
  const message = process.argv[2] || process.env.FEISHU_MESSAGE || '';
  const filePath = process.argv[3] || process.env.FEISHU_FILE || '';
  const target = process.argv[4] || 'first';

  if (!message && !filePath) {
    console.error('用法: node send-message.js "消息内容" [文件路径] [目标]');
    console.error('示例: node send-message.js "你好"');
    console.error('示例: node send-message.js "请查收" /path/to/file.pdf');
    console.error('示例: node send-message.js "" /path/to/file.pdf');
    process.exit(1);
  }

  try {
    const token = await getTenantAccessToken(config);
    console.log('Token 获取成功');

    let fileKey = null;
    if (filePath && fs.existsSync(filePath)) {
      console.log('上传文件中:', filePath);
      fileKey = await uploadFile(token, filePath);
      console.log('文件上传成功:', fileKey);
    }

    let result;
    if (target === 'first') {
      const users = await getUserList(token);
      const user = users.data.items[0];
      console.log('发送给用户:', user.name);
      result = await sendMessageToUser(token, user.open_id, message, fileKey);
    } else if (target.startsWith('oc_')) {
      result = await sendMessageToChat(token, target, message, fileKey);
    } else if (target.startsWith('ou_')) {
      result = await sendMessageToUser(token, target, message, fileKey);
    }

    console.log('发送成功:', JSON.stringify(result.data, null, 2));
  } catch (error) {
    console.error('错误:', error.response?.data || error.message);
    process.exit(1);
  }
}

main();
