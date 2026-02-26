#!/usr/bin/env node

/**
 * Domain Classifier for News Technology Skill
 *
 * Classifies search keywords into technical domains to enable smart source routing.
 * Supports both English and Chinese keywords.
 */

const DOMAIN_KEYWORDS = {
  frontend: [
    'react', 'vue', 'angular', 'svelte', 'electron', 'next.js', 'nextjs', 'nuxt',
    'preact', 'solid', 'qwik', 'astro', 'remix',
    'javascript', 'typescript', 'js', 'ts', 'jsx', 'tsx',
    'webpack', 'vite', 'rollup', 'parcel', 'esbuild', 'babel',
    'html', 'css', 'sass', 'scss', 'tailwind', 'styled-components',
    'web components', 'pwa', 'spa', 'web',
    'vercel', 'netlify', 'meta', 'facebook',
    'jamstack', 'mern', 'mean',
    'react 18', 'react 19', 'vue 3', 'angular 17', 'angular 18',
    '前端', '网页', '浏览器', '界面'
  ],
  backend: [
    'python', 'golang', 'go', 'java', 'rust', 'nodejs', 'node.js', 'node',
    'php', 'ruby', 'c#', 'csharp', '.net', 'scala', 'kotlin', 'elixir',
    'django', 'flask', 'fastapi', 'spring', 'spring boot', 'express',
    'gin', 'actix', 'rails', 'laravel', 'asp.net',
    'api', 'rest', 'graphql', 'grpc', 'microservices', 'serverless',
    'mysql', 'postgresql', 'postgres', 'mariadb', 'sqlite',
    'oracle', 'mssql', 'sql server',
    'mongodb', 'redis', 'cassandra', 'couchdb', 'dynamodb',
    'elasticsearch', 'neo4j', 'influxdb', 'timescaledb',
    'database', 'sql', 'nosql', 'orm', 'query optimization',
    'lamp', 'lemp', 'mean stack',
    'python 3.12', 'python 3.13', 'go 1.22', 'go 1.23', 'java 21',
    '后端', '服务器', 'server', '服务端', '接口',
    '数据库', '存储', '查询', '索引'
  ],
  mobile: [
    'android', 'ios', 'iphone', 'ipad',
    'flutter', 'react native', 'react-native', 'ionic', 'xamarin',
    'cordova', 'capacitor', 'nativescript',
    'swift', 'kotlin', 'objective-c', 'swiftui', 'jetpack compose',
    '移动开发', '手机', 'app', '移动应用', '安卓', '苹果'
  ],
  ai: [
    'ai', 'artificial intelligence', 'ml', 'machine learning', 'deep learning',
    'neural network', 'deep neural', 'transformer',
    'chatgpt', 'gpt', 'gpt-4', 'gpt-5', 'llm', 'large language model',
    'pytorch', 'tensorflow', 'keras', 'scikit-learn', 'hugging face',
    'openai', 'anthropic', 'claude', 'gemini', 'llama', 'mistral',
    'google ai', 'deepmind', 'meta ai',
    'cohere', 'stability ai', 'midjourney', 'runway',
    'dall-e', 'stable diffusion',
    'nlp', 'computer vision', 'reinforcement learning', 'gan', 'diffusion',
    'bert', 'attention mechanism', 'embeddings',
    '人工智能', '机器学习', '深度学习', '大模型', '神经网络',
    '自然语言', '计算机视觉',
    '百度', 'baidu', '阿里', 'alibaba', '腾讯', 'tencent'
  ],
  devops: [
    'docker', 'kubernetes', 'k8s', 'containerd', 'podman', 'helm',
    'ci/cd', 'ci', 'cd', 'jenkins', 'gitlab', 'github actions',
    'circleci', 'travis', 'azure devops', 'bamboo', 'teamcity',
    'terraform', 'ansible', 'puppet', 'chef', 'vagrant', 'packer',
    'prometheus', 'grafana', 'elk', 'kibana', 'logstash',
    'datadog', 'new relic', 'splunk',
    'aws', 'amazon web services', 'azure', 'microsoft azure',
    'gcp', 'google cloud', 'alibaba cloud', 'aliyun', 'tencent cloud',
    'digitalocean', 'linode', 'heroku',
    's3', 'ec2', 'lambda', 'cloudfront', 'rds', 'ecs', 'eks',
    'azure functions', 'cloud run', 'app engine',
    'cloud computing', 'saas', 'paas', 'iaas', 'cloud native',
    'multi-cloud', 'hybrid cloud',
    'hashicorp', 'docker inc', 'red hat', 'vmware',
    'amazon', 'google cloud platform',
    'devops', '运维', '部署', '持续集成', '持续部署', '容器', '编排',
    '云计算', 'cloud', '云服务', '云原生', '阿里云', '腾讯云'
  ],
  blockchain: [
    'blockchain', 'ethereum', 'bitcoin', 'solana', 'cardano',
    'polkadot', 'avalanche', 'polygon', 'binance smart chain',
    'web3', 'crypto', 'cryptocurrency', 'defi', 'nft',
    'smart contract', 'solidity', 'dapp', 'dao', 'token',
    'consensus', 'proof of work', 'proof of stake',
    '区块链', '加密货币', 'nft', '智能合约', '去中心化', '比特币', '以太坊'
  ],
  hardware: [
    'arduino', 'raspberry pi', 'esp32', 'esp8266', 'stm32',
    'teensy', 'beaglebone', 'nvidia jetson',
    'iot', 'internet of things', 'embedded', 'firmware',
    'fpga', 'microcontroller', 'mcu', 'sensor', 'actuator',
    'uart', 'i2c', 'spi', 'gpio',
    '硬件', '物联网', '嵌入式', '单片机', '树莓派', '传感器'
  ],
  security: [
    'security', 'cybersecurity', 'infosec', 'vulnerability',
    'exploit', 'hack', 'hacker', 'penetration testing', 'pentest',
    'cve', 'zero-day', 'malware', 'ransomware', 'phishing',
    'ddos', 'xss', 'sql injection', 'csrf', 'mitm',
    'encryption', 'cryptography', 'ssl', 'tls', 'https',
    'authentication', 'authorization', 'oauth', 'jwt', 'firewall',
    'antivirus', 'ids', 'ips', 'siem', 'vpn',
    '安全', '漏洞', '攻击', '防护', '加密', '黑客', '网络安全', '信息安全'
  ],
  os: [
    'linux', 'windows', 'macos', 'mac os', 'ubuntu', 'debian',
    'centos', 'rhel', 'fedora', 'arch linux', 'gentoo', 'freebsd',
    'android', 'ios',
    'kernel', 'operating system', 'systemd', 'bash', 'shell',
    'terminal', 'command line', 'posix',
    '操作系统', 'kernel', '内核', '系统', '命令行', '终端'
  ]
};

