"""
Domain Classifier for News Technology Skill

Classifies search keywords into technical domains to enable smart source routing.
Supports both English and Chinese keywords.
"""

from typing import Set, Dict, List

# Domain keyword patterns (English and Chinese)
DOMAIN_KEYWORDS: Dict[str, List[str]] = {
    "frontend": [
        # Frameworks & Libraries
        "react", "vue", "angular", "svelte", "electron", "next.js", "nextjs", "nuxt",
        "preact", "solid", "qwik", "astro", "remix",
        # Languages
        "javascript", "typescript", "js", "ts", "jsx", "tsx",
        # Tools & Build Systems
        "webpack", "vite", "rollup", "parcel", "esbuild", "babel",
        # Technologies
        "html", "css", "sass", "scss", "tailwind", "styled-components",
        "web components", "pwa", "spa", "web",
        # Companies
        "vercel", "netlify", "meta", "facebook",
        # Stacks
        "jamstack", "mern", "mean",
        # Version-specific
        "react 18", "react 19", "vue 3", "angular 17", "angular 18",
        # Chinese
        "前端", "网页", "浏览器", "界面"
    ],
    "backend": [
        # Languages
        "python", "golang", "go", "java", "rust", "nodejs", "node.js", "node",
        "php", "ruby", "c#", "csharp", ".net", "scala", "kotlin", "elixir",
        # Frameworks
        "django", "flask", "fastapi", "spring", "spring boot", "express",
        "gin", "actix", "rails", "laravel", "asp.net",
        # Concepts
        "api", "rest", "graphql", "grpc", "microservices", "serverless",
        # DATABASE keywords (merged from old "database" domain)
        "mysql", "postgresql", "postgres", "mariadb", "sqlite",
        "oracle", "mssql", "sql server",
        "mongodb", "redis", "cassandra", "couchdb", "dynamodb",
        "elasticsearch", "neo4j", "influxdb", "timescaledb",
        "database", "sql", "nosql", "orm", "query optimization",
        # Companies
        "oracle", "microsoft", "mongodb inc",
        # Stacks
        "lamp", "lemp", "mean stack",
        # Version-specific
        "python 3.12", "python 3.13", "go 1.22", "go 1.23", "java 21",
        # Chinese
        "后端", "服务器", "server", "服务端", "接口",
        "数据库", "存储", "查询", "索引"
    ],
    "mobile": [
        # Platforms
        "android", "ios", "iphone", "ipad",
        # Frameworks
        "flutter", "react native", "react-native", "ionic", "xamarin",
        "cordova", "capacitor", "nativescript",
        # Languages
        "swift", "kotlin", "objective-c", "swiftui", "jetpack compose",
        # Chinese
        "移动开发", "手机", "app", "移动应用", "安卓", "苹果"
    ],
    "ai": [
        # General AI
        "ai", "artificial intelligence", "ml", "machine learning", "deep learning",
        "neural network", "deep neural", "transformer",
        # Models & Tools
        "chatgpt", "gpt", "gpt-4", "gpt-5", "llm", "large language model",
        "pytorch", "tensorflow", "keras", "scikit-learn", "hugging face",
        "openai", "anthropic", "claude", "gemini", "llama", "mistral",
        # Companies
        "openai", "anthropic", "google ai", "deepmind", "meta ai",
        "cohere", "stability ai", "midjourney", "runway",
        # Products
        "chatgpt", "gpt-4", "gpt-5", "claude", "gemini", "bard",
        "copilot", "github copilot", "cursor", "dall-e", "stable diffusion",
        # Techniques
        "nlp", "computer vision", "reinforcement learning", "gan", "diffusion",
        "bert", "attention mechanism", "embeddings",
        # Chinese
        "人工智能", "机器学习", "深度学习", "大模型", "神经网络",
        "自然语言", "计算机视觉",
        # Chinese companies
        "百度", "baidu", "阿里", "alibaba", "腾讯", "tencent"
    ],
    "devops": [
        # Containers & Orchestration
        "docker", "kubernetes", "k8s", "containerd", "podman", "helm",
        # CI/CD
        "ci/cd", "ci", "cd", "jenkins", "gitlab", "github actions",
        "circleci", "travis", "azure devops", "bamboo", "teamcity",
        # Infrastructure
        "terraform", "ansible", "puppet", "chef", "vagrant", "packer",
        # Monitoring & Logging
        "prometheus", "grafana", "elk", "elasticsearch", "kibana", "logstash",
        "datadog", "new relic", "splunk",
        # CLOUD keywords (merged from old "cloud" domain)
        "aws", "amazon web services", "azure", "microsoft azure",
        "gcp", "google cloud", "alibaba cloud", "aliyun", "tencent cloud",
        "digitalocean", "linode", "heroku",
        # Cloud Services
        "s3", "ec2", "lambda", "cloudfront", "rds", "ecs", "eks",
        "azure functions", "cloud run", "app engine",
        # Cloud Concepts
        "cloud computing", "saas", "paas", "iaas", "cloud native",
        "multi-cloud", "hybrid cloud",
        # Companies
        "hashicorp", "docker inc", "red hat", "vmware",
        "amazon", "google cloud platform",
        # Chinese
        "devops", "运维", "部署", "持续集成", "持续部署", "容器", "编排",
        "云计算", "cloud", "云服务", "云原生", "阿里云", "腾讯云"
    ],
    "blockchain": [
        # Platforms
        "blockchain", "ethereum", "bitcoin", "solana", "cardano",
        "polkadot", "avalanche", "polygon", "binance smart chain",
        # Technologies
        "web3", "crypto", "cryptocurrency", "defi", "nft",
        "smart contract", "solidity", "dapp", "dao", "token",
        "consensus", "proof of work", "proof of stake",
        # Chinese
        "区块链", "加密货币", "nft", "智能合约", "去中心化", "比特币", "以太坊"
    ],
    "hardware": [
        # Boards & Platforms
        "arduino", "raspberry pi", "esp32", "esp8266", "stm32",
        "teensy", "beaglebone", "nvidia jetson",
        # Technologies
        "iot", "internet of things", "embedded", "firmware",
        "fpga", "microcontroller", "mcu", "sensor", "actuator",
        "uart", "i2c", "spi", "gpio",
        # Chinese
        "硬件", "物联网", "嵌入式", "单片机", "树莓派", "传感器"
    ],
    "security": [
        # General
        "security", "cybersecurity", "infosec", "vulnerability",
        "exploit", "hack", "hacker", "penetration testing", "pentest",
        # Threats & Attacks
        "cve", "zero-day", "malware", "ransomware", "phishing",
        "ddos", "xss", "sql injection", "csrf", "mitm",
        # Tools & Concepts
        "encryption", "cryptography", "ssl", "tls", "https",
        "authentication", "authorization", "oauth", "jwt", "firewall",
        "antivirus", "ids", "ips", "siem", "vpn",
        # Chinese
        "安全", "漏洞", "攻击", "防护", "加密", "黑客", "网络安全", "信息安全"
    ],
    "os": [
        # Operating Systems
        "linux", "windows", "macos", "mac os", "ubuntu", "debian",
        "centos", "rhel", "fedora", "arch linux", "gentoo", "freebsd",
        "android", "ios",
        # Kernel & System
        "kernel", "operating system", "systemd", "bash", "shell",
        "terminal", "command line", "posix",
        # Chinese
        "操作系统", "kernel", "内核", "系统", "命令行", "终端"
    ]
}


