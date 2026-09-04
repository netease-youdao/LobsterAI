(function () {
  const THEME_PRESETS = {
    "paperwhisper-warm-ledger": {
      color: {
        pageBg: "#ebe1cf",
        pageBgAlt: "#f3eadc",
        surface: "#fffdf9",
        surfaceSoft: "#f9f2eb",
        ink: "#1e1914",
        muted: "#7f7266",
        accent: "#bf4935",
        accentSoft: "#efd8d1",
        line: "#d4c5b2",
        chipNeutral: "#45506d",
        chipAccent: "#bf4935",
        chipPositive: "#2d8b57",
      },
      radius: {
        card: "10px",
        chip: "4px",
      },
      type: {
        display: '"Songti SC", "STSong", "Noto Serif CJK SC", serif',
        body: '"Songti SC", "STSong", "Noto Serif CJK SC", serif',
        mono: '"SFMono-Regular", Menlo, Consolas, monospace',
      },
      space: {
        xs: "8px",
        sm: "12px",
        md: "18px",
        lg: "28px",
        xl: "40px",
      },
      shadow: {
        paper: "0 10px 28px rgba(58, 45, 30, 0.12)",
      },
      texture: {
        wash: "0.12",
      },
    },
    "editorial-tldr-bold": {
      color: {
        pageBg: "#f3f1ec",
        pageBgAlt: "#fbfaf7",
        surface: "#fffefb",
        surfaceSoft: "#f3f4f6",
        ink: "#17181b",
        muted: "#5e636c",
        accent: "#295ea8",
        accentSoft: "#dce7f6",
        line: "#cfd4dc",
        chipNeutral: "#17181b",
        chipAccent: "#295ea8",
        chipPositive: "#4a6d97",
      },
      radius: {
        card: "18px",
        chip: "999px",
      },
      type: {
        display: '"Smiley Sans", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
        body: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
        mono: '"SFMono-Regular", Menlo, Consolas, monospace',
      },
      space: {
        xs: "8px",
        sm: "12px",
        md: "20px",
        lg: "30px",
        xl: "44px",
      },
      shadow: {
        paper: "0 8px 24px rgba(23, 24, 27, 0.06)",
      },
      texture: {
        wash: "0.06",
      },
    },
    "curator-mosaic-soft": {
      color: {
        pageBg: "#f4eee8",
        pageBgAlt: "#fbf8f4",
        surface: "#fffdfb",
        surfaceSoft: "#f7f0ea",
        ink: "#2f2724",
        muted: "#786c65",
        accent: "#d06a5f",
        accentSoft: "#f7d9d4",
        line: "#dfd1c8",
        chipNeutral: "#7e8fb0",
        chipAccent: "#d06a5f",
        chipPositive: "#4f9e8f",
      },
      radius: {
        card: "24px",
        chip: "999px",
      },
      type: {
        display: '"LXGW WenKai", "Songti SC", "STSong", serif',
        body: '"LXGW WenKai", "Songti SC", "STSong", serif',
        mono: '"SFMono-Regular", Menlo, Consolas, monospace',
      },
      space: {
        xs: "10px",
        sm: "14px",
        md: "20px",
        lg: "32px",
        xl: "48px",
      },
      shadow: {
        paper: "0 16px 40px rgba(90, 64, 52, 0.10)",
      },
      texture: {
        wash: "0.10",
      },
    },
    "travel-notes-paper": {
      color: {
        pageBg: "#ccb08b",
        pageBgAlt: "#d8bf9a",
        surface: "#f7f0de",
        surfaceSoft: "#f4e7c0",
        ink: "#2d251f",
        muted: "#7f6855",
        accent: "#a96333",
        accentSoft: "#edd9be",
        line: "#c9b090",
        chipNeutral: "#8b572f",
        chipAccent: "#b06d35",
        chipPositive: "#6c8f52",
      },
      radius: {
        card: "6px",
        chip: "999px",
      },
      type: {
        display: '"LXGW WenKai", "Songti SC", "STSong", serif',
        body: '"LXGW WenKai", "Songti SC", "STSong", serif',
        mono: '"SFMono-Regular", Menlo, Consolas, monospace',
      },
      space: {
        xs: "8px",
        sm: "12px",
        md: "18px",
        lg: "30px",
        xl: "42px",
      },
      shadow: {
        paper: "0 10px 22px rgba(86, 61, 34, 0.10)",
      },
      texture: {
        wash: "0.08",
      },
    },
    "deep-tech-nocturne": {
      color: {
        pageBg: "#130e2a",
        pageBgAlt: "#1b1437",
        surface: "#231d46",
        surfaceSoft: "#2d2754",
        ink: "#f5f2ff",
        muted: "#b8b2d8",
        accent: "#9e73ff",
        accentSoft: "#392f69",
        line: "#453f78",
        chipNeutral: "#473d72",
        chipAccent: "#9e73ff",
        chipPositive: "#4ac7c7",
      },
      radius: {
        card: "18px",
        chip: "999px",
      },
      type: {
        display: '"Smiley Sans", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
        body: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
        mono: '"SFMono-Regular", Menlo, Consolas, monospace',
      },
      space: {
        xs: "8px",
        sm: "12px",
        md: "18px",
        lg: "28px",
        xl: "44px",
      },
      shadow: {
        paper: "0 20px 50px rgba(7, 5, 18, 0.45)",
      },
      texture: {
        wash: "0.16",
      },
    },
    "daily-brief-clean": {
      color: {
        pageBg: "#f8f8f8",
        pageBgAlt: "#ffffff",
        surface: "#ffffff",
        surfaceSoft: "#f5f5f5",
        ink: "#171717",
        muted: "#6f6f6f",
        accent: "#c73b2f",
        accentSoft: "#f5e4df",
        line: "#e7e7e7",
        chipNeutral: "#2f7db7",
        chipAccent: "#c73b2f",
        chipPositive: "#1f9c91",
      },
      radius: {
        card: "0px",
        chip: "2px",
      },
      type: {
        display: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
        body: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
        mono: '"SFMono-Regular", Menlo, Consolas, monospace',
      },
      space: {
        xs: "8px",
        sm: "12px",
        md: "18px",
        lg: "28px",
        xl: "40px",
      },
      shadow: {
        paper: "none",
      },
      texture: {
        wash: "0.02",
      },
    },
    "playbook-brutal-lite": {
      color: {
        pageBg: "#f2e9d2",
        pageBgAlt: "#f7f0df",
        surface: "#ffffff",
        surfaceSoft: "#fff4d4",
        ink: "#121212",
        muted: "#585858",
        accent: "#111111",
        accentSoft: "#ffe25a",
        line: "#111111",
        chipNeutral: "#ffe25a",
        chipAccent: "#f3a7c6",
        chipPositive: "#8fd0f3",
      },
      radius: {
        card: "2px",
        chip: "0px",
      },
      type: {
        display: '"Smiley Sans", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
        body: '"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif',
        mono: '"SFMono-Regular", Menlo, Consolas, monospace',
      },
      space: {
        xs: "8px",
        sm: "12px",
        md: "18px",
        lg: "28px",
        xl: "44px",
      },
      shadow: {
        paper: "4px 4px 0 rgba(17, 17, 17, 0.92)",
      },
      texture: {
        wash: "0.04",
      },
    },
  };
  THEME_PRESETS["paperwhisper-warm-redline"] = THEME_PRESETS["paperwhisper-warm-ledger"];

  const VARIANT_REGISTRY = {
    masthead: ["centered-stamp", "compact-ledger"],
    "tag-row": ["flag-tabs", "stamp-tags"],
    "section-card": ["paper-slip", "redline-note", "ledger-panel"],
    "bullet-note": ["loose-list", "icon-list"],
    "metric-strip": ["triple-counter", "swing-board"],
    "quote-stack": ["pink-stack", "margin-quotes"],
    divider: ["stitched-line", "tiny-ornament"],
    "footer-mark": ["edition-footer", "double-rule-footer"],
    "stat-band": ["headline-strip", "daily-totals"],
    "timeline-card": ["day-steps", "phase-ladder"],
    "callout-quote": ["inline-pull", "soft-banner"],
    "checklist-card": ["paper-checks", "setup-checks"],
    "comparison-card": ["split-verdict", "before-after"],
    "code-card": ["terminal-panel", "token-sheet"],
    "news-stream": ["daily-stream", "commentary-stream"],
    "tip-box": ["advice-board", "pitfall-board"],
  };

  function readReportData() {
    const dataNode = document.getElementById("clip-data");
    if (!dataNode) {
      throw new Error("Missing #clip-data node.");
    }
    return JSON.parse(dataNode.textContent);
  }

  function createNode(tag, className, text) {
    const node = document.createElement(tag);
    if (className) {
      node.className = className;
    }
    if (typeof text === "string") {
      node.textContent = text;
    }
    return node;
  }

  function mergeTheme(theme) {
    const preset = THEME_PRESETS[(theme && theme.preset) || "paperwhisper-warm-redline"] || THEME_PRESETS["paperwhisper-warm-redline"];
    const overrides = (theme && theme.tokens) || {};
    return {
      color: Object.assign({}, preset.color, overrides.color || {}),
      radius: Object.assign({}, preset.radius, overrides.radius || {}),
      type: Object.assign({}, preset.type, overrides.type || {}),
      space: Object.assign({}, preset.space, overrides.space || {}),
      shadow: Object.assign({}, preset.shadow, overrides.shadow || {}),
      texture: Object.assign({}, preset.texture, overrides.texture || {}),
    };
  }

  function applyTheme(theme) {
    const presetName = (theme && theme.preset) || "paperwhisper-warm-ledger";
    const merged = mergeTheme(theme);
    const root = document.documentElement;
    document.body.dataset.themePreset = presetName;
    root.style.setProperty("--page-bg", merged.color.pageBg);
    root.style.setProperty("--page-bg-alt", merged.color.pageBgAlt);
    root.style.setProperty("--surface", merged.color.surface);
    root.style.setProperty("--surface-soft", merged.color.surfaceSoft);
    root.style.setProperty("--ink", merged.color.ink);
    root.style.setProperty("--muted", merged.color.muted);
    root.style.setProperty("--accent", merged.color.accent);
    root.style.setProperty("--accent-soft", merged.color.accentSoft);
    root.style.setProperty("--line", merged.color.line);
    root.style.setProperty("--chip-neutral", merged.color.chipNeutral);
    root.style.setProperty("--chip-accent", merged.color.chipAccent);
    root.style.setProperty("--chip-positive", merged.color.chipPositive);
    root.style.setProperty("--font-display", merged.type.display);
    root.style.setProperty("--font-body", merged.type.body);
    root.style.setProperty("--font-mono", merged.type.mono || '"SFMono-Regular", Menlo, Consolas, monospace');
    root.style.setProperty("--radius-card", merged.radius.card);
    root.style.setProperty("--radius-chip", merged.radius.chip);
    root.style.setProperty("--space-xs", merged.space.xs);
    root.style.setProperty("--space-sm", merged.space.sm);
    root.style.setProperty("--space-md", merged.space.md);
    root.style.setProperty("--space-lg", merged.space.lg);
    root.style.setProperty("--space-xl", merged.space.xl);
    root.style.setProperty("--shadow-paper", merged.shadow.paper);
    root.style.setProperty("--texture-wash", merged.texture.wash);
  }

  function resolveLayoutFreedom(layout) {
    return (layout && (layout.freedom || layout.freedom_level)) || "stable";
  }

  function isStructuralBlock(block) {
    return ["masthead", "tag-row", "divider", "footer-mark"].includes(block.type);
  }

  function pickExpressiveFlow(block, narrativeIndex, presetName) {
    if (isStructuralBlock(block)) {
      return "full";
    }

    if (narrativeIndex === 0 && ["section-card", "metric-strip", "comparison-card", "news-stream", "timeline-card"].includes(block.type)) {
      return "hero";
    }

    const alternatingWide = narrativeIndex % 2 === 0 ? "wide-left" : "wide-right";
    const alternatingNarrow = narrativeIndex % 2 === 0 ? "narrow-right" : "narrow-left";

    if (["metric-strip", "stat-band"].includes(block.type)) {
      return "center-float";
    }

    if (["quote-stack", "bullet-note", "callout-quote"].includes(block.type)) {
      return alternatingNarrow;
    }

    if (["comparison-card", "timeline-card", "checklist-card", "code-card", "news-stream", "tip-box"].includes(block.type)) {
      return presetName === "playbook-brutal-lite" ? "hero" : alternatingWide;
    }

    if (block.type === "section-card") {
      return alternatingWide;
    }

    return "full";
  }

  function normalizeBlocks(blocks, layout, theme) {
    const freedom = resolveLayoutFreedom(layout);
    const presetName = (theme && theme.preset) || "paperwhisper-warm-ledger";
    let narrativeIndex = 0;

    return (blocks || []).map(function (block, index, list) {
      const variants = VARIANT_REGISTRY[block.type] || [];
      let variant = block.variant || variants[0] || "default";
      const previous = list[index - 1];
      if (previous && previous.type === block.type && previous.variant === variant && variants.length > 1) {
        const currentIndex = Math.max(variants.indexOf(variant), 0);
        variant = variants[(currentIndex + 1) % variants.length];
      }

      const flow = freedom === "expressive"
        ? pickExpressiveFlow(block, narrativeIndex, presetName)
        : "full";

      if (!isStructuralBlock(block)) {
        narrativeIndex += 1;
      }

      return Object.assign({}, block, {
        variant: variant,
        tone: block.tone || "neutral",
        flow: flow,
      });
    });
  }

  function createBlockShell(block) {
    const shell = createNode("section", "clip-block");
    shell.dataset.type = block.type;
    shell.dataset.variant = block.variant;
    shell.dataset.tone = block.tone || "neutral";
    shell.dataset.flow = block.flow || "full";
    return shell;
  }

  function appendStandardHeader(target, props) {
    const header = createNode("div", "block-header");
    if (props.icon) {
      header.append(createNode("div", "block-icon", props.icon));
    }
    header.append(createNode("h2", "block-title", props.title || ""));
    target.append(header, createNode("div", "block-rule"));
  }

  function renderMasthead(block) {
    const props = block.props || {};
    const node = createBlockShell(block);
    node.classList.add("masthead", "masthead--" + block.variant);
    node.append(
      createNode("h1", "masthead-title", props.title || ""),
      createNode("div", "masthead-subtitle", props.subtitle || ""),
      createNode("div", "masthead-meta", [props.date_label, props.meta_line].filter(Boolean).join(" · ")),
    );
    return node;
  }

  function renderTagRow(block) {
    const props = block.props || {};
    const node = createBlockShell(block);
    node.classList.add("tag-row", "tag-row--" + block.variant);
    (props.items || []).forEach(function (item) {
      const chip = createNode("div", "tag-chip", item.label || "");
      chip.dataset.tone = item.tone || "neutral";
      node.append(chip);
    });
    return node;
  }

  function renderSectionCard(block) {
    const props = block.props || {};
    const node = createBlockShell(block);
    node.classList.add("section-card", "block-paper", "section-card--" + block.variant);
    appendStandardHeader(node, props);
    if (props.intro) {
      node.append(createNode("p", "section-intro", props.intro));
    }
    if (Array.isArray(props.bullets) && props.bullets.length) {
      const list = createNode("ul", "section-list");
      props.bullets.forEach(function (item) {
        list.append(createNode("li", "", item));
      });
      node.append(list);
    }
    if (props.closing) {
      node.append(createNode("div", "section-closing", props.closing));
    }
    return node;
  }

  function renderBulletNote(block) {
    const props = block.props || {};
    const node = createBlockShell(block);
    node.classList.add("bullet-note", "block-paper", "bullet-note--" + block.variant);
    appendStandardHeader(node, props);
    const list = createNode("div", "note-list");
    (props.items || []).forEach(function (item) {
      const row = createNode("div", "note-list-item");
      row.append(createNode("div", "note-list-item-icon", item.icon || "•"));
      const body = createNode("div", "note-list-item-body");
      body.append(document.createTextNode(item.text || ""));
      if (item.emphasis) {
        body.append(document.createTextNode(" "));
        body.append(createNode("span", "note-list-item-emphasis", item.emphasis));
      }
      row.append(body);
      list.append(row);
    });
    node.append(list);
    return node;
  }

  function renderMetricStrip(block) {
    const props = block.props || {};
    const node = createBlockShell(block);
    node.classList.add("metric-strip", "block-paper", "metric-strip--" + block.variant);
    appendStandardHeader(node, props);
    if (props.summary) {
      node.append(createNode("p", "metric-summary", props.summary));
    }
    const grid = createNode("div", "metric-grid");
    (props.stats || []).forEach(function (stat) {
      const statNode = createNode("div", "metric-stat");
      statNode.append(
        createNode("span", "metric-stat-value", stat.value || ""),
        createNode("span", "metric-stat-label", stat.label || ""),
      );
      grid.append(statNode);
    });
    node.append(grid);
    if (Array.isArray(props.bullets) && props.bullets.length) {
      const list = createNode("ul", "metric-list");
      props.bullets.forEach(function (item) {
        list.append(createNode("li", "", item));
      });
      node.append(list);
    }
    if (props.closing) {
      node.append(createNode("div", "metric-closing", props.closing));
    }
    return node;
  }

  function renderQuoteStack(block) {
    const props = block.props || {};
    const node = createBlockShell(block);
    node.classList.add("quote-stack", "block-paper", "quote-stack--" + block.variant);
    appendStandardHeader(node, props);
    const list = createNode("div", "quote-list");
    (props.quotes || []).forEach(function (item) {
      const quote = createNode("div", "quote-item");
      quote.append(
        createNode("p", "quote-text", item.text || ""),
        createNode("div", "quote-source", item.source || ""),
      );
      list.append(quote);
    });
    node.append(list);
    return node;
  }

  function renderDivider(block) {
    const props = block.props || {};
    const node = createBlockShell(block);
    node.classList.add("divider", "divider--" + block.variant);
    node.append(createNode("div", "divider-rule"));
    if (props.label) {
      node.append(createNode("div", "divider-label", props.label));
    }
    node.append(createNode("div", "divider-rule"));
    return node;
  }

  function renderFooterMark(block) {
    const props = block.props || {};
    const node = createBlockShell(block);
    node.classList.add("footer-mark", "footer-mark--" + block.variant, "block-paper");
    const parts = createNode("div", "footer-parts");
    [props.left, props.center, props.right].filter(Boolean).forEach(function (part) {
      parts.append(createNode("span", "", part));
    });
    node.append(parts);
    node.append(createNode("div", "footer-author", "Generated by LobsterAI"));
    return node;
  }

  function renderStatBand(block) {
    const props = block.props || {};
    const node = createBlockShell(block);
    node.classList.add("stat-band", "stat-band--" + block.variant, "block-paper");
    const grid = createNode("div", "stat-band-grid");
    (props.items || []).forEach(function (item) {
      const card = createNode("div", "stat-band-item");
      card.append(
        createNode("span", "stat-band-value", item.value || ""),
        createNode("span", "stat-band-label", item.label || ""),
      );
      grid.append(card);
    });
    node.append(grid);
    return node;
  }

  function renderTimelineCard(block) {
    const props = block.props || {};
    const node = createBlockShell(block);
    node.classList.add("timeline-card", "timeline-card--" + block.variant, "block-paper");
    appendStandardHeader(node, props);
    const list = createNode("div", "timeline-list");
    (props.steps || []).forEach(function (step) {
      const row = createNode("div", "timeline-step");
      row.append(createNode("div", "timeline-step-label", step.label || ""));
      const body = createNode("div", "timeline-step-body");
      body.append(
        createNode("div", "timeline-step-heading", step.heading || ""),
        createNode("div", "timeline-step-detail", step.detail || ""),
      );
      row.append(body);
      list.append(row);
    });
    node.append(list);
    if (props.closing) {
      node.append(createNode("div", "section-closing", props.closing));
    }
    return node;
  }

  function renderCalloutQuote(block) {
    const props = block.props || {};
    const node = createBlockShell(block);
    node.classList.add("callout-quote", "callout-quote--" + block.variant, "block-paper");
    const quote = createNode("p", "callout-quote-text", props.quote || "");
    const source = createNode("div", "callout-quote-source", props.source || "");
    node.append(quote, source);
    return node;
  }

  function renderChecklistCard(block) {
    const props = block.props || {};
    const node = createBlockShell(block);
    node.classList.add("checklist-card", "checklist-card--" + block.variant, "block-paper");
    appendStandardHeader(node, props);
    const list = createNode("div", "checklist-list");
    (props.items || []).forEach(function (item) {
      const row = createNode("div", "checklist-item");
      row.append(createNode("div", "checklist-mark", item.checked ? "☑" : "☐"));
      row.append(createNode("div", "checklist-text", item.text || ""));
      list.append(row);
    });
    node.append(list);
    return node;
  }

  function renderComparisonCard(block) {
    const props = block.props || {};
    const node = createBlockShell(block);
    node.classList.add("comparison-card", "comparison-card--" + block.variant, "block-paper");
    appendStandardHeader(node, props);
    const grid = createNode("div", "comparison-grid");
    [props.left, props.right].forEach(function (side, index) {
      const panel = createNode("div", "comparison-panel");
      panel.dataset.side = index === 0 ? "left" : "right";
      panel.append(createNode("div", "comparison-panel-title", side && side.title || ""));
      const list = createNode("ul", "comparison-panel-list");
      ((side && side.items) || []).forEach(function (item) {
        list.append(createNode("li", "", item));
      });
      panel.append(list);
      grid.append(panel);
    });
    node.append(grid);
    return node;
  }

  function renderCodeCard(block) {
    const props = block.props || {};
    const node = createBlockShell(block);
    node.classList.add("code-card", "code-card--" + block.variant, "block-paper");
    appendStandardHeader(node, props);
    if (props.language) {
      node.append(createNode("div", "code-language", props.language));
    }
    node.append(createNode("pre", "code-block", props.code || ""));
    return node;
  }

  function renderNewsStream(block) {
    const props = block.props || {};
    const node = createBlockShell(block);
    node.classList.add("news-stream", "news-stream--" + block.variant);
    node.append(createNode("h2", "news-stream-title", props.title || ""));
    (props.items || []).forEach(function (item) {
      const article = createNode("article", "news-stream-item");
      article.append(createNode("div", "news-item-tag", item.tag || ""));
      article.append(createNode("h3", "news-item-heading", item.heading || ""));
      article.append(createNode("p", "news-item-summary", item.summary || ""));
      if (item.quote) {
        const quote = createNode("div", "news-item-quote");
        quote.append(
          createNode("div", "news-item-quote-text", item.quote),
          createNode("div", "news-item-quote-source", item.quote_source || ""),
        );
        article.append(quote);
      }
      node.append(article);
    });
    return node;
  }

  function renderTipBox(block) {
    const props = block.props || {};
    const node = createBlockShell(block);
    node.classList.add("tip-box", "tip-box--" + block.variant, "block-paper");
    appendStandardHeader(node, props);
    const list = createNode("div", "tip-list");
    (props.items || []).forEach(function (item) {
      const row = createNode("div", "tip-item");
      row.append(
        createNode("div", "tip-item-label", item.label || ""),
        createNode("div", "tip-item-text", item.text || ""),
      );
      list.append(row);
    });
    node.append(list);
    if (props.closing) {
      node.append(createNode("div", "section-closing", props.closing));
    }
    return node;
  }

  function renderBlock(block) {
    const registry = {
      masthead: renderMasthead,
      "tag-row": renderTagRow,
      "section-card": renderSectionCard,
      "bullet-note": renderBulletNote,
      "metric-strip": renderMetricStrip,
      "quote-stack": renderQuoteStack,
      divider: renderDivider,
      "footer-mark": renderFooterMark,
      "stat-band": renderStatBand,
      "timeline-card": renderTimelineCard,
      "callout-quote": renderCalloutQuote,
      "checklist-card": renderChecklistCard,
      "comparison-card": renderComparisonCard,
      "code-card": renderCodeCard,
      "news-stream": renderNewsStream,
      "tip-box": renderTipBox,
    };
    const renderer = registry[block.type];
    if (!renderer) {
      const fallback = createBlockShell(block);
      fallback.append(createNode("pre", "", JSON.stringify(block, null, 2)));
      return fallback;
    }
    return renderer(block);
  }

  function applyLayout(layout) {
    const root = document.querySelector(".report-root");
    document.body.dataset.layoutFreedom = resolveLayoutFreedom(layout);
    if (layout && layout.canvas_width) {
      root.style.width = "min(" + layout.canvas_width + "px, calc(100% - 40px))";
    }
  }

  function renderReport() {
    const data = readReportData();
    document.title = (data.meta && data.meta.title) || "Block Clipping Brief";
    applyTheme(data.theme || {});
    applyLayout(data.layout || {});

    const root = document.getElementById("report-root");
    normalizeBlocks(data.blocks, data.layout || {}, data.theme || {}).forEach(function (block) {
      root.append(renderBlock(block));
    });
  }

  renderReport();
})();