const DOMAIN_ALIASES = {
  web: 'frontend',
  'frontend-dev': 'frontend',
  fe: 'frontend',
  ui: 'frontend',
  ux: 'frontend',
  be: 'backend',
  'backend-dev': 'backend',
  server: 'backend',
  database: 'backend',
  db: 'backend',
  ml: 'ai',
  'machine-learning': 'ai',
  'deep-learning': 'ai',
  'data-science': 'ai',
  ops: 'devops',
  infrastructure: 'devops',
  cloud: 'devops',
  sre: 'devops',
  iot: 'hardware',
  embedded: 'hardware',
  infosec: 'security',
  cybersecurity: 'security',
  cyber: 'security',
  linux: 'os',
  unix: 'os',
  '网站': 'frontend',
  '网页开发': 'frontend',
  '服务端': 'backend',
  '数据': 'backend',
  '智能': 'ai',
  '数据科学': 'ai',
  '云': 'devops',
  '基础设施': 'devops',
  '物联': 'hardware',
  '嵌入': 'hardware',
  '信息安全': 'security',
  '系统': 'os'
};

const DOMAIN_DESCRIPTIONS = {
  general: 'General tech news',
  frontend: 'Frontend/Web development',
  backend: 'Backend development (includes databases)',
  mobile: 'Mobile development',
  ai: 'AI/Machine Learning',
  devops: 'DevOps/Infrastructure (includes cloud)',
  blockchain: 'Blockchain/Web3',
  hardware: 'Hardware/IoT',
  security: 'Security/InfoSec',
  os: 'Operating Systems'
};

function resolveAlias(keywordOrDomain) {
  return DOMAIN_ALIASES[keywordOrDomain.toLowerCase()] || keywordOrDomain;
}

function classifyKeyword(keyword) {
  const keywordLower = keyword.toLowerCase();
  const domains = new Set(['general']); // Always include general

  // Check if keyword itself is an alias
  if (keywordLower in DOMAIN_ALIASES) {
    domains.add(DOMAIN_ALIASES[keywordLower]);
  }

  // Match against domain keywords
  for (const [domain, patterns] of Object.entries(DOMAIN_KEYWORDS)) {
    if (patterns.some(pattern => keywordLower.includes(pattern))) {
      domains.add(domain);
    }
  }

  return domains;
}

function getSourcesForDomains(allSources, domains) {
  return allSources.filter(source => {
    const enabled = source.enabled !== false; // Default to true
    const sourceDomains = source.domains || ['general'];
    const hasMatchingDomain = [...domains].some(d => sourceDomains.includes(d));
    return enabled && hasMatchingDomain;
  });
}

function getDomainDescription(domain) {
  return DOMAIN_DESCRIPTIONS[domain] || domain;
}

module.exports = {
  classifyKeyword,
  getSourcesForDomains,
  getDomainDescription,
  resolveAlias,
  DOMAIN_KEYWORDS,
  DOMAIN_ALIASES
};