# Domain aliases for common variations and backward compatibility
DOMAIN_ALIASES: Dict[str, str] = {
    # English aliases
    "web": "frontend",
    "frontend-dev": "frontend",
    "fe": "frontend",
    "ui": "frontend",
    "ux": "frontend",
    "be": "backend",
    "backend-dev": "backend",
    "server": "backend",
    "database": "backend",  # Merged: database → backend
    "db": "backend",
    "ml": "ai",
    "machine-learning": "ai",
    "deep-learning": "ai",
    "data-science": "ai",
    "ops": "devops",
    "infrastructure": "devops",
    "cloud": "devops",  # Merged: cloud → devops
    "sre": "devops",
    "iot": "hardware",
    "embedded": "hardware",
    "infosec": "security",
    "cybersecurity": "security",
    "cyber": "security",
    "linux": "os",
    "unix": "os",

    # Chinese aliases
    "网站": "frontend",
    "网页开发": "frontend",
    "服务端": "backend",
    "数据": "backend",
    "智能": "ai",
    "数据科学": "ai",
    "云": "devops",
    "基础设施": "devops",
    "物联": "hardware",
    "嵌入": "hardware",
    "信息安全": "security",
    "系统": "os"
}


def resolve_alias(keyword_or_domain: str) -> str:
    """
    Resolve domain alias to canonical domain name.

    Args:
        keyword_or_domain: Domain name or alias (e.g., "web", "ML", "云")

    Returns:
        Canonical domain name (e.g., "frontend", "ai", "devops")

    Examples:
        >>> resolve_alias("web")
        'frontend'
        >>> resolve_alias("ML")
        'ai'
        >>> resolve_alias("云")
        'devops'
    """
    return DOMAIN_ALIASES.get(keyword_or_domain.lower(), keyword_or_domain)


