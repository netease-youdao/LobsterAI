## openclaw 安装本地插件使用指南

1、将本地打包好的插件，放入该项目vendor目录下

目录结构如下

```
LobsterAI/
└── vendor/
    └── local-plugins/
        └── clawtrace-1.0.1.tgz   ← 每次发布新版本替换这里
```

2、更新根目录下package.json中的插件字段

```
{
  "openclaw": {
    "plugins": [
      ...其他已有插件...,
      {
        "id": "openclaw-plugin-name",
        "npm": "openclaw-plugin-name",
        "version": "file:vendor/local-plugins/openclaw-plugin-name-1.0.0.tgz"
      }
    ]
  }
}

```

3、随后进行打包流程

mac&linux

windows

```
# 强制重新安装插件（忽略缓存）

$env:OPENCLAW_FORCE_PLUGIN_INSTALL="1"; npm run openclaw:plugins
# 同步本地 openclaw-extensions/ 目录

npm run openclaw:extensions:local
# 然后直接启动（跳过 OpenClaw 版本重建）

$env:OPENCLAW_SKIP_ENSURE="1"; npm run electron:dev:openclaw
```