def classify_keyword(keyword: str) -> Set[str]:
    """
    Classify search keyword into technical domains.

    Supports domain aliases (e.g., "web" → "frontend", "ML" → "ai", "云" → "devops")
    for better user experience.

    Args:
        keyword: User search query (e.g., "Electron 前端框架", "ChatGPT 最新消息", "web development")

    Returns:
        Set of domain names (e.g., {"frontend", "general"})
        Always includes "general" domain for comprehensive coverage.

    Examples:
        >>> classify_keyword("Electron 技术资讯")
        {'general', 'frontend'}

        >>> classify_keyword("web development")
        {'general', 'frontend'}  # "web" alias resolves to "frontend"

        >>> classify_keyword("ML models")
        {'general', 'ai'}  # "ML" alias resolves to "ai"

        >>> classify_keyword("云计算")
        {'general', 'devops'}  # "云" alias resolves to "devops"
    """
    keyword_lower = keyword.lower()
    domains = {"general"}  # Always include general sources

    # Check if keyword itself is a domain alias
    if keyword_lower in DOMAIN_ALIASES:
        domains.add(DOMAIN_ALIASES[keyword_lower])

    # Match against domain keywords
    for domain, patterns in DOMAIN_KEYWORDS.items():
        if any(pattern in keyword_lower for pattern in patterns):
            domains.add(domain)

    return domains


def get_sources_for_domains(all_sources: List[dict], domains: Set[str]) -> List[dict]:
    """
    Filter news sources by detected domains.

    Args:
        all_sources: List of all available news sources
        domains: Set of domain names detected from keyword

    Returns:
        List of sources that match any of the detected domains

    Examples:
        >>> sources = [
        ...     {"id": "techcrunch", "domains": ["general"], "enabled": True},
        ...     {"id": "react-blog", "domains": ["frontend"], "enabled": True},
        ...     {"id": "disabled", "domains": ["frontend"], "enabled": False}
        ... ]
        >>> get_sources_for_domains(sources, {"general", "frontend"})
        [{'id': 'techcrunch', ...}, {'id': 'react-blog', ...}]
    """
    return [
        source for source in all_sources
        if source.get("enabled", True) and
        any(domain in source.get("domains", ["general"]) for domain in domains)
    ]


def get_domain_description(domain: str) -> str:
    """
    Get human-readable description for a domain.

    Args:
        domain: Domain name (e.g., "frontend", "ai")

    Returns:
        Description string
    """
    descriptions = {
        "general": "General tech news",
        "frontend": "Frontend/Web development",
        "backend": "Backend development (includes databases)",
        "mobile": "Mobile development",
        "ai": "AI/Machine Learning",
        "devops": "DevOps/Infrastructure (includes cloud)",
        "blockchain": "Blockchain/Web3",
        "hardware": "Hardware/IoT",
        "security": "Security/InfoSec",
        "os": "Operating Systems"
    }
    return descriptions.get(domain, domain)


if __name__ == "__main__":
    # Test domain classification
    test_keywords = [
        "Electron 技术资讯",
        "前端框架最新动态",
        "ChatGPT 最新消息",
        "机器学习大模型",
        "Docker 安全漏洞",
        "运维自动化",
        "树莓派 IoT",
        "Python 后端开发",
        "React Vue Angular",
        "技术新闻",
        # Test aliases
        "web development",
        "ML models",
        "云计算",
        "database optimization",
        "OpenAI"
    ]

    print("Domain Classification Tests:\n")
    for keyword in test_keywords:
        domains = classify_keyword(keyword)
        domain_list = ", ".join(sorted(domains))
        print(f"'{keyword}' → {{{domain_list}}}")
